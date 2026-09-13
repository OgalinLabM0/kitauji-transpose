import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { ProjectStore } from '@core/db';
import { nowIso } from '@core/db';
import type { AiClient, ProtocolResult } from '@core/ai';
import { TERM_EVIDENCE_PROMPT } from '../ai/prompts/termEvidencePrompt';
import { termBackground } from './termBackground';

import { legacyTermsAwaitingUser, termReviewMatcher } from './termConfirmation';
import { containsVisibleQuote, visibleNameSource } from '../validation/nameEvidence';
function reopenLegacyAutomaticTerms(store: ProjectStore, seriesId: string, volumeId: string): void {
  const matches = termReviewMatcher(store, volumeId);
  store.transaction(() => {
    for (const item of legacyTermsAwaitingUser(store, seriesId)) {
      if (!matches(item)) continue;
      const row = store.translations.getQueueItem(item.id)!;
      const receipt = store.db.get<{resolution:string|null;resolved_at:string|null}>('SELECT resolution,resolved_at FROM review_queue WHERE id=?',[item.id])!;
      const next = { ...row.payload, legacyAutomaticResolution: receipt.resolution,
        legacyAutomaticReviewSnapshot: { resolution: receipt.resolution, resolvedAt: receipt.resolved_at, payload: row.payload },
        preSelected: (row.payload.automaticTermDecision as { zh: string }).zh,
        preSelectedBasis: '历史自动采用，须用户确认', legacyAutomaticTermReview: true };
      store.db.run("UPDATE review_queue SET status='pending',resolution=NULL,resolved_at=NULL,payload=? WHERE id=?", [JSON.stringify(next), item.id]);
    }
  });
}

const payloadSchema = z.object({ termId: z.string(), termJp: z.string().min(1), candidates: z.array(z.object({ zh: z.string().trim().min(1) })).min(1).max(6), examples: z.array(z.object({ id: z.string(), text: z.string().min(1) })).min(1).max(8), proposalBackground: z.array(z.object({ id: z.string().min(1), source: z.string().min(1).refine(value => !!value.trim()) }).strict()).max(6).optional() });
const reviewSchema = z.object({ decision: z.enum(['choose', 'uncertain', 'reject']), zh: z.string(), reason: z.string().trim().min(1), evidence: z.array(z.object({ id: z.string(), quote: z.string().trim().min(1) }).strict()) }).strict();
type EvidenceInput = { term: string; category: string; candidates: string[]; examples: { id: string; text: string }[]; background?: ReturnType<typeof termBackground> };
export function parseTermEvidence(text: string, input: EvidenceInput): ProtocolResult<z.infer<typeof reviewSchema>> {
  try {
    const value = reviewSchema.parse(JSON.parse(text));
    if (value.decision === 'choose' ? !input.candidates.includes(value.zh) || !value.evidence.length : !!value.zh) throw new Error('选择须来自现有候选，未选择不得填写译名');
    if (new Set(value.evidence.map(e => e.id)).size !== value.evidence.length || value.evidence.some(e => !containsVisibleQuote(e.quote, input.term) || !input.examples.some(p => p.id === e.id && containsVisibleQuote(p.text, e.quote)))) throw new Error('术语审核引文不属于当前原文');
    return { ok: true, value };
  } catch (error) { return { ok: false, error: { code: 'INVALID_SHAPE', message: (error as Error).message } }; }
}

