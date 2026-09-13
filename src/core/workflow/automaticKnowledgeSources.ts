import { containsVisibleQuote } from '../validation/nameEvidence';
import { activeProofReadMemo, identityReadScopeIsPristine, withIdentityRead } from '../db/identitySources';
import {fieldAttributionDismissalCurrent,reopenFieldAttributionDismissal} from './fieldAttributionReview';
import { createHash } from 'node:crypto';
import {characterInvalidationCurrent,reopenCharacterInvalidation} from './characterInvalidationReview';
import {relationshipTerminationCurrent,reopenRelationshipTermination} from './relationshipTerminationReview';
import { z } from 'zod';
import type { ProjectStore } from '@core/db';
import { nowIso } from '@core/db';
import { undoKnowledgeDecision } from './knowledgeDecisionJournal';
import { fieldDismissalCurrent, reopenFieldDismissal } from './fieldObservationDismissal';
import { ordinaryQuirkDismissalCurrent, reopenOrdinaryQuirkDismissal } from './ordinaryQuirkDismissal';
import { paragraphLiteralAddressCurrent, reopenParagraphLiteralAddress } from './paragraphLiteralAddresses';
import type { AutomaticSourceIssue } from '@shared/ipc';
import { termBackground } from './termBackground';

const receiptSchema = z.object({ version: z.literal(1), scene: z.boolean(), ids: z.array(z.string()).min(1), hash: z.string(), localAddress: z.boolean().optional(), termExampleIds:z.array(z.string()).min(1).optional() });
type AutomaticSourceReadCache = { stamp: string; bySeries: Map<string, readonly string[]> };
// The key is the proof memo installed by withIdentityRead, so this cache cannot
// outlive one synchronous, read-only caller scope.
const automaticSourceReadCaches = new WeakMap<Map<string, boolean>, AutomaticSourceReadCache>();
function sourceHash(store: ProjectStore, ids: string[], scene: boolean, localAddress = false, termExampleIds?:string[]): string {
  const sources=ids.map(id => {
    const p = store.projects.getParagraph(id);
    if (!p) return null;
    const a = scene ? store.projects.getAnalysis(id) : undefined;
    const seriesId = store.projects.getSeriesIdOfParagraph(id);
    return { id, series: seriesId, source: p.sourceText, ordinal: p.seriesOrdinal, chapter: p.chapterId, type: p.paragraphType,
      ...(localAddress ? { final: store.translations.latestFinal(id)?.final_text, settings: store.projects.getSettings(seriesId), terms: store.glossary.activeTerms(seriesId).filter(t=>t.term_type==='person' && containsVisibleQuote(p.sourceText, t.term_jp)).map(t=>[t.id,t.term_jp,t.term_zh,t.lock_level]) } : {}),
      ...(scene ? { observation: store.projects.sceneObservation(id), speaker: a?.speaker_char_id, targets: a?.target_char_ids, present: a?.present_char_ids, intent: a?.intent } : {}) };
  });
  return createHash('sha256').update(JSON.stringify(termExampleIds ? {sources,termBackground:termBackground(store,termExampleIds)} : sources)).digest('hex');
}

export function bindAutomaticSources(store: ProjectStore, queueId: string, ids: string[], scene: boolean, localAddress = false, termExampleIds?:string[]): void {
  const item = store.translations.getQueueItem(queueId)!;
  const unique = [...new Set(ids)];
  if (!unique.length || unique.some(id => !store.projects.getParagraph(id) || store.projects.getSeriesIdOfParagraph(id) !== item.series_id)) throw new Error('自动知识来源不属于当前作品');
  if(termExampleIds && (item.kind!=='term-proposal' || termExampleIds.some(id=>!unique.includes(id)))) throw new Error('术语背景例句不属于当前来源');
  store.translations.updateQueuePayload(queueId, { ...item.payload, automaticSources: { version: 1, scene, ids: unique, ...(localAddress ? {localAddress:true} : {}), ...(termExampleIds?{termExampleIds}:{}), hash: sourceHash(store, unique, scene, localAddress,termExampleIds) } });
}

