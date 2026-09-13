import {createHash} from 'node:crypto';
import type {ProjectStore} from '@core/db';
import {nowIso} from '@core/db';
import { visibleNameSource } from '../validation/nameEvidence';
import { derivePartZh } from '../db/specialNames';

const suffixes:Record<string,string>={さん:'桑',くん:'君',君:'君',ちゃん:'酱',先輩:'前辈',せんぱい:'前辈'};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface ParagraphLiteralPair {source:string;target:string;paragraphId:string;positions:number[]}

function prepare(store:ProjectStore,queueId:string) {
  const item=store.translations.getQueueItem(queueId);
  if(!item || item.kind!=='honorific-first' || !item.paragraph_id || item.payload.autoSuppressed || item.payload.identityInvalidated || item.payload.knowledgeDecision || item.payload.automaticAddressDecision || item.payload.automaticParagraphAddressDecision) return;
  const p=item.payload,paragraph=store.projects.getParagraph(item.paragraph_id);
  if(!paragraph || store.projects.getSeriesIdOfParagraph(paragraph.id)!==item.series_id || typeof p.sourceFormJp!=='string') return;
  const members=p.items;
  if(members!==undefined && (!Array.isArray(members) || members.length!==1 || !members[0] || members[0].paragraphId!==paragraph.id || ['sourceFormJp','speakerCharId','targetCharId','usedZh'].some(k=>JSON.stringify(members[0][k])!==JSON.stringify(p[k])) ||
    (members[0].candidates!==undefined && JSON.stringify(members[0].candidates)!==JSON.stringify(p.candidates)))) return;
  const match=/^(.+?)(さん|くん|ちゃん|君|先輩|せんぱい)$/u.exec(p.sourceFormJp);
  const name=match?.[1] ?? p.sourceFormJp, suffix=match?.[2] ?? '';
  if(!match && !/^\p{Script=Han}{2,}$/u.test(name)) return;
  const people=store.knowledge.charactersAt(item.series_id,paragraph.seriesOrdinal).filter(c=>c.is_active && (c.canonical_name_jp===name || store.knowledge.aliasesAt(c.id,paragraph.seriesOrdinal).includes(name)));
  if(people.length!==1) return;
  const person=people[0]!;
  if(person.locked_by_user || !store.knowledge.nameCurrent(person,paragraph.seriesOrdinal) || p.targetCharId && p.targetCharId!==person.id) return;
  if(p.speakerCharId) {
    const speaker=store.knowledge.getCharacter(String(p.speakerCharId));
    if(!speaker || speaker.series_id!==item.series_id || !speaker.is_active || speaker.locked_by_user) return;
  }
  const settings=store.projects.getSettings(item.series_id);
  if(settings['honorific.default_style']!=='loan') return;
  const terms=store.glossary.activeTerms(item.series_id).filter(t=>t.term_jp===name);
  const fullNameTerms=terms.length || name===person.canonical_name_jp ? [] : store.glossary.activeTerms(item.series_id).filter(t=>t.term_jp===person.canonical_name_jp);
  const knownZh=person.canonical_name_zh ? derivePartZh(person.canonical_name_jp,person.canonical_name_zh,name) : null;
  let nameZh:string;
  if(terms.length) {
    if(terms.length!==1 || terms[0]!.term_type!=='person' || terms[0]!.lock_level==='suggested' || !terms[0]!.term_zh || terms[0]!.senses.length>1 || knownZh && terms[0]!.term_zh!==knownZh) return;
    nameZh=terms[0]!.term_zh;
  } else if(fullNameTerms.length) {
    const full=fullNameTerms[0]!;
    if(fullNameTerms.length!==1 || full.term_type!=='person' || full.lock_level==='suggested' || !full.term_zh || full.senses.length>1) return;
    const derived=derivePartZh(person.canonical_name_jp,full.term_zh,name);
    if(!derived || knownZh && knownZh!==derived) return;
    nameZh=derived;
  } else {
    // The user's glossary policy excludes Han names. Carrying the same visible
    // name needs no invented transliteration or global character-name update.
    // An existing different Chinese name or pending spelling choice still wins.
    if(!/^\p{Script=Han}{2,}$/u.test(name) || person.canonical_name_zh && knownZh!==name || store.translations.listPendingByKind(item.series_id,'term-proposal').some(q=>q.payload.termJp===name)) return;
    nameZh=name;
  }
  const target=nameZh+(suffixes[suffix]??'');
  if(p.usedZh && p.usedZh!==target) return;
  if(p.candidates!==undefined && (!Array.isArray(p.candidates) || !p.candidates.length || !p.candidates.some(c=>c?.zh===target))) return;
  // Identical spellings in other directions do not assert this paragraph's
  // addressee. Conflicting old/future spellings still need their own review.
  const trajectories=store.db.all<{translated_form:string}>('SELECT * FROM address_trajectories WHERE series_id=? AND target_char_id=? AND source_form_jp=?',[item.series_id,person.id,p.sourceFormJp]);
  if(trajectories.some(row=>row.translated_form!==target)) return;
  const positions:number[]=[];
  const visibleSource = visibleNameSource(paragraph.sourceText);
  for(let at=visibleSource.indexOf(p.sourceFormJp);at>=0;at=visibleSource.indexOf(p.sourceFormJp,at+p.sourceFormJp.length)) {
    if(/[\p{Script=Han}\p{Script=Katakana}A-Za-z0-9]/u.test(visibleSource[at-1]??'') || /[\p{Script=Han}\p{Script=Katakana}A-Za-z0-9]/u.test(visibleSource[at+p.sourceFormJp.length]??'')) return;
    positions.push(at);
  }
  if(!positions.length || positions.length>12) return;
  const pair:ParagraphLiteralPair={source:p.sourceFormJp,target,paragraphId:paragraph.id,positions};
  const inputHash=hash({policy:'paragraph-literal-loan-v2-han-names',pair,source:paragraph.sourceText,ordinal:paragraph.seriesOrdinal,chapter:paragraph.chapterId,type:paragraph.paragraphType,
    person:[person.id,person.canonical_name_jp,person.canonical_name_zh,person.locked_by_user],terms,fullNameTerms,trajectories,settings,
    proposal:{speakerCharId:p.speakerCharId,targetCharId:p.targetCharId,candidates:p.candidates,usedZh:p.usedZh,items:p.items}});
  return {item,paragraph,pair,inputHash};
}

