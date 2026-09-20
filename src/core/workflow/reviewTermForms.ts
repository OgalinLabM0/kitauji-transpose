import type { ProjectStore } from '../db';
import type { ReviewItemView } from '../../shared/types';

// Only ASCII width differs. Do not fold case, kana, punctuation, word order or meaning.
export const termWidthKey = (value: string): string => value.replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

export function groupTermForms(store: ProjectStore, items: ReviewItemView[]): ReviewItemView[] {
  const groups = new Map<string, ReviewItemView>();
  return items.reduce<ReviewItemView[]>((out, item) => {
    if (item.status !== 'pending' || item.kind !== 'term-proposal') { out.push(item); return out; }
    const term = store.db.get<{series_id:string;term_jp:string;term_type:string;lock_level:string}>('SELECT series_id,term_jp,term_type,lock_level FROM terms WHERE id=? AND valid_to_para IS NULL', [String(item.payload.termId)]);
    if (!term || term.lock_level !== 'suggested') { out.push(item); return out; }
    const key = JSON.stringify([term.series_id, termWidthKey(term.term_jp)]);
    const first = groups.get(key);
    if (first?.payload.termId===item.payload.termId) {out.push(item);return out;}
    if (!first) { const copy = {...item,payload:{...item.payload}};groups.set(key,copy);out.push(copy);return out; }
    const forms = (first.payload.equivalentForms as string[] | undefined) ?? [String(first.payload.termJp)];
    const ids = (first.payload.equivalentQueueIds as string[] | undefined) ?? [first.id];
    first.payload.equivalentForms = [...new Set([...forms,term.term_jp])];
    first.payload.equivalentQueueIds = [...ids,item.id];
    const candidates = [...(Array.isArray(first.payload.candidates)?first.payload.candidates:[]),...(Array.isArray(item.payload.candidates)?item.payload.candidates:[])];
    first.payload.candidates = candidates.filter((c,i)=>c && typeof c.zh==='string' && candidates.findIndex(v=>v?.zh===c.zh)===i);
    return out;
  }, []);
}