function automaticSourceScan(store: ProjectStore, seriesId: string): string[] {
  return store.db.all<{ id: string; payload: string }>("SELECT id,payload FROM review_queue WHERE series_id=? AND status='resolved'", [seriesId]).filter(row => {
    const p = JSON.parse(row.payload);
    if(p.automaticRelationshipTerminationReview) return p.automaticRelationshipTerminationReview.undoneAt ? false : !relationshipTerminationCurrent(store,row.id);
    if(p.automaticCharacterInvalidationReview) return p.automaticCharacterInvalidationReview.undoneAt ? false : !characterInvalidationCurrent(store,row.id);
    if (p.automaticFieldAttributionDismissal) return !fieldAttributionDismissalCurrent(store,row.id);
    if (p.automaticFieldDismissal) return !fieldDismissalCurrent(store,row.id);
    if (p.automaticOrdinaryQuirkDismissal) return !ordinaryQuirkDismissalCurrent(store,row.id);
    if (p.automaticParagraphLiteralAddress) return !paragraphLiteralAddressCurrent(store,row.id);
    const journal = p.knowledgeDecision;
    if (journal?.undoneAt || journal?.invalidated) return false;
    const automatic = p.automaticTermDecision || p.automaticAddressDecision || p.automaticParagraphAddressDecision || p.automaticQuirkDecision || journal?.after?.quirks?.some((q: { automatically_adopted?: boolean }) => q.automatically_adopted);
    if (!automatic) return false;
    const receipt = receiptSchema.safeParse(p.automaticSources);
    return !receipt.success || receipt.data.hash !== sourceHash(store, receipt.data.ids, receipt.data.scene, receipt.data.localAddress,receipt.data.termExampleIds);
  }).map(row => row.id);
}

// total_changes catches this connection; data_version catches another connection.
// A changed stamp discards the scoped result before it can certify a later read.
function automaticSourceReadStamp(store: ProjectStore): string {
  return JSON.stringify(store.db.get('SELECT total_changes() AS n, data_version FROM pragma_data_version'));
}

/** Read-only: missing legacy receipts are unverified, never reconstructed as if previously checked. */
export function staleAutomaticSources(store: ProjectStore, seriesId: string): string[] {
  // Share the complete scan only while an outer synchronous reader is still
  // active. A write changes the scope stamp, clears proof reads, and disables
  // reuse for the rest of that scope (including a rolled-back transaction).
  return withIdentityRead(store.db, () => {
    const proofMemo = activeProofReadMemo(store.db);
    const cacheable = !!proofMemo && identityReadScopeIsPristine(store.db);
    if (!cacheable) return automaticSourceScan(store, seriesId);
    const before = automaticSourceReadStamp(store);
    let cache = automaticSourceReadCaches.get(proofMemo);
    if (!cache || cache.stamp !== before) {
      cache = { stamp: before, bySeries: new Map() };
      automaticSourceReadCaches.set(proofMemo, cache);
    }
    const cached = cache.bySeries.get(seriesId);
    if (cached) return [...cached];
    const stale = automaticSourceScan(store, seriesId);
    // Do not retain a result whose dependencies changed while it was read.
    if (identityReadScopeIsPristine(store.db) && automaticSourceReadStamp(store) === before) cache.bySeries.set(seriesId, stale);
    else return automaticSourceScan(store, seriesId);
    return [...stale];
  });
}

