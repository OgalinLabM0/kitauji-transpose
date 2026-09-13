import type { InlineTemplate } from '../epub/blocks';
import { longParagraphParts } from './longParagraphDraft';
import type { RepairSpan } from './repairSpan';
import {validateMarkers} from '../epub/blocks';
import {naturalnessText} from './naturalnessText';

/** All issues must map to disjoint intact groups in the same exact candidate. */
export function currentCandidateRepairSpans(source: string, draft: string, coverage: unknown, quotes: readonly string[], template: InlineTemplate): RepairSpan[] | null {
  if (!quotes.length) return null;
  const unique = new Map<string, RepairSpan>();
  for (const quote of quotes) {
    const span = currentCandidateRepairSpan(source, draft, coverage, [quote], template);
    if (!span) return null;
    unique.set(`${span.start}:${span.end}`, span);
  }
  const spans = [...unique.values()].sort((a, b) => a.start - b.start);
  if (spans.length > 3 || spans.some((span, i) => i > 0 && spans[i - 1]!.end > span.start)) return null;
  return spans;
}

/** Locate intact sentence groups using only the freshly aligned candidate's offsets. */
export function currentCandidateRepairSpan(source: string, draft: string, coverage: unknown, quotes: readonly string[], template: InlineTemplate): RepairSpan | null {
  if (!Array.isArray(coverage) || !coverage.length || !quotes.length || quotes.some(q => !q || draft.indexOf(q) < 0 || draft.indexOf(q) !== draft.lastIndexOf(q))) return null;
  if (coverage.some(r => !r || r.status !== 'covered' || typeof r.segment !== 'string' || !r.segment || typeof r.rendered_as !== 'string' || !r.rendered_as)) return null;
  if(/[⟦⟧]/u.test(source+draft)){
    try{
      const jp=naturalnessText(source,template),zh=naturalnessText(draft,template);
      if(coverage.map(r=>r.segment).join('')!==jp.text||coverage.map(r=>r.rendered_as).join('')!==zh.text)return null;
      const boundaries=new Map<number,number>([[0,0]]);let a=0,b=0;
      for(const row of coverage){a+=row.segment.length;b+=row.rendered_as.length;boundaries.set(a,b);}
      const groups=longParagraphParts(source,template,1,0);if(groups.length<2)return null;
      let rawAt=0,visibleAt=0;
      for(const group of groups){
        const length=jp.range(rawAt,rawAt+group.length).text.length,start=boundaries.get(visibleAt),end=boundaries.get(visibleAt+length);
        rawAt+=group.length;visibleAt+=length;
        if(start===undefined||end===undefined||source.indexOf(group)!==source.lastIndexOf(group))continue;
        const located=zh.rawQuote(zh.text.slice(start,end));if(!located)continue;
        let left=draft.indexOf(located),right=left+located.length;
        if(left<0||left!==draft.lastIndexOf(located))continue;
        // Include only immediately adjacent structural tokens, never more words.
        const opening=/(?:⟦\d+⟧)+$/u.exec(draft.slice(0,left));if(opening)left-=opening[0].length;
        const closing=/^(?:⟦\/\d+⟧)+/u.exec(draft.slice(right));if(closing)right+=closing[0].length;
        const target=draft.slice(left,right);
        const ids=new Set([...group.matchAll(/⟦\/?(\d+)⟧/gu)].map(m=>Number(m[1])));
        const local={markers:template.markers.filter(m=>ids.has(m.id))};
        if(local.markers.some(m=>m.kind==='atomic')||!validateMarkers(group,local).ok||!validateMarkers(target,local).ok)continue;
        if(quotes.every(q=>target.includes(q)))return {source:group,draft:target,start:left,end:right};
      }
    }catch{/* Uncertain structural boundaries must keep the existing safe fallback. */}
    return null;
  }
  if (coverage.map(r => r.segment).join('') !== source || coverage.map(r => r.rendered_as).join('') !== draft) return null;
  const boundaries = new Map<number, number>([[0, 0]]);
  let sourceAt = 0, targetAt = 0;
  for (const row of coverage) { sourceAt += row.segment.length; targetAt += row.rendered_as.length; boundaries.set(sourceAt, targetAt); }
  const groups = longParagraphParts(source, template, 1, 0);
  if (groups.length < 2) return null;
  sourceAt = 0;
  for (const group of groups) {
    const endAt = sourceAt + group.length;
    const start = boundaries.get(sourceAt), end = boundaries.get(endAt);
    if (start !== undefined && end !== undefined) {
      const target = draft.slice(start, end);
      if (target && quotes.every(q => target.includes(q)) && source.indexOf(group) === source.lastIndexOf(group) && draft.indexOf(target) === draft.lastIndexOf(target)) return { source: group, draft: target, start, end };
    }
    sourceAt = endAt;
  }
  return null;
}