/** Confirm a spelling choice before generation, never translation quality or a relationship. */
export function resolveParagraphLiteralAddresses(store:ProjectStore,volumeId:string):number {
  const seriesId=store.projects.getVolumeSeriesId(volumeId),ids=new Set(store.projects.listParagraphIdsByVolume(volumeId));
  let count=0;
  for(const q of store.translations.listQueue(seriesId).filter(q=>q.kind==='honorific-first' && q.paragraphId && ids.has(q.paragraphId)))store.transaction(()=>{
    const current=prepare(store,q.id);
    if(!current || current.item.status!=='pending' || store.translations.latestFinal(current.paragraph.id)) return;
    if(store.translations.listQueue(seriesId).some(other=>other.id!==q.id && other.kind==='honorific-first' && other.paragraphId===current.paragraph.id && other.payload.sourceFormJp===current.pair.source)) return;
    store.translations.updateQueuePayload(q.id,{...current.item.payload,automaticParagraphLiteralAddress:{version:1,scope:'paragraph-literal-form',pair:current.pair,inputHash:current.inputHash,createdAt:nowIso()}});
    store.translations.resolveQueueItem(q.id,JSON.stringify({action:'paragraph-literal-form',source:current.pair.source,target:current.pair.target}));
    count++;
  });
  return count;
}

export function paragraphLiteralAddressCurrent(store:ProjectStore,queueId:string):boolean {
  const current=prepare(store,queueId);if(!current || current.item.status!=='resolved') return false;
  const receipt=current.item.payload.automaticParagraphLiteralAddress as {version?:number;scope?:string;inputHash?:string;pair?:ParagraphLiteralPair}|undefined;
  return receipt?.version===1 && receipt.scope==='paragraph-literal-form' && receipt.inputHash===current.inputHash && !!receipt.pair && hash(receipt.pair)===hash(current.pair);
}

export function paragraphLiteralAddressPairs(store:ProjectStore,paragraphId:string):ParagraphLiteralPair[] {
  return store.db.all<{id:string}>("SELECT id FROM review_queue WHERE paragraph_id=? AND status='resolved' AND json_extract(payload,'$.automaticParagraphLiteralAddress.version')=1",[paragraphId])
    .filter(q=>paragraphLiteralAddressCurrent(store,q.id)).map(q=>(store.translations.getQueueItem(q.id)!.payload.automaticParagraphLiteralAddress as {pair:ParagraphLiteralPair}).pair);
}

export function literalAddressFlagCovered(store:ProjectStore,paragraphId:string,source:string,translation:string,form:string,usedZh?:string):boolean {
  if(store.projects.getParagraph(paragraphId)?.sourceText!==source) return false;
  return paragraphLiteralAddressPairs(store,paragraphId).some(p=>p.source===form && (!usedZh || usedZh===p.target) && translation.split(p.target).length-1>=p.positions.length);
}

export function reopenParagraphLiteralAddress(store:ProjectStore,queueId:string,userUndo:boolean):void {
  store.transaction(()=>{
    const item=store.translations.getQueueItem(queueId);if(!item || item.status!=='resolved' || !item.payload.automaticParagraphLiteralAddress) throw new Error('本段称呼形式决定已改变或已撤销');
    if(store.db.get("SELECT 1 FROM workflow_tasks WHERE workstation_id=? AND status='running'",[`repair:${queueId}`])) throw new Error('相关修复仍在运行，请先停止');
    const next={...item.payload};
    next.paragraphLiteralHistory=[...(Array.isArray(next.paragraphLiteralHistory)?next.paragraphLiteralHistory:[]),{decision:next.automaticParagraphLiteralAddress,undoneAt:nowIso(),reason:userUndo?'user':'source-changed'}];
    delete next.automaticParagraphLiteralAddress;if(userUndo)next.autoSuppressed=true;
    store.translations.updateQueuePayload(queueId,next);
    store.db.run("UPDATE review_queue SET status='pending',resolution=NULL,resolved_at=NULL WHERE id=?",[queueId]);
    if(item.paragraph_id)store.translations.addRecheck(item.paragraph_id,'paragraph-literal-address-reopened','本段称呼形式依据已变化，需重新核对当前稿');
  });
}