export function staleAutomaticSourceIssues(store: ProjectStore, seriesId: string): AutomaticSourceIssue[] {
  return staleAutomaticSources(store, seriesId).map(id => {
    const item = store.translations.getQueueItem(id)!;
    const receipt = receiptSchema.safeParse(item.payload.automaticSources);
    const field = !!(item.payload.automaticFieldDismissal || item.payload.automaticFieldAttributionDismissal);
    const ordinary = item.payload.automaticOrdinaryQuirkDismissal as {sourceIds?:string[]}|undefined;
    const ids = ordinary?.sourceIds ?? (field && Array.isArray(item.payload.sources) ? item.payload.sources.map((s: {id:string})=>s.id) : receipt.success ? receipt.data.ids : item.paragraph_id ? [item.paragraph_id] : []);
    const failure = item.payload.sourceRefreshFailure as { message?: string } | undefined;
    return { id, title: store.db.get<{ title: string }>('SELECT title FROM review_queue WHERE id=?', [id])!.title,
      kind: item.kind as AutomaticSourceIssue['kind'],
      reason: item.payload.automaticParagraphLiteralAddress ? '本段称呼的原文、姓名或设定依据已变化，需要重新核对。' : ordinary ? '称谓分类的原文或人物名字依据已变化，需要重新核对。' : field ? '人物观察的原文或档案依据已变化，旧自动结案需要重新核对。' : receipt.success ? '原文、位置或场景归属已变化，旧自动决定需要重新核对。' : '旧自动决定缺少可验证的来源凭证，需要重新核对。',
      recoveryError: typeof failure?.message === 'string' ? failure.message : null,
      sources: ids.map(id => { const p = store.projects.getParagraph(id); return { id, text: p?.sourceText ?? null, ordinal: p?.seriesOrdinal ?? null }; }),
    };
  });
}

/** Reopen only unchanged automatic decisions. Explicit user undo never enters this path. */
export function refreshAutomaticSources(store: ProjectStore, seriesId: string): { reopened: number; blocked: number } {
  let reopened = 0, blocked = 0;
  for (const id of staleAutomaticSources(store, seriesId)) {
    try {
      store.transaction(() => {
        if(store.translations.getQueueItem(id)?.payload.automaticFieldAttributionDismissal) { reopenFieldAttributionDismissal(store,id,false); return; }
        if(store.translations.getQueueItem(id)?.payload.automaticRelationshipTerminationReview) { reopenRelationshipTermination(store,id,false); return; }
        if(store.translations.getQueueItem(id)?.payload.automaticCharacterInvalidationReview) { reopenCharacterInvalidation(store,id,false); return; }
        if(store.translations.getQueueItem(id)?.payload.automaticParagraphLiteralAddress) { reopenParagraphLiteralAddress(store,id,false); return; }
        if (store.translations.getQueueItem(id)?.payload.automaticOrdinaryQuirkDismissal) { reopenOrdinaryQuirkDismissal(store,id,false); return; }
        if (store.translations.getQueueItem(id)?.payload.automaticFieldDismissal) {
          reopenFieldDismissal(store,id,false);
          return;
        }
        undoKnowledgeDecision(store, id);
        const item = store.translations.getQueueItem(id)!;
        const p = { ...item.payload };
        const history = Array.isArray(p.knowledgeDecisionHistory) ? p.knowledgeDecisionHistory : [];
        p.knowledgeDecisionHistory = [...history, p.knowledgeDecision];
        for (const key of ['knowledgeDecision', 'automaticSources', 'automaticTermDecision', 'automaticAddressDecision', 'automaticParagraphAddressDecision', 'automaticQuirkDecision', 'termEvidence', 'addressEvidence', 'quirkEvidence', 'sourceRefreshFailure']) delete p[key];
        if (item.kind === 'term-proposal' && Array.isArray(p.examples)) p.examples = p.examples.map((e: { id: string; text: string }) => ({ ...e, text: store.projects.getParagraph(e.id)?.sourceText ?? '' }));
        p.sourceRefresh = { at: nowIso(), reason: '原文或场景归属变化，旧自动决定已撤回，等待重新核对' };
        store.translations.updateQueuePayload(id, p);
      });
      reopened++;
    } catch (error) {
      blocked++;
      const item = store.translations.getQueueItem(id);
      if (item) store.translations.updateQueuePayload(id, { ...item.payload, sourceRefreshFailure: { message: (error as Error).message, at: nowIso() } });
      store.translations.log({ level: 'warning', message: `自动知识来源已变化，后续编辑保护阻止撤回：${(error as Error).message}` });
    }
  }
  return { reopened, blocked };
}
