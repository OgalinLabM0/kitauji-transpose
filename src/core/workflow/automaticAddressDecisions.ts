import { bindAutomaticSources } from './automaticKnowledgeSources';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ProjectStore } from '@core/db';
import { fromJson, nowIso } from '@core/db';
import type { AiClient, ProtocolResult } from '@core/ai';
import { beginKnowledgeDecision, finishKnowledgeDecision } from './knowledgeDecisionJournal';
import { ADDRESS_EVIDENCE_PROMPT } from '../ai/prompts/addressEvidencePrompt';
import { containsVisibleQuote, visibleNameSource } from '../validation/nameEvidence';

const payload = z.object({ speakerCharId: z.string(), targetCharId: z.string(), sourceFormJp: z.string().min(1), candidates: z.array(z.object({ zh: z.string().min(1) })).min(1).optional() });
const verdict = z.object({ decision: z.enum(['supported', 'uncertain', 'rejected']), quote: z.string(), reason: z.string().trim().min(1) }).strict();
const suffixes: Record<string, string> = { '君': '君', 'くん': '君', 'ちゃん': '酱', 'さん': '桑' };
const reportedTitles: Record<string, string> = { '先輩': '前辈', 'せんぱい': '前辈' };

/** Only an entire affirmative naming sentence qualifies; negation, hearsay and quoted reports do not. */
function reportedAddress(source: string, speaker: string, target: string, form: string): string | null {
  source = visibleNameSource(source);
  const assertion = `${speaker}は${target}を「${form}」と呼ぶ`;
  const matches = source.split(/[。\r\n]/).map(s => s.trim()).filter(s => s === assertion);
  if (matches.length !== 1) return null;
  const before = source.slice(0, source.indexOf(assertion));
  const nesting = [...before].reduce((depth, c) => depth + (c === '「' || c === '『' ? 1 : c === '」' || c === '』' ? -1 : 0), 0);
  return nesting === 0 ? assertion : null;
}