export async function resolveTermProposals(store: ProjectStore, ai: AiClient, volumeId: string, signal?: AbortSignal): Promise<number> {
  const seriesId = store.projects.getVolumeSeriesId(volumeId);
  const volumeIds = new Set(store.projects.listParagraphIdsByVolume(volumeId));
  signal?.throwIfAborted();
  reopenLegacyAutomaticTerms(store, seriesId, volumeId);
  let adopted = 0;
  for (const q of store.translations.listQueue(seriesId).filter(q => q.kind === 'term-proposal' && q.paragraphId && volumeIds.has(q.paragraphId))) {
    signal?.throwIfAborted();
    const prepare = () => {
      const item = store.translations.getQueueItem(q.id);
      if (!item || item.status !== 'pending' || item.payload.knowledgeDecision || item.payload.autoSuppressed) return null;
      const parsed = payloadSchema.safeParse(item.payload); if (!parsed.success) return null;
      const p = parsed.data;
      const terms = store.glossary.activeTerms(seriesId);
      const term = terms.find(t => t.id === p.termId);
      if (!term || term.term_jp !== p.termJp || term.term_zh || term.lock_level !== 'suggested' || term.senses.length || terms.filter(t => t.term_jp === term.term_jp).length !== 1) return null;
      const character = store.knowledge.findByName(seriesId, term.term_jp);
      if (character?.locked_by_user || character?.canonical_name_zh) return null;
      if (p.examples.some(e => !volumeIds.has(e.id) || store.projects.getParagraph(e.id)?.sourceText !== e.text || !containsVisibleQuote(e.text, p.termJp))) return null;
      let background = termBackground(store,p.examples.map(e=>e.id));
      if (p.proposalBackground !== undefined) {
        // New proposals preserve the exact retrieval used to generate candidates.
        // Verify every snapshot against live source before sending it; never trust
        // a payload's text, series, or claimed identity as independent evidence.
        if (new Set(p.proposalBackground.map(e => e.id)).size !== p.proposalBackground.length
          || p.proposalBackground.reduce((n, e) => n + e.source.length, 0) > 3000) return null;
        background = [];
        for (const e of p.proposalBackground) {
          const source = store.projects.getParagraph(e.id);
          if (!source || !volumeIds.has(e.id) || store.projects.getSeriesIdOfParagraph(e.id) !== seriesId
            || visibleNameSource(source.sourceText) !== e.source || p.examples.some(example => example.id === e.id)) return null;
          background.push({ id: e.id, text: visibleNameSource(source.sourceText), ordinal: source.seriesOrdinal,
            chapterId: source.chapterId, seriesId, type: source.paragraphType });
        }
      }
      const input: EvidenceInput = { term: p.termJp, category: term.term_type, candidates: [...new Set(p.candidates.map(c => c.zh))], examples: p.examples.map(e => ({ id: e.id, text: visibleNameSource(e.text) })), background };
      if (JSON.stringify(input).length > 9000) return null;
      const hash = createHash('sha256').update(JSON.stringify([TERM_EVIDENCE_PROMPT, input, term, character])).digest('hex');
      return { item, term, input, hash };
    };
    const start = prepare(); if (!start) continue;
    const previous = start.item.payload.termEvidence as { inputHash?: string } | undefined;
    if (previous?.inputHash === start.hash) continue;
    try {
      const reviewed = await ai.structured({ workstation: 'term-evidence-reviewer', paragraphId: q.paragraphId!, user: JSON.stringify(start.input), parseRetries: 1, ...(signal ? { signal } : {}) }, text => parseTermEvidence(text, start.input));
      signal?.throwIfAborted();
      const current = prepare(); if (!current || current.hash !== start.hash) continue;
      store.transaction(() => {
        const receipt = { ...reviewed.value, inputHash: start.hash, aiCallId: reviewed.aiCallId, at: nowIso() };
        store.translations.updateQueuePayload(q.id, { ...current.item.payload, termEvidence: receipt });
        if (reviewed.value.decision !== 'choose') return;
        store.translations.updateQueuePayload(q.id, { ...store.translations.getQueueItem(q.id)!.payload, preSelected: reviewed.value.zh, preSelectedBasis: 'AI 证据建议，须用户确认', termEvidence: receipt });
        return;
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      store.translations.log({ level: 'warning', workstationId: 'term-evidence-reviewer', paragraphId: q.paragraphId, message: `术语自动核对未完成，保留待复核：${(error as Error).message}` });
    }
  }
  return adopted;
}
