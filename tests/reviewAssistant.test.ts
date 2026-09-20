import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,fakeAi} from './helpers';
import {askReviewAssistant,readReviewAssistant} from '../src/core/workflow/reviewAssistant';
import {englishRubyRules,englishRubyMarks} from '../src/core/workflow/termEnglishRuby';
import {DecisionService} from '../src/core/workflow/decisions';
import {rubyForExport} from '../src/core/workflow/rubyDisplay';
import {undoResolvedReview} from '../src/core/workflow/automaticFieldDecisions';
function setup(){
 const f=fixture('シルバーゲートは会社の名前だ。');
 const termId=f.store.glossary.upsertTerm({seriesId:f.seriesId,introducedVolume:1,termJp:'シルバーゲート',termZh:null,termType:'organization',lockLevel:'suggested',notes:'original note'});
 const queueId=f.store.translations.enqueue({seriesId:f.seriesId,paragraphId:f.paragraphId,kind:'term-proposal',title:'待确认',payload:{termId,termJp:'シルバーゲート',candidates:[{zh:'银门',basis:'semantic'}],examples:[{id:f.paragraphId,text:'シルバーゲートは会社の名前だ。'}]}});
 return {...f,termId,queueId};
}
test('assistant explains old queue without choosing terms; source changes invalidate conversation',async t=>{
 const f=setup();t.after(()=>f.store.close());let calls=0;
 const ai=fakeAi(f.store,req=>{calls++;assert.match(req.system,/用户不懂日语/);const p=JSON.parse(req.user);assert.equal(p.term,'シルバーゲート');return {answer:'这是公司名，英文拼写仅是候选，需要你确认。',evidence:p.evidence.map((e:any)=>({id:e.id,zh:'Silver Gate是一家公司。'})),english:'Silver Gate',gloss:'银门'};});
 const result=await askReviewAssistant(f.store,ai,f.queueId,'解释一下');assert.equal(result.turns.length,1);assert.equal(readReviewAssistant(f.store,f.queueId)?.turns.length,1);assert.equal(calls,1);
 assert.equal(f.store.glossary.activeTerms(f.seriesId)[0]!.term_zh,null);assert.equal(f.store.translations.getQueueItem(f.queueId)!.status,'pending');
 await askReviewAssistant(f.store,ai,f.queueId,'拼写确定吗');assert.equal(readReviewAssistant(f.store,f.queueId)?.turns.length,2);
 f.store.db.run('UPDATE paragraphs SET source_text=? WHERE id=?',['別の原文。',f.paragraphId]);assert.equal(readReviewAssistant(f.store,f.queueId),null);
});
test('assistant rejects fabricated evidence ids and does not persist failed explanation',async t=>{
 const f=setup();t.after(()=>f.store.close());const ai=fakeAi(f.store,()=>({answer:'解释',evidence:[{id:'invented',zh:'伪引用'}],english:null,gloss:null}));
 await assert.rejects(askReviewAssistant(f.store,ai,f.queueId,'解释'));assert.equal(readReviewAssistant(f.store,f.queueId),null);
});
test('confirmed English ruby survives old queue, display/export, repeat occurrences and undo',t=>{
 const f=setup();t.after(()=>f.store.close());
 const result=new DecisionService(f.store).apply(f.queueId,{kind:'term-proposal',action:'choose',zh:'Silver Gate',englishRuby:{english:'Silver Gate',gloss:'银门'},acceptVariants:false});assert.ok(result.ok);
 const term=f.store.glossary.activeTerms(f.seriesId)[0]!;assert.equal(term.term_zh,'Silver Gate');assert.match(term.notes!,/original note/);
 f.store.translations.setFinal({paragraphId:f.paragraphId,text:'Silver Gate说：Silver Gate。'});
 const exported=rubyForExport(f.store,f.paragraphId,[]);assert.equal(exported.length,2);assert.ok(exported.every(r=>r.rt==='银门'));
 assert.deepEqual(f.store.projects.getParagraphView(f.paragraphId)!.final!.ruby,exported);
 assert.equal(englishRubyMarks('没有该词','Silver Gate',englishRubyRules(f.store.db,f.seriesId)).length,0);
 assert.equal(englishRubyMarks('シルバーゲート','Silver Gateway',englishRubyRules(f.store.db,f.seriesId)).length,0);
 undoResolvedReview(f.store,f.queueId);assert.equal(englishRubyRules(f.store.db,f.seriesId).length,0);assert.equal(f.store.glossary.activeTerms(f.seriesId)[0]!.term_zh,null);
});
test('invalid English markup cannot resolve or mutate a legacy term',t=>{
 const f=setup();t.after(()=>f.store.close());const result=new DecisionService(f.store).apply(f.queueId,{kind:'term-proposal',action:'choose',englishRuby:{english:'<b>bad</b>',gloss:'错误'}});assert.equal(result.ok,false);assert.equal(f.store.translations.getQueueItem(f.queueId)!.status,'pending');assert.equal(f.store.glossary.activeTerms(f.seriesId)[0]!.term_zh,null);
});
