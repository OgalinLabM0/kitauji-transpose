/**
 * flags 路由（docs/设计/REVIEW_ROUTING.md 第 4 节）：把初译/编辑输出的 flags 写入对应表，并决定哪些进入人工队列。
 * 返回值告诉流水线：本段是否“必须人工”（不可自动确认）。
 */
import type { ProjectStore } from '@core/db';
import { resolveEntityNameBidirectional, HONORIFIC_SUFFIX_RE } from '@core/db';
import type { TranslationFlag, ReviewKind } from '@shared/types';
import type { GlossaryHitDetail } from '@core/glossary/hits';
import { literalAddressFlagCovered } from './paragraphLiteralAddresses';

export interface RouteInput {
  seriesId: string; paragraphId: string; seriesOrdinal: number; sourceText: string; translation: string;
  flags: readonly TranslationFlag[]; glossaryHits: readonly GlossaryHitDetail[];
  speakerCharId: string | null;
}
export interface RouteResult { mustReview: boolean; enqueued: ReviewKind[]; deviationWarnings: number }

const DEVIATION_HUMAN_TYPES = new Set(['person', 'organization']);

export function routeFlags(store: ProjectStore, i: RouteInput): RouteResult {
  return store.transaction(() => routeFlagsInTransaction(store, i));
}

