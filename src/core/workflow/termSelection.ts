import { coveredByConfirmedTerms, isLiteralRankLabel } from '../validation/redundantTermCandidate';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { ProjectStore } from '../db';
import type { AiClient } from '../ai/client';
import { parseWith, checkIdSet, type ProtocolResult } from '../ai/protocol';
import { containsVisibleQuote, visibleNameSource } from '../validation/nameEvidence';
import { isHanOnlyTerm, unwrappedTerm, TERM_GRANULARITY_VERSION } from '../validation/termGranularity';
import { reconcileTermCandidates, retireTermCandidate } from './termCandidatePolicy';

export const TERM_SELECTION_VERSION = 'context-selection-v1';
import { TERM_SELECTION_INSTRUCTION } from '../ai/prompts/termSelectionPrompt';
const category = z.preprocess(value => typeof value === 'string' ? ({person:'proper',place:'proper',organization:'proper',ability:'domain',item:'domain',concept:'domain',honorific:'ordinary',other:'ordinary'} as Record<string,string>)[value] ?? value : value, z.enum(['proper','domain','ordinary']));
const schema = z.object({ decisions: z.array(z.object({ id:z.string(), action:z.enum(['keep','exclude','split']), category, reason:z.string().trim().min(1), cores:z.array(z.object({jp:z.string().trim().min(1),type:z.enum(['person','place','organization','ability','item','concept','honorific','other'])}).strict()).max(6), dropped:z.array(z.object({jp:z.string().min(1),reason:z.string().trim().min(1)}).strict()).max(10).default([]) }).strict()) }).strict();
export type SelectionInput = { id:string; jp:string; examples:{id:string;source:string}[] };
export function parseTermSelection(text:string, input:readonly SelectionInput[]):ProtocolResult<z.infer<typeof schema>> {
  const r=parseWith(schema,text);if(!r.ok)return r;
  const ids=checkIdSet(input.map(x=>x.id),r.value.decisions.map(x=>x.id));if(ids)return {ok:false,error:ids};
  for(const d of r.value.decisions){
    const source=input.find(x=>x.id===d.id)!;
    const invalid=(message:string):ProtocolResult<z.infer<typeof schema>>=>({ok:false,error:{code:'INVALID_SHAPE',message:`${source.id}「${source.jp}」: ${message}`}});
    // Han components are deterministically excluded, rather than asking the model again.
    const han=d.cores.filter(c=>isHanOnlyTerm(c.jp));
    if(han.some(c=>!source.jp.includes(c.jp)))return invalid('组成词不在原词中');
    d.cores=d.cores.filter(c=>!isHanOnlyTerm(c.jp));
    d.dropped.push(...han.map(c=>({jp:c.jp,reason:'用户规则：汉字词不进入确认'})));
    // Canonicalize redundant action labels using the explicitly returned selected parts.
    if(d.action==='split'&&d.cores.length===0){d.action='exclude';d.category='ordinary';}
    if(d.action==='split'&&d.cores.length===1&&d.cores[0]!.jp===source.jp){d.action='keep';d.cores=[];}
    if(d.action==='exclude'){if(d.cores.length||d.category!=='ordinary')return invalid('排除项不能留下核心或标为待保留类型');continue;}
    if(d.category==='ordinary'||isHanOnlyTerm(source.jp))return invalid('普通词或汉字名称不能进入确认');
    if(d.action==='keep'){if(d.cores.length||unwrappedTerm(source.jp)!==source.jp)return invalid('保留项不能带外层符号或拆分核心');continue;}
    if(!d.cores.length)return invalid('拆分必须有需要确认的核心');
    let end=0;const seen=new Set<string>();
    for(const c of d.cores){const start=source.jp.indexOf(c.jp,end);
      if(start<0||c.jp===source.jp||seen.has(c.jp)||isHanOnlyTerm(c.jp)||unwrappedTerm(c.jp)!==c.jp||!source.examples.some(p=>containsVisibleQuote(p.source,c.jp)))return invalid('核心必须按原顺序来自当前词及例句，不得造词、重复、带包装或保留汉字');
      seen.add(c.jp);end=start+c.jp.length;
    }
    const nameLetters=(s:string)=>s.replace(/[^ァ-ヺーA-Za-zＡ-Ｚａ-ｚ]/gu,'');
    const parts=[...d.cores,...d.dropped].sort((a,b)=>source.jp.indexOf(a.jp)-source.jp.indexOf(b.jp));
    let coveredEnd=0;
    for(const p of parts){const pos=source.jp.indexOf(p.jp,coveredEnd);if(pos<0)return invalid('保留和去掉的组成部分必须来自原词且不能重叠');coveredEnd=pos+p.jp.length;}
    if(d.category==='proper'&&nameLetters(source.jp)!==nameLetters(parts.map(c=>c.jp).join('')))return invalid('专名拆分不能遗漏其余假名/字母部分；专名部分放cores，普通类别放dropped并说明，或保留整体');
  }
  return r;
}

