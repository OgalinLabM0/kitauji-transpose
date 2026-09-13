import { createHash } from 'node:crypto';
import type { ProjectStore } from '@core/db';
import type { AiClient } from '@core/ai';
import { auditStatus } from './auditReceipts';
import { reverifyFinal } from './reverifyFinal';
import { beginParagraphAddressDecision, finishKnowledgeDecision } from './knowledgeDecisionJournal';
import { bindAutomaticSources } from './automaticKnowledgeSources';
import { visibleNameSource } from '../validation/nameEvidence';

const suffixes: Record<string,string> = { さん:'桑', くん:'君', 君:'君', ちゃん:'酱' };
export interface LocalAddressPair { source:string; target:string }
/** Unique literal forms only. This proves no speaker identity or relationship. */
export function localAddressPairs(source:string, translation:string, form:string, names:ReadonlyMap<string,string>):LocalAddressPair[] | null {
  // Only spelling, uniqueness and reading order are compared here. No raw
  // offsets escape this helper; fingerprints still use the original strings.
  source=visibleNameSource(source); translation=visibleNameSource(translation);
  const forms = form.split(/[／/]/u);
  if (!forms.length || forms.length>4 || new Set(forms).size!==forms.length || (forms.length>1 && source.includes(form))) return null;
  const pairs:LocalAddressPair[]=[];
  let lastSource=-1,lastTarget=-1;
  for (const sourceForm of forms) {
    const match=sourceForm.match(/^(.+?)(さん|くん|ちゃん|君)$/u);
    const zh=match && names.get(match[1]!);
    if (!match || !zh) return null;
    const target=zh+suffixes[match[2]!]!;
    const a=source.indexOf(sourceForm),b=translation.indexOf(target);
    if (a<0 || b<0 || a!==source.lastIndexOf(sourceForm) || b!==translation.lastIndexOf(target) || a<=lastSource || b<=lastTarget) return null;
    pairs.push({source:sourceForm,target}); lastSource=a;lastTarget=b;
  }
  return pairs;
}

/** Resolve only the paragraph's literal forms after full fidelity/reading review. No address rows are written. */
export async function resolveParagraphAddressProposals(store:ProjectStore,ai:AiClient,volumeId:string,signal?:AbortSignal):Promise<number> {
  const seriesId=store.projects.getVolumeSeriesId(volumeId),ids=new Set(store.projects.listParagraphIdsByVolume(volumeId));
  let resolved=0;
  for (const q of store.translations.listQueue(seriesId).filter(q=>q.kind==='honorific-first' && q.paragraphId && ids.has(q.paragraphId))) {
    signal?.throwIfAborted();
    const prepare=()=>{
      const item=store.translations.getQueueItem(q.id),paragraph=store.projects.getParagraph(q.paragraphId!),final=store.translations.latestFinal(q.paragraphId!);
      if (!item || item.status!=='pending' || item.payload.speakerCharId || item.payload.knowledgeDecision || item.payload.autoSuppressed || !paragraph || !final || store.projects.currentAnalysis(paragraph.id)?.speaker_char_id || typeof item.payload.sourceFormJp!=='string') return null;
      if (item.payload.items!==undefined && (!Array.isArray(item.payload.items) || item.payload.items.some(row=>!row || row.paragraphId!==paragraph.id || row.sourceFormJp!==item.payload.sourceFormJp || row.speakerCharId))) return null;
      const settings=store.projects.getSettings(seriesId);
      if (settings['honorific.default_style']!=='loan') return null;
      const terms=store.glossary.activeTerms(seriesId).filter(t=>t.term_type==='person' && t.lock_level!=='suggested' && t.term_zh);
      const pairs=localAddressPairs(paragraph.sourceText,final.final_text,item.payload.sourceFormJp,new Map(terms.map(t=>[t.term_jp,t.term_zh!])));
      if (!pairs) return null;
      const hash=createHash('sha256').update(JSON.stringify([paragraph,final.final_text,settings,terms,item.payload])).digest('hex');
      return {item,paragraph,final,pairs,hash};
    };
    const start=prepare();if (!start) continue;
    if (auditStatus(store,start.final)!=='valid') {
      const checked=await reverifyFinal(store,ai,start.paragraph.id,signal,true);
      if (!checked.ok) continue;
    }
    signal?.throwIfAborted();
    const current=prepare();
    if (!current || current.hash!==start.hash || auditStatus(store,current.final)!=='valid' || store.translations.openFindings(current.paragraph.id).some(f=>f.severity!=='info')) continue;
    store.transaction(()=>{
      const journal=beginParagraphAddressDecision(store,q.id);
      store.translations.updateQueuePayload(q.id,{...current.item.payload,automaticParagraphAddressDecision:{version:1,scope:'this-paragraph-only',pairs:current.pairs,reviewedFinalId:current.final.id,inputHash:current.hash}});
      store.translations.resolveQueueItem(q.id,JSON.stringify({action:'verified-paragraph-address-forms',pairs:current.pairs}));
      bindAutomaticSources(store,q.id,[current.paragraph.id],false,true);
      finishKnowledgeDecision(store,q.id,journal);
      store.translations.addRecheck(current.paragraph.id,'paragraph-address-verified','本段称呼形式已核对，仍需按当前全部资料确认交付状态');
      resolved++;
    });
  }
  return resolved;
}