function routeFlagsInTransaction(store: ProjectStore, i: RouteInput): RouteResult {
  const enqueued: ReviewKind[] = []; let mustReview = false; let deviationWarnings = 0;
  const q = (kind: ReviewKind, title: string, payload: Record<string, unknown>, groupKey?: string | null, human = true): void => {
    store.translations.enqueue({ seriesId: i.seriesId, kind, paragraphId: i.paragraphId, groupKey: groupKey ?? null, title, payload: { ...payload, seriesOrdinal: i.seriesOrdinal, source: i.sourceText, translation: i.translation } });
    enqueued.push(kind); if (human) mustReview = true;
  };
  const hitByJp = new Map(i.glossaryHits.map(h => [h.termJp, h]));
  const handledTerms = new Set<string>();

  // 标记未能保存时拒绝定稿，由调用方报告失败；不得将丢失的知识问题当成通过。
  const validCharId = (id: string | null | undefined): string | null => (id && store.knowledge.getCharacter(id)?.series_id === i.seriesId ? id : null);
  for (const f of i.flags) {
    try { routeOne(f); }
    catch (e) { throw new Error(`标记处理失败 [${f.type}]，本段未定稿：${(e as Error).message}`, { cause: e }); }
  }
  // 单条 flag 的路由（声明提升，可在上面的循环里调用）
  function routeOne(f: TranslationFlag): void {
    switch (f.type) {
      case 'glossary-deviation': {
        const h = hitByJp.get(f.term); if (!h) break;
        handledTerms.add(f.term);
        if (h.lockLevel === 'hard-locked') break; // 程序校验层已按硬锁定处理
        const occ = store.glossary.recordOccurrence({ termId: h.termId, paragraphId: i.paragraphId, occurrenceText: f.term, appliedZh: f.used_zh, confidence: f.confidence, deviationStatus: 'flagged', rationale: f.rationale, flagged: true });
        const human = f.confidence < 0.85 || DEVIATION_HUMAN_TYPES.has(h.termType);
        q('glossary-deviation', `「${f.term}」术语表=${f.glossary_zh}，此处译“${f.used_zh}”（${f.confidence.toFixed(2)}）`, { occurrenceId: occ, termId: h.termId, termJp: f.term, glossaryZh: f.glossary_zh, usedZh: f.used_zh, rationale: f.rationale, confidence: f.confidence }, null, human);
        if (!human) deviationWarnings++;
        break;
      }
      case 'glossary-conflict': {
        const h = hitByJp.get(f.term); if (!h) break;
        handledTerms.add(f.term);
        const occ = store.glossary.recordOccurrence({ termId: h.termId, paragraphId: i.paragraphId, occurrenceText: f.term, appliedZh: f.glossary_zh, deviationStatus: 'conflict', rationale: f.rationale, flagged: true });
        q('lock-conflict', `模型对硬锁定「${f.term}」→“${f.glossary_zh}”提出异议：认为应为“${f.believed_zh}”`, { occurrenceId: occ, termId: h.termId, termJp: f.term, glossaryZh: f.glossary_zh, believedZh: f.believed_zh, rationale: f.rationale });
        break;
      }
      case 'glossary-sense': {
        const h = hitByJp.get(f.term); if (!h) break;
        handledTerms.add(f.term);
        const sense = f.sense_id ? h.senseDetails.find(s => s.id === f.sense_id) : h.senseDetails.find(s => f.used_zh && s.zh === f.used_zh);
        store.glossary.recordOccurrence({ termId: h.termId, paragraphId: i.paragraphId, occurrenceText: f.term, appliedSenseId: sense?.id ?? null, appliedZh: sense?.zh ?? f.used_zh ?? null, confidence: f.confidence, deviationStatus: sense && !sense.isDefault ? 'sense-selected' : 'none' });
        if (f.confidence < 0.85) q('ambiguity', `「${f.term}」义项选择置信度 ${f.confidence.toFixed(2)}：${sense?.zh ?? f.used_zh ?? '?'}`, { termId: h.termId, termJp: f.term, usedZh: sense?.zh ?? f.used_zh, confidence: f.confidence, candidates: h.senseDetails.map(s => s.zh) });
        break;
      }
      case 'katakana-ambiguity': {
        const existing = store.glossary.findTermByJp(i.seriesId, f.term);
        const human = f.confidence < 0.85;
        if (existing) {
          store.glossary.recordOccurrence({ termId: existing.id, paragraphId: i.paragraphId, occurrenceText: f.term, appliedZh: f.inferred, confidence: f.confidence, isAmbiguous: true, flagged: human });
        }
        if (human) q('ambiguity', `「${f.term}」推断为“${f.inferred}”（${f.confidence.toFixed(2)}）`, { termJp: f.term, inferred: f.inferred, confidence: f.confidence, evidence: f.evidence ?? '', termId: existing?.id ?? null }, `ambiguity:${f.term}`);
        break;
      }
      case 'wordplay': {
        const prior = store.translations.findWordplay(i.seriesId, f.original, f.variant);
        if (prior?.confirmed_by_user) break; // 已决定，L7 已注入，无需再问
        const id = prior?.id ?? store.translations.addWordplay({ seriesId: i.seriesId, paragraphId: i.paragraphId, wordplayType: 'homophone', original: f.original, variant: f.variant, meaning: f.meaning, proposedZh: f.proposal, rationale: f.rationale, confidence: f.confidence });
        q('wordplay', `「${f.variant}」（原音「${f.original}」=${f.meaning}）→ ${f.proposal ? `建议“${f.proposal}”` : '需要译者决定'}（${f.confidence.toFixed(2)}）`, { wordplayId: id, original: f.original, variant: f.variant, meaning: f.meaning, proposal: f.proposal, rationale: f.rationale, confidence: f.confidence, quick: f.confidence >= 0.8 }, `wordplay:${f.original}:${f.variant}`);
        break;
      }
      case 'quirk-candidate': {
        // AI 回传的 character_id 可能是幻觉 id、character_name 可能是中文名：一律校验/双向解析；场景分析的说话人最可靠
        const validId = (id: string | null | undefined): string | null => (id && store.knowledge.getCharacter(id)?.series_id === i.seriesId ? id : null);
        const byName = (n: string | null | undefined): string | null => { if (!n) return null; const r = resolveEntityNameBidirectional(store, i.seriesId, n, i.seriesOrdinal); return r.kind === 'character' && r.id && store.knowledge.getCharacter(r.id) ? r.id : null; };
        const charId = validId(i.speakerCharId) ?? validId(f.character_id) ?? byName(f.character_name);
        const trigger = f.trigger_form.replace(/^[〜～~…‥「」\s]+|[「」\s]+$/g, '').trim();
        if (!trigger) break;
        // 已锁定或已否定的语癖不再提
        if (charId && store.knowledge.quirks(charId).some(x => x.trigger_form === trigger && x.locked_at_para <= i.seriesOrdinal && (x.confirmed_by_user || x.automatically_adopted || x.quirk_type === 'rejected'))) break;
        const ch = charId ? store.knowledge.getCharacter(charId) : undefined;
        const name = ch ? (ch.canonical_name_zh ?? ch.canonical_name_jp) : (f.character_name ?? '说话人未知');
        q('quirk-candidate', `${name} 的「${trigger}」疑似语癖 → “${f.proposed_pattern}”（信号：${f.signal}）`, { characterId: charId, characterName: name, triggerForm: trigger, proposedPattern: f.proposed_pattern, signal: f.signal }, `quirk:${charId ?? name}:${trigger}`);
        break;
      }
      case 'honorific-first': {
        if(literalAddressFlagCovered(store,i.paragraphId,i.sourceText,i.translation,f.source_form_jp,f.used_zh)) break;
        const validId = (id: string | null | undefined): string | null => (id && store.knowledge.getCharacter(id)?.series_id === i.seriesId ? id : null);
        const byName = (n: string | null | undefined): string | null => { if (!n) return null; const r = resolveEntityNameBidirectional(store, i.seriesId, n, i.seriesOrdinal); if (r.kind === 'character' && r.id && store.knowledge.getCharacter(r.id)) return r.id; const rv = store.knowledge.resolveNameVariant(i.seriesId, n, i.seriesOrdinal); return rv.id; };
        // 说话人：场景分析 > AI 给的有效 id > 按名字（日/中）解析；受话人：称呼形本身的名字部分最可靠（「久美子ちゃん」→ 久美子）
        const speaker = validId(i.speakerCharId) ?? validId(f.speaker_char_id) ?? byName(f.speaker_name);
        const formBase = f.source_form_jp.replace(HONORIFIC_SUFFIX_RE, '');
        const target = byName(formBase) ?? validId(f.target_char_id) ?? byName(f.target_name);
        if (speaker && target && speaker === target) break; // 自称不是称呼
        if (speaker && target && store.knowledge.isAddressAdopted(store.knowledge.activeAddress(i.seriesId, speaker, target, f.source_form_jp, i.seriesOrdinal))) break;
        const nm = (id: string | null, fb?: string): string => id ? (store.knowledge.getCharacter(id)?.canonical_name_zh ?? store.knowledge.getCharacter(id)?.canonical_name_jp ?? id) : (fb ?? 'unknown');
        q('honorific-first', `${nm(speaker, f.speaker_name)} → ${nm(target, f.target_name)}：「${f.source_form_jp}」${f.used_zh ? `（初译“${f.used_zh}”）` : ''}`, { speakerCharId: speaker, targetCharId: target, speakerName: nm(speaker, f.speaker_name), targetName: nm(target, f.target_name), sourceFormJp: f.source_form_jp, usedZh: f.used_zh ?? null }, `honorific:${speaker ?? f.speaker_name}:${target ?? f.target_name}:${f.source_form_jp}`);
        break;
      }
      case 'first-person-shift': {
        const charId = validCharId(i.speakerCharId) ?? validCharId(f.character_id);
        if (charId) store.knowledge.addState({ characterId: charId, stateType: 'first-person-shift', description: `一人称 ${f.from}→${f.to}`, validFromPara: i.seriesOrdinal, evidenceIds: [i.paragraphId] });
        store.translations.log({ level: 'info', paragraphId: i.paragraphId, message: `人称转变 ${f.from}→${f.to}${charId ? '' : '（说话人未知）'}` });
        break;
      }
      case 'logic-conflict':
        q('review-block', `模型报告逻辑冲突：${f.note}`, { note: f.note });
        break;
    }
  }
  // 未被 flags 覆盖的术语命中：按默认义记录
  for (const h of i.glossaryHits) {
    if (handledTerms.has(h.termJp)) continue;
    const def = h.senseDetails.find(s => s.isDefault);
    store.glossary.recordOccurrence({ termId: h.termId, paragraphId: i.paragraphId, occurrenceText: h.termJp, appliedSenseId: def?.id ?? null, appliedZh: h.termZh, deviationStatus: 'none' });
  }
  return { mustReview, enqueued, deviationWarnings };
}
