import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,fakeAi} from './helpers';
import {PrepRunner} from '../src/core/workflow/prepRunner';
import {NAME_MENTION_REVIEW_PROMPT} from '../src/core/validation/nameMentionReview';
import {characterSourceCurrent} from '../src/core/db/characterSources';

test('literal hiragana and title-shaped names survive preparation and cleanup only with a current review',async t=>{
 const f=fixture('少女は「ゆき」と名乗った。\n\n「先生」がこの少年の本名だ。敬称ではない。\n\n教官が来た。');t.after(()=>f.store.close());
 let reviews=0;
 const ai=fakeAi(f.store,(request,config)=>{
  const input=JSON.parse(request.user);
  if(input.operation==='select_terms')return {decisions:input.candidates.map((c:any)=>({id:c.id,action:'keep',category:'proper',reason:'原文明示人名',cores:[]}))};
  if(input.existing)return {reviewed_ids:input.paragraphs.map((p:any)=>p.id),terms:[]};
  if(input.terms)return {proposals:input.terms.map((p:any)=>({term_jp:p.term_jp,candidates:[{zh:'小雪'}]}))};
  if(request.system===NAME_MENTION_REVIEW_PROMPT){
   reviews++;assert.equal(config.thinkingMode,'disabled');
   assert.deepEqual(input.paragraphs.map((p:any)=>p.name),['ゆき','先生','教官']);
   return {items:input.paragraphs.map((p:any)=>({id:p.id,decision:p.name==='教官'?'not_person':'person',quote:p.source}))};
  }
  const ids=input.paragraphs.map((p:any)=>p.id);
  if(request.system.includes('只提取本次日文paragraphs中的人物'))return {reviewed_ids:ids,characters:input.paragraphs.map((p:any,i:number)=>({name_jp:['ゆき','先生','教官'][i],evidence_ids:[p.id],name_evidence:{paragraph_id:p.id,quote:p.source}}))};
  assert.ok(!input.known_names.includes('教官'),'rejected role must not anchor events');
  return {reviewed_ids:ids,plot_events:[],relationship_events:[],knowledge_change_candidates:[]};
 });
 await new PrepRunner(f.store,ai).preRead(f.volumeId);
 assert.equal(reviews,1);
 const rows=f.store.db.all<{id:string;canonical_name_jp:string;is_active:number}>('SELECT id,canonical_name_jp,is_active FROM characters');
 assert.deepEqual(rows.map(r=>[r.canonical_name_jp,r.is_active]),[['ゆき',1],['先生',1]]);
 const observations=f.store.db.all<{name_jp:string;source_proof:string}>('SELECT name_jp,source_proof FROM character_name_observations');
 assert.ok(observations.every(o=>characterSourceCurrent(f.store.db,o.source_proof)));
 assert.deepEqual(f.store.knowledge.repairGenericNames(f.seriesId).deactivated,[]);
 await new PrepRunner(f.store,ai).preRead(f.volumeId);
 assert.equal(reviews,1,'reuses current independent receipts without charging again');
 await new PrepRunner(f.store,ai).extractTerms(f.volumeId);
 const terms=f.store.glossary.activeTerms(f.seriesId);
 assert.deepEqual(terms.map(t=>t.term_jp),['ゆき'],'verified kana name remains eligible; Han name and ordinary title remain excluded');
 assert.equal(terms[0]!.term_zh,null,'the user still makes the final translation choice');
 assert.ok(f.store.translations.listPendingByKind(f.seriesId,'term-proposal').length===1);
 const proof=JSON.parse(observations.find(o=>o.name_jp==='ゆき')!.source_proof);
 assert.ok(proof.nameReview.id);
 const receipt=JSON.parse(f.store.db.get<{value:string}>("SELECT value FROM meta WHERE key LIKE 'name-mention-review:%' AND value LIKE '%ゆき%'")!.value);
 f.store.db.run("UPDATE ai_calls SET error='revoked' WHERE id=?",[receipt.aiCallId]);
 assert.equal(characterSourceCurrent(f.store.db,observations[0]!.source_proof),false);
 assert.ok(f.store.knowledge.repairGenericNames(f.seriesId).deactivated.includes('ゆき'));
});

test('unreviewed generic-looking legacy names still undergo cleanup',t=>{
 const f=fixture('教官が来た。');t.after(()=>f.store.close());
 const id=f.store.knowledge.upsertCharacter({seriesId:f.seriesId,introducedVolume:1,nameJp:'教官'});
 assert.deepEqual(f.store.knowledge.repairGenericNames(f.seriesId).deactivated,['教官']);
 assert.equal(f.store.knowledge.getCharacter(id)?.is_active,0);
});


test('changed source during review cannot certify the old model answer against a new paragraph',async t=>{
 const f=fixture('少女は「ゆき」と名乗った。');t.after(()=>f.store.close());
 const ai=fakeAi(f.store,request=>{
  const input=JSON.parse(request.user);
  if(request.system===NAME_MENTION_REVIEW_PROMPT){
   f.store.db.run('UPDATE paragraphs SET source_text=? WHERE id=?',['少女は「ゆき」と名乗った。これは芝居の役名だった。',f.paragraphId]);
   return {items:input.paragraphs.map((p:any)=>({id:p.id,decision:'person',quote:p.source}))};
  }
  return {reviewed_ids:[f.paragraphId],characters:[{name_jp:'ゆき',evidence_ids:[f.paragraphId],name_evidence:{paragraph_id:f.paragraphId,quote:input.paragraphs[0].source}}]};
 });
 await assert.rejects(new PrepRunner(f.store,ai).preRead(f.volumeId),/原文.*变化/);
 assert.equal(f.store.db.all("SELECT key FROM meta WHERE key LIKE 'name-mention-review:%'").length,0);
 assert.equal(f.store.db.all('SELECT id FROM characters').length,0);
});
