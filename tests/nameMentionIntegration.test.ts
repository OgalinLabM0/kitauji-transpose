import {PreReadCheckpoint} from '../src/core/workflow/preReadCheckpoint';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,fakeAi} from './helpers';
import {PrepRunner} from '../src/core/workflow/prepRunner';
import {NAME_MENTION_REVIEW_PROMPT} from '../src/core/validation/nameMentionReview';
import {characterSourceCurrent} from '../src/core/db/characterSources';
test('pre-read reviews an unlisted title once, rejects a word fragment, persists proof and retains resumable checkpoints and reuses review on explicit rerun',async t=>{
 const f=fixture('「アリス特別研究生、来なさい。」\n\n法律を読む。');t.after(()=>f.store.close());let calls=0,reviewCalls=0;
 const ai=fakeAi(f.store,(request,config)=>{calls++;const input=JSON.parse(request.user);
  if(request.system===NAME_MENTION_REVIEW_PROMPT){reviewCalls++;assert.equal(config.thinkingMode,'disabled');return {items:input.paragraphs.map((p:any)=>({id:p.id,decision:p.name==='アリス'?'person':'not_person',quote:p.source}))};}
  const ids=input.paragraphs.map((p:any)=>p.id);
  if(request.system.includes('只提取本次日文paragraphs中的人物'))return {reviewed_ids:ids,characters:input.paragraphs.map((p:any,i:number)=>({name_jp:i===0?'アリス':'律',evidence_ids:[p.id],name_evidence:{paragraph_id:p.id,quote:p.source}}))};
  return {reviewed_ids:ids,plot_events:[],relationship_events:[],knowledge_change_candidates:[]};
 });
 await new PrepRunner(f.store,ai).preRead(f.volumeId);assert.equal(reviewCalls,1);assert.equal(calls,3);
 const names=f.store.db.all<{canonical_name_jp:string}>('SELECT canonical_name_jp FROM characters');assert.deepEqual(names.map(x=>x.canonical_name_jp),['アリス']);
 const observation=f.store.db.get<{source_proof:string}>('SELECT source_proof FROM character_name_observations')!;const proof=JSON.parse(observation.source_proof);assert.ok(proof.nameReview.id);assert.equal(characterSourceCurrent(f.store.db,observation.source_proof),true);
 const views=f.store.projects.listParagraphViewsByVolume(f.volumeId);assert.ok(new PreReadCheckpoint(f.store,views[0]!.chapterId,false).doneMany(views).every(Boolean));
 await new PrepRunner(f.store,ai).preRead(f.volumeId);assert.equal(calls,5,'explicit complete-chapter rerun still extracts; cached independent review reused');assert.equal(reviewCalls,1);
 const receipt=JSON.parse(f.store.db.get<{value:string}>("SELECT value FROM meta WHERE key LIKE 'name-mention-review:%' AND value LIKE '%アリス%'")!.value);f.store.db.run("UPDATE ai_calls SET error='invalidated' WHERE id=?",[receipt.aiCallId]);assert.equal(characterSourceCurrent(f.store.db,observation.source_proof),false);
});

test('one visible full-name alias proposal is retained for confirmation instead of disappearing',async t=>{
 const f=fixture('ミナ・カザハラは名乗った。「ミナと呼んでください。」');t.after(()=>f.store.close());
 const ai=fakeAi(f.store,request=>{const input=JSON.parse(request.user);const ids=input.paragraphs.map((p:any)=>p.id);
 if(request.system.includes('只提取本次日文paragraphs中的人物'))return {reviewed_ids:ids,characters:[{name_jp:'ミナ',aliases:['ミナ・カザハラ'],evidence_ids:ids,name_evidence:{paragraph_id:ids[0],quote:input.paragraphs[0].source}}]};
 return {reviewed_ids:ids,plot_events:[],relationship_events:[],knowledge_change_candidates:[]};});
 await new PrepRunner(f.store,ai).preRead(f.volumeId);
 const rows=f.store.db.all<{title:string}>('SELECT title FROM review_queue');assert.ok(rows.some(r=>r.title.includes('ミナ・カザハラ')));
 assert.equal(f.store.db.all('SELECT * FROM character_aliases').length,0,'a model proposal alone must not silently merge identities');
 await new PrepRunner(f.store,ai).preRead(f.volumeId);assert.equal(f.store.db.all('SELECT * FROM review_queue').length,rows.length,'do not duplicate pending identity confirmation');
});
