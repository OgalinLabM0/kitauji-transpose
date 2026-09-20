import {supportedNameForm} from '../src/core/workflow/reviewNameRepair';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers';
import {DecisionService} from '../src/core/workflow/decisions';
import {scopedReview} from '../src/core/workflow/taskOverview';
import {undoResolvedReview} from '../src/core/workflow/automaticFieldDecisions';
import {KnowledgeRepo} from '../src/core/db/knowledgeRepo';
import {termWidthKey} from '../src/core/workflow/reviewTermForms';

test('legacy unassigned title name repairs actual alias with evidence and undo; does not select Chinese',t=>{
 const f=fixture('ミスター・ハリスが来た。');t.after(()=>f.store.close());
 const cid=f.store.knowledge.upsertCharacter({seriesId:f.seriesId,introducedVolume:1,nameJp:'ハリス'});
 const qid=f.store.translations.enqueue({seriesId:f.seriesId,paragraphId:f.paragraphId,kind:'warning',title:'old',payload:{candidateName:'ミスター・ハリス',claimedCharacter:'ハリス'}});
 const service=new DecisionService(f.store);assert.equal(service.apply(qid,{kind:'warning',action:'dismiss'}).ok,false);
 assert.equal(service.apply(qid,{kind:'warning',action:'repair-name'}).ok,true);
 assert.ok(f.store.knowledge.aliasesAt(cid,1e6).includes('ミスター・ハリス'));
 assert.equal(f.store.knowledge.getCharacter(cid)!.canonical_name_zh,null);
 undoResolvedReview(f.store,qid);assert.equal(f.store.translations.getQueueItem(qid)!.status,'pending');assert.equal(f.store.knowledge.aliasesOf(cid).length,0);
});

test('name repair refuses unsupported nickname, changed source and occupied name without resolving',t=>{
 const f=fixture('ドクター・ベルが来た。赤い狼も来た。');t.after(()=>f.store.close());
 f.store.knowledge.upsertCharacter({seriesId:f.seriesId,introducedVolume:1,nameJp:'ベル'});
 const run=(name:string)=>{const q=f.store.translations.enqueue({seriesId:f.seriesId,paragraphId:f.paragraphId,kind:'warning',title:name,payload:{candidateName:name,claimedCharacter:'ベル'}});const r=new DecisionService(f.store).apply(q,{kind:'warning',action:'repair-name'});assert.equal(r.ok,false);assert.equal(f.store.translations.getQueueItem(q)!.status,'pending');};
 run('赤い狼');run('ミスター・ベル');f.store.knowledge.upsertCharacter({seriesId:f.seriesId,introducedVolume:1,nameJp:'ドクター・ベル'});run('ドクター・ベル');
 assert.equal(KnowledgeRepo.isSafeAutoAlias('ベル','ミスター・ベルグ'),false);
});

function terms(){const f=fixture('コード７とコード7。コード8。');const make=(jp:string,zh:string)=>{const id=f.store.glossary.upsertTerm({seriesId:f.seriesId,introducedVolume:1,termJp:jp,termZh:null,termType:jp.includes('７')?'organization':'other'});const q=f.store.translations.enqueue({seriesId:f.seriesId,paragraphId:f.paragraphId,kind:'term-proposal',title:jp,payload:{termId:id,termJp:jp,candidates:[{zh}]}});return {id,q};};return {...f,a:make('コード７','七号'),b:make('コード7','第七代码'),c:make('コード8','八号')};}

test('ASCII width variants combine legacy choices, confirm together and undo atomically without losing sources',t=>{
 const f=terms();t.after(()=>f.store.close());const list=scopedReview(f.store,f.seriesId,'pending',f.volumeId);assert.equal(list.length,2);
 const group=list.find(q=>Array.isArray(q.payload.equivalentQueueIds))!;assert.equal((group.payload.candidates as any[]).length,2);
 const r=new DecisionService(f.store).apply(group.id,{kind:'term-proposal',action:'choose',zh:'CODE7',englishRuby:{english:'CODE7',gloss:'七号'},equivalentQueueIds:group.payload.equivalentQueueIds as string[]});assert.equal(r.ok,true);
 assert.equal(f.store.glossary.findTermByJp(f.seriesId,'コード７')!.term_zh,'CODE7');assert.equal(f.store.glossary.findTermByJp(f.seriesId,'コード7')!.term_zh,'CODE7');assert.equal(f.store.translations.getQueueItem(f.c.q)!.status,'pending');
 undoResolvedReview(f.store,group.id);assert.equal(f.store.glossary.findTermByJp(f.seriesId,'コード７')!.term_zh,null);assert.equal(f.store.glossary.findTermByJp(f.seriesId,'コード7')!.term_zh,null);assert.equal(scopedReview(f.store,f.seriesId).length,2);
});

test('changed or semantically different term cannot be smuggled into grouped confirmation',t=>{
 const f=terms();t.after(()=>f.store.close());const r=new DecisionService(f.store).apply(f.a.q,{kind:'term-proposal',action:'choose',zh:'七号',equivalentQueueIds:[f.b.q,f.c.q]});assert.equal(r.ok,false);assert.ok(f.store.glossary.activeTerms(f.seriesId).every(t=>t.term_zh===null));
 assert.notEqual(termWidthKey('Apple'),termWidthKey('apple'));assert.notEqual(termWidthKey('コード7'),termWidthKey('コード8'));
});

test('group rejection can restore both original terms through one undo',t=>{
 const f=terms();t.after(()=>f.store.close());const result=new DecisionService(f.store).apply(f.a.q,{kind:'term-proposal',action:'reject',equivalentQueueIds:[f.b.q]});assert.ok(result.ok);assert.equal(f.store.glossary.activeTerms(f.seriesId).length,1);undoResolvedReview(f.store,f.a.q);assert.equal(f.store.glossary.activeTerms(f.seriesId).length,3);
});

test('titles never collapse spouses or choose among a surname and another full name',t=>{
 assert.equal(supportedNameForm('ミスター・ベル','ミセス・ベル'),false);assert.equal(supportedNameForm('アン・ベル','ミスター・ベル'),false);
 const f=fixture('ミスター・ベルが来た。');t.after(()=>f.store.close());
 f.store.knowledge.upsertCharacter({seriesId:f.seriesId,introducedVolume:1,nameJp:'ベル'});f.store.knowledge.upsertCharacter({seriesId:f.seriesId,introducedVolume:1,nameJp:'アン・ベル'});
 const q=f.store.translations.enqueue({seriesId:f.seriesId,paragraphId:f.paragraphId,kind:'warning',title:'ambiguous',payload:{candidateName:'ミスター・ベル',claimedCharacter:'ベル'}});assert.equal(new DecisionService(f.store).apply(q,{kind:'warning',action:'repair-name'}).ok,false);assert.equal(f.store.translations.getQueueItem(q)!.status,'pending');
});