export async function resolveAddressProposals(store: ProjectStore, ai: AiClient, volumeId: string, signal?: AbortSignal): Promise<number> {
  const seriesId = store.projects.getVolumeSeriesId(volumeId);
  const ids = new Set(store.projects.listParagraphIdsByVolume(volumeId));
  let adopted = 0;
  for (const q of store.translations.listQueue(seriesId).filter(q => q.kind === 'honorific-first' && q.paragraphId && ids.has(q.paragraphId))) {
    signal?.throwIfAborted();
    const prepare = () => {
      const item = store.translations.getQueueItem(q.id);
      if (!item || item.status !== 'pending' || item.payload.knowledgeDecision || item.payload.autoSuppressed) return null;
      const parsed = payload.safeParse(item.payload); if (!parsed.success) return null;
      const p = parsed.data, paragraph = store.projects.getParagraph(q.paragraphId!);
      if (item.payload.items!==undefined && (!Array.isArray(item.payload.items) || item.payload.items.some(row=>!row || row.paragraphId!==q.paragraphId || row.sourceFormJp!==p.sourceFormJp || row.speakerCharId!==p.speakerCharId || row.targetCharId!==p.targetCharId))) return null;
      const settings = store.projects.getSettings(seriesId);
      if (settings['honorific.default_style'] !== 'loan') return null;
      const speaker = store.knowledge.getCharacter(p.speakerCharId), target = store.knowledge.getCharacter(p.targetCharId);
      if (!paragraph || !speaker || !target || speaker.id === target.id || speaker.series_id !== seriesId || target.series_id !== seriesId || !speaker.is_active || !target.is_active) return null;
      const analysis = store.projects.currentAnalysis(paragraph.id);
      const reportQuote = reportedAddress(paragraph.sourceText, speaker.canonical_name_jp, target.canonical_name_jp, p.sourceFormJp);
      const direct = !!store.projects.sceneObservation(paragraph.id) && analysis?.speaker_char_id === speaker.id && fromJson<string[]>(analysis.target_char_ids, []).includes(target.id);
      if (!reportQuote && !direct) return null;
      if (!store.knowledge.nameCurrent(speaker, paragraph.seriesOrdinal) || !store.knowledge.nameCurrent(target, paragraph.seriesOrdinal)) return null;
      const term = store.glossary.activeTerms(seriesId).find(t => t.term_jp === target.canonical_name_jp && t.term_zh && t.lock_level !== 'suggested');
      if (!term || !target.canonical_name_zh || term.term_zh !== target.canonical_name_zh) return null;
      const speakerTerm = reportQuote ? store.glossary.activeTerms(seriesId).find(t => t.term_jp === speaker.canonical_name_jp && t.term_zh === speaker.canonical_name_zh && t.lock_level !== 'suggested') : undefined;
      if (reportQuote && !speakerTerm) return null;
      if (reportQuote && [speaker, target].some(person => store.knowledge.listCharacters(seriesId).filter(c => c.is_active && c.canonical_name_jp === person.canonical_name_jp && store.knowledge.nameCurrent(c, paragraph.seriesOrdinal)).length !== 1)) return null;
      const suffix = p.sourceFormJp.slice(target.canonical_name_jp.length);
      const named = p.sourceFormJp.startsWith(target.canonical_name_jp) && (!suffix || !!suffixes[suffix]);
      const title = reportQuote ? reportedTitles[p.sourceFormJp] : undefined;
      if (!named && !title) return null;
      if (!p.candidates && !suffix && !title) return null;
      const zh = title ?? target.canonical_name_zh + (suffixes[suffix] ?? '');
      const visibleSource = visibleNameSource(paragraph.sourceText);
      if ((p.candidates && !p.candidates.some(c => c.zh === zh)) || !visibleSource.includes(p.sourceFormJp)) return null;
      // Existing or future stages require a separate change decision, never a first-use shortcut.
      if (store.db.get('SELECT id FROM address_trajectories WHERE series_id=? AND speaker_char_id=? AND target_char_id=? AND source_form_jp=?', [seriesId, speaker.id, target.id, p.sourceFormJp])) return null;
      const input = { source: paragraph.sourceText, speaker: speaker.canonical_name_jp, target: target.canonical_name_jp, source_form: p.sourceFormJp, zh, evidence_mode: reportQuote ? 'reported-address' : 'direct-address', assertion: reportQuote };
      if (input.source.length > 6000) return null;
      const hash = createHash('sha256').update(JSON.stringify([ADDRESS_EVIDENCE_PROMPT, input, reportQuote ? null : analysis, speaker, target, term, speakerTerm, p.candidates, item.payload.items, settings, paragraph.seriesOrdinal])).digest('hex');
      return { item, p, paragraph, input, hash, reportQuote };
    };
    const start = prepare(); if (!start) continue;
    if ((start.item.payload.addressEvidence as { inputHash?: string } | undefined)?.inputHash === start.hash) continue;
    try {
      const review = await ai.structured({ workstation: 'address-evidence-reviewer', paragraphId: q.paragraphId!, user: JSON.stringify({ ...start.input, source: visibleNameSource(start.input.source) }), parseRetries: 1, ...(signal ? { signal } : {}) }, (text): ProtocolResult<z.infer<typeof verdict>> => {
        try {
          const value = verdict.parse(JSON.parse(text));
          if (value.quote && !containsVisibleQuote(start.input.source, value.quote)) throw new Error('引文不属于原文');
          const quote = visibleNameSource(value.quote);
          if (value.decision === 'supported' && (!quote.trim() || !quote.includes(start.input.source_form))) throw new Error('缺少称谓方向原文证据');
          if (value.decision === 'supported' && start.reportQuote && !quote.includes(start.reportQuote)) throw new Error('引文必须包含完整的称呼方向断言');
          return { ok: true, value };
        } catch (e) { return { ok: false, error: { code: 'INVALID_SHAPE', message: (e as Error).message } }; }
      });
      signal?.throwIfAborted();
      const current = prepare(); if (!current || current.hash !== start.hash) continue;
      store.transaction(() => {
        store.translations.updateQueuePayload(q.id, { ...current.item.payload, ...(!current.p.candidates && review.value.decision === 'supported' ? { candidates: [{ zh: current.input.zh, rationale: '按已确认姓名与固定称呼形式保留' }] } : {}), addressEvidence: { ...review.value, inputHash: start.hash, aiCallId: review.aiCallId, mode: current.input.evidence_mode } });
        if (review.value.decision !== 'supported') return;
        const journal = beginKnowledgeDecision(store, q.id); if (!journal) throw new Error('无法记录自动称谓撤销');
        const addressId = store.knowledge.addAddress({ seriesId, speakerCharId: current.p.speakerCharId, targetCharId: current.p.targetCharId, sourceFormJp: current.p.sourceFormJp, translatedForm: current.input.zh, validFromPara: current.paragraph.seriesOrdinal, confirmedByUser: false, evidenceIds: [current.paragraph.id] });
        store.translations.updateQueuePayload(q.id, { ...store.translations.getQueueItem(q.id)!.payload, automaticAddressDecision: { addressId, aiCallId: review.aiCallId, at: nowIso() } });
        store.translations.resolveQueueItem(q.id, JSON.stringify({ action: 'automatic-evidenced-address', addressId }));
        for (const p of store.projects.translatedParagraphsContaining(seriesId, current.p.sourceFormJp)) {
          const paragraph = store.projects.getParagraph(p.id)!;
          if (paragraph.seriesOrdinal < current.paragraph.seriesOrdinal) continue;
          const analysis = store.projects.currentAnalysis(p.id);
          if (analysis?.speaker_char_id && analysis.speaker_char_id !== current.p.speakerCharId) continue;
          store.translations.addRecheck(p.id, 'automatic-address-decision', `称谓「${current.p.sourceFormJp}」自动采用“${current.input.zh}”，需复核方向与阶段`);
        }
        bindAutomaticSources(store, q.id, [current.paragraph.id], !current.reportQuote);
        finishKnowledgeDecision(store, q.id, journal);
        adopted++;
      });
    } catch (e) { if (signal?.aborted) throw e; store.translations.log({ level: 'warning', paragraphId: q.paragraphId, workstationId: 'address-evidence-reviewer', message: `称谓自动核对失败，保留候选：${(e as Error).message}` }); }
  }
  return adopted;
}
