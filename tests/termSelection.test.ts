import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTermSelection, selectTermCandidates } from '../src/core/workflow/termSelection';
import { fixture, fakeAi } from './helpers';
import { reconcileTermCandidates } from '../src/core/workflow/termCandidatePolicy';
const input=[{id:'x',jp:'高級ダンジョン料理店',examples:[{id:'p',source:'高級ダンジョン料理店へ行った。'}]}];
const decision={id:'x',action:'split',category:'domain',reason:'場所修飾を除き世界設定の概念を統一',cores:[{jp:'ダンジョン',type:'concept'}]};
test('selection requires full receipts and literal eligible cores',()=>{
  assert.ok(parseTermSelection(JSON.stringify({decisions:[decision]}),input).ok);
  for(const decisions of [[],[decision,decision],[{...decision,cores:[{jp:'迷宮',type:'concept'}]}],[{...decision,action:'keep',cores:[],category:'ordinary'}]])assert.equal(parseTermSelection(JSON.stringify({decisions}),input).ok,false);
});
test('generic selection excludes ordinary words beyond the example list and preserves evidence/history',async t=>{
  const f=fixture('タクシーで古代ダンジョン入口へ向かった。');t.after(()=>f.store.close());
  for(const word of ['タクシー','古代ダンジョン入口'])f.store.glossary.upsertTerm({seriesId:f.seriesId,introducedVolume:1,termJp:word,termZh:null,termType:'concept',lockLevel:'suggested',evidenceIds:f.ids});
  const ai=fakeAi(f.store,req=>{const data=JSON.parse(req.user);return {decisions:data.candidates.map((c:{id:string;jp:string})=>c.jp==='タクシー'?{id:c.id,action:'exclude',category:'ordinary',reason:'普通交通手段',cores:[]}:c.jp==='ダンジョン'?{id:c.id,action:'keep',category:'domain',reason:'迷宫空间概念',cores:[]}:{...decision,id:c.id})};});
  const result=await selectTermCandidates(f.store,ai,f.volumeId);
  assert.equal(result.reviewed,3);
  assert.deepEqual(f.store.glossary.activeTerms(f.seriesId).map(t=>t.term_jp),['ダンジョン']);
  assert.equal(f.store.glossary.activeTerms(f.seriesId)[0]!.term_zh,null);
  assert.equal(f.store.db.all('SELECT * FROM terms').length,3);
});
test('a failed semantic screen does not retire candidates',async t=>{
  const f=fixture('コメンテーターが来た。');t.after(()=>f.store.close());
  f.store.glossary.upsertTerm({seriesId:f.seriesId,introducedVolume:1,termJp:'コメンテーター',termZh:null,termType:'person',lockLevel:'suggested',evidenceIds:f.ids});
  await assert.rejects(selectTermCandidates(f.store,fakeAi(f.store,()=>({decisions:[]})),f.volumeId));
  assert.equal(f.store.glossary.activeTerms(f.seriesId).length,1);
});
test('proper names cannot silently lose parts but explicit ordinary suffixes can be removed',()=>{
  const name=[{id:'x',jp:'ダンジョンイーグルス',examples:[{id:'p',source:'ダンジョンイーグルス'}]}];
  assert.equal(parseTermSelection(JSON.stringify({decisions:[{...decision,category:'proper'}]}),name).ok,false);
  const channel=[{id:'x',jp:'ルナチャンネル',examples:[{id:'p',source:'ルナチャンネル'}]}];
  assert.ok(parseTermSelection(JSON.stringify({decisions:[{...decision,category:'proper',cores:[{jp:'ルナ',type:'person'}],dropped:[{jp:'チャンネル',reason:'普通频道类别'}]}]}),channel).ok);
});
test('selection uses its own short system contract and skips an unchanged approved screen',async t=>{
  const f=fixture('ダンジョンに入る。');t.after(()=>f.store.close());
  f.store.glossary.upsertTerm({seriesId:f.seriesId,introducedVolume:1,termJp:'ダンジョン',termZh:null,termType:'concept',lockLevel:'suggested',evidenceIds:f.ids});
  let calls=0;
  const ai=fakeAi(f.store,req=>{calls++;assert.ok(req.system.includes('decisions'));assert.ok(!req.system.includes('reviewed_ids'));const input=JSON.parse(req.user);return {decisions:input.candidates.map((c:{id:string})=>({id:c.id,action:'keep',category:'domain',reason:'世界中的迷宫空间类别',cores:[]}))};});
  await selectTermCandidates(f.store,ai,f.volumeId);await selectTermCandidates(f.store,ai,f.volumeId);
  assert.equal(calls,1);assert.equal(f.store.glossary.activeTerms(f.seriesId)[0]!.term_zh,null);
});
test('name components retain the requested separate confirmation without selecting Chinese',async t=>{
  const f=fixture('ルミナ・プロダクションに入る。');t.after(()=>f.store.close());
  f.store.glossary.upsertTerm({seriesId:f.seriesId,introducedVolume:1,termJp:'ルミナ・プロダクション',termZh:null,termType:'organization',lockLevel:'suggested',evidenceIds:f.ids});
  reconcileTermCandidates(f.store,f.volumeId);
  await selectTermCandidates(f.store,fakeAi(f.store,()=>{throw Error('Deterministic name-component policy must not be overridden by the model');}),f.volumeId);
  assert.deepEqual(new Set(f.store.glossary.activeTerms(f.seriesId).map(t=>t.term_jp)),new Set(['ルミナ','プロダクション']));
  assert.ok(f.store.glossary.activeTerms(f.seriesId).every(t=>t.term_zh===null));
});