/** Separate small judgement before any Chinese proposals. No human translation choices. */
export async function selectTermCandidates(store:ProjectStore,ai:AiClient,volumeId:string,signal?:AbortSignal){
  reconcileTermCandidates(store,volumeId);
  const series=store.projects.getVolumeSeriesId(volumeId);
  const paras=store.projects.listParagraphIdsByVolume(volumeId).map(id=>store.projects.getParagraph(id)!);
  // User's name-component rule takes precedence over a model calling a surname or
  // company-name component an ordinary word. This never supplies a Chinese name.
  const requiredParts=new Set<string>();
  for(const row of store.db.all<{value:string}>('SELECT value FROM meta WHERE key LIKE ?',['term-granularity:%'])){
    let receipt: {prior?:{series_id?:string;term_type?:string;term_jp?:string};parts?:string[]};
    try{receipt=JSON.parse(row.value);}catch{continue;}
    if(receipt.prior?.series_id===series&&['person','organization'].includes(receipt.prior.term_type??'')&&/[ァ-ヺー]・[ァ-ヺー]/u.test(receipt.prior.term_jp??''))for(const part of receipt.parts??[])requiredParts.add(part);
  }
  store.transaction(()=>{
    for(const word of requiredParts){
      if(!paras.some(p=>containsVisibleQuote(p.sourceText,word)))continue;
      for(const t of store.db.all<{id:string;term_zh:string|null;lock_level:string;valid_to_para:number|null}>('SELECT id,term_zh,lock_level,valid_to_para FROM terms WHERE series_id=? AND term_jp=?',[series,word])){
        const audit=store.db.get<{value:string}>('SELECT value FROM meta WHERE key=?',[`term-selection-audit:${t.id}`]);
        if(t.valid_to_para!==0||t.term_zh||t.lock_level!=='suggested'||!audit)continue;
        if(JSON.parse(audit.value).decision.action!=='exclude')continue;
        store.db.run('INSERT OR IGNORE INTO meta(key,value) VALUES(?,?)',[`term-selection-rule-restore:${t.id}`,audit.value]);
        store.db.run('UPDATE terms SET valid_to_para=NULL WHERE id=?',[t.id]);
        for(const q of store.db.all<{id:string;payload:string;resolution:string|null}>("SELECT id,payload,resolution FROM review_queue WHERE series_id=? AND kind='term-proposal' AND status='dismissed'",[series])){
          if(JSON.parse(q.payload).termId!==t.id||!q.resolution||JSON.parse(q.resolution).kind!=='term-granularity')continue;
          store.db.run('INSERT OR IGNORE INTO meta(key,value) VALUES(?,?)',[`term-selection-rule-queue:${q.id}`,JSON.stringify(q)]);
          store.db.run("UPDATE review_queue SET status='pending',resolution=NULL,resolved_at=NULL WHERE id=?",[q.id]);
        }
      }
    }
  });
  const confirmed=store.glossary.activeTerms(series).filter(t=>t.term_zh&&t.lock_level!=='suggested').map(t=>t.term_jp);
  const visibleSources=paras.map(p=>visibleNameSource(p.sourceText));
  for(const t of store.glossary.activeTerms(series).filter(t=>t.lock_level==='suggested'&&!t.term_zh&&!t.senses.length)) {
    if(requiredParts.has(t.term_jp)) continue;
    if(isLiteralRankLabel(t.term_jp)) retireTermCandidate(store,t.id,'字母数字等级标记可直接保留，不需要另选译名',[]);
    else if(coveredByConfirmedTerms(t.term_jp,visibleSources,confirmed)) retireTermCandidate(store,t.id,'全部出现仅位于已确认完整词内部，没有独立简称用法；沿用已确认完整词',[]);
  }
  const pending=store.glossary.activeTerms(series).filter(t=>t.lock_level==='suggested'&&!t.term_zh&&!t.senses.length);
  const inputs=pending.map(t=>({id:t.id,jp:t.term_jp,examples:paras.filter(p=>containsVisibleQuote(p.sourceText,t.term_jp)).slice(0,3).map(p=>({id:p.id,source:visibleNameSource(p.sourceText)}))})).filter(x=>x.examples.length);
  const hash=(x:SelectionInput)=>createHash('sha256').update(JSON.stringify([TERM_SELECTION_VERSION,TERM_SELECTION_INSTRUCTION,x])).digest('hex');
  const work=inputs.filter(x=>!requiredParts.has(x.jp)&&store.db.get<{value:string}>('SELECT value FROM meta WHERE key=?',[`term-selection:${x.id}`])?.value!==hash(x));
  const receipts:unknown[]=[];
  let splitAny=false;
  // Small batches keep the task within Flash's instruction capacity.
  for(let i=0;i<work.length;i+=4){
    signal?.throwIfAborted();const batch=work.slice(i,i+4);
    const r=await ai.structured({workstation:'term-extractor',termSelection:true,user:JSON.stringify({operation:'select_terms',candidates:batch}),parseRetries:1,...(signal?{signal}:{})},text=>parseTermSelection(text,batch));
    signal?.throwIfAborted();
    store.transaction(()=>{
      for(const d of r.value.decisions){
        const t=store.glossary.activeTerms(series).find(t=>t.id===d.id);
        if(!t||t.lock_level!=='suggested'||t.term_zh||t.senses.length)continue;
        const input=batch.find(x=>x.id===d.id)!;
        // Check cited source has not changed while awaiting the model.
        if(input.examples.some(p=>visibleNameSource(store.projects.getParagraph(p.id)?.sourceText??'')!==p.source))throw Error('术语筛选期间原文改变，请重试');
        const prior=store.db.get<{value:string}>('SELECT value FROM meta WHERE key=?',[`term-selection-audit:${d.id}`]);
        if(prior)store.db.run('INSERT OR IGNORE INTO meta(key,value) VALUES(?,?)',[`term-selection-history:${d.id}:${createHash('sha256').update(prior.value).digest('hex')}`,prior.value]);
        store.db.run('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)',[`term-selection-audit:${d.id}`,JSON.stringify({version:TERM_SELECTION_VERSION,input,decision:d,aiCallId:r.aiCallId})]);
        if(d.action==='exclude')retireTermCandidate(store,d.id,d.reason,[]);
        if(d.action==='split'){
          splitAny=true;
          reconcileTermCandidates(store,volumeId,[{version:TERM_GRANULARITY_VERSION,parent:t.term_jp,parts:d.cores.map(c=>c.jp),reason:d.reason}]);
          for(const c of d.cores){const child=store.glossary.findTermByJp(series,c.jp);if(child&&child.lock_level==='suggested'&&!child.term_zh)store.db.run('UPDATE terms SET term_type=? WHERE id=?',[c.type,child.id]);}
        }
        store.db.run('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)',[`term-selection:${d.id}`,hash(input)]);
        receipts.push(d);
      }
    });
  }
  // New, shorter cores also pass selection before their Chinese proposals are made.
  if(splitAny){const next=await selectTermCandidates(store,ai,volumeId,signal);receipts.push(...next.decisions);}
  return {reviewed:receipts.length,decisions:receipts};
}