test('current full person name preserves directly extracted components and restores only machine exclusions',async t=>{
  const f=fixture('「私はミナ・ハルウェルです」と名乗った。');t.after(()=>f.store.close());
  f.store.knowledge.upsertCharacter({seriesId:f.seriesId,introducedVolume:1,nameJp:'ミナ・ハルウェル'});
  const id=f.store.glossary.upsertTerm({seriesId:f.seriesId,introducedVolume:1,termJp:'ミナ',termZh:null,termType:'person',lockLevel:'suggested',evidenceIds:f.ids});
  f.store.db.run('UPDATE terms SET valid_to_para=0 WHERE id=?',[id]);
  f.store.db.run('INSERT INTO meta(key,value) VALUES(?,?)',[`term-selection-audit:${id}`,JSON.stringify({decision:{action:'exclude',reason:'wrongly delegated all names to people page'}})]);
  await selectTermCandidates(f.store,fakeAi(f.store,()=>{throw Error('Current full name components do not require free reclassification');}),f.volumeId);
  const terms=f.store.glossary.activeTerms(f.seriesId);
  assert.deepEqual(new Set(terms.map(t=>t.term_jp)),new Set(['ミナ','ハルウェル']));
  assert.equal(terms.find(t=>t.term_jp==='ミナ')!.id,id,'restore original, never duplicate');
  assert.ok(terms.every(t=>t.term_zh===null&&t.lock_level==='suggested'),'never choose Chinese');
});

test('stale or unrelated full person name cannot protect an ordinary candidate',async t=>{
  const f=fixture('ミナ・ハルウェルという商品名があった。');t.after(()=>f.store.close());
  f.store.knowledge.upsertCharacter({seriesId:f.seriesId,introducedVolume:1,nameJp:'ミナ・ハルウェル'},1,'model');
  f.store.knowledge.upsertCharacter({seriesId:f.seriesId,introducedVolume:1,nameJp:'ミナ・ベル'});
  f.store.glossary.upsertTerm({seriesId:f.seriesId,introducedVolume:1,termJp:'ミナ',termZh:null,termType:'person',lockLevel:'suggested',evidenceIds:f.ids});
  let calls=0;
  await selectTermCandidates(f.store,fakeAi(f.store,req=>{calls++;const input=JSON.parse(req.user);return {decisions:input.candidates.map((c:any)=>({id:c.id,action:'exclude',category:'ordinary',reason:'ordinary use in this source',cores:[]}))};}),f.volumeId);
  assert.equal(calls,1);assert.equal(f.store.glossary.activeTerms(f.seriesId).length,0);
});


test('re-extracted active component prevents restoration from duplicating the same term',async t=>{
 const f=fixture('ミナ・ハルウェルが来た。');t.after(()=>f.store.close());
 f.store.knowledge.upsertCharacter({seriesId:f.seriesId,introducedVolume:1,nameJp:'ミナ・ハルウェル'});
 const make=()=>f.store.glossary.upsertTerm({seriesId:f.seriesId,introducedVolume:1,termJp:'ミナ',termZh:null,termType:'person',lockLevel:'suggested',evidenceIds:f.ids});
 const old=make();f.store.db.run('UPDATE terms SET valid_to_para=0 WHERE id=?',[old]);
 f.store.db.run('INSERT INTO meta(key,value) VALUES(?,?)',[`term-selection-audit:${old}`,JSON.stringify({decision:{action:'exclude'}})]);
 const current=make();assert.notEqual(current,old);
 await selectTermCandidates(f.store,fakeAi(f.store,()=>{throw Error('known component');}),f.volumeId);
 const names=f.store.glossary.activeTerms(f.seriesId).filter(t=>t.term_jp==='ミナ');assert.equal(names.length,1);assert.equal(names[0]!.id,current);
 assert.equal(f.store.db.get<{valid_to_para:number}>('SELECT valid_to_para FROM terms WHERE id=?',[old])!.valid_to_para,0);
});
