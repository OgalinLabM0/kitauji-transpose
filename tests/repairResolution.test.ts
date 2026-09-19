import test from 'node:test';
import assert from 'node:assert/strict';
import { naturalnessRepairIssues, parseRepairResolution } from '../src/core/workflow/repairResolution';
import { AutoArbiter } from '../src/core/workflow/autoArbiter';
import { reverifyFinal } from '../src/core/workflow/reverifyFinal';
import { TranslationPipeline } from '../src/core/workflow/pipeline';
import { fixture, fakeAi, alignmentResponse, naturalnessResponse, requestedItems } from './helpers';
import {ALIGNMENT_PENDING_MESSAGE} from '../src/core/workflow/alignmentState';

for(const uncertain of [false,true])test(`old alignment workflow state requires fresh coverage, uncertain=${uncertain}`,async t=>{
 const f=fixture();t.after(()=>f.store.close());const old=f.store.translations.setFinal({paragraphId:f.paragraphId,text:'下雨。'});
 f.store.translations.addFinding({paragraphId:f.paragraphId,workstationId:'program-check',findingType:'REVIEW:ALIGNMENT_UNCERTAIN',severity:'blocks_export',description:ALIGNMENT_PENDING_MESSAGE});
 let resolutions=0;
 const ai=fakeAi(f.store,r=>{
  if(r.system.includes('你只验收指定问题是否解决')){resolutions++;assert.fail('A text reviewer cannot certify completed workflow checks');}
  const alignment=alignmentResponse(r) as {source_coverage:{status:string}[]}|undefined;if(alignment){if(uncertain)alignment.source_coverage.forEach(c=>c.status='uncertain');return alignment;}
  const reading=naturalnessResponse(r);if(reading)return reading;
  if(r.system.includes('reviewed_ids'))return {reviewed_ids:[f.paragraphId],findings:[]};
  return {items:[{id:f.paragraphId,translation:'雨落下。',flags:[]}]};
 });
 const result=await new AutoArbiter(f.store).arbitrateAsync(f.seriesId,ai,undefined,[f.paragraphId]);
 assert.equal(resolutions,0);assert.equal(result.finalized,uncertain?0:1,JSON.stringify(result));
 if(uncertain)assert.equal(f.store.translations.latestFinal(f.paragraphId)!.id,old);
});

test('targeted resolution requires every issue and current evidence including deletion boundaries', () => {
  const issues = [{ id: 'i', type: 'REVIEW:addition', description: '增译', source_quote: '雨', target_quote: '显然' }];
  const verdict = { id: 'i', decision: 'resolved', source_quote: '雨', target_quote: '', reason: '已删除无依据副词' };
  const parse = (items: unknown[], after = '下雨。') => parseRepairResolution(JSON.stringify({ items }), '雨が降る。', after, issues).ok;
  assert.equal(parse([verdict]), true);
  assert.equal(parse([verdict], '显然下雨。'), false);
  assert.equal(parse([]), false);
  assert.equal(parse([verdict, verdict]), false);
  assert.equal(parse([{ ...verdict, id: 'other' }]), false);
  assert.equal(parse([{ ...verdict, source_quote: '雪' }]), false);
  assert.equal(parse([{ ...verdict, target_quote: '起风' }]), false);
});

test('resolution quotes follow visible ruby text but cannot cross atomic or fake deletion boundaries',()=>{
 const issues=[{id:'i',type:'REVIEW:other',description:'核对并列关系',source_quote:'雨と風',target_quote:'雨和风'}];
 const text=JSON.stringify({items:[{id:'i',decision:'resolved',source_quote:'雨と風',target_quote:'雨和风',reason:'核对原文可见的并列关系'}]});
 assert.equal(parseRepairResolution(text,'⟦1⟧雨⟦/1⟧と風','⟦1⟧雨⟦/1⟧和风',issues).ok,true);
 assert.equal(parseRepairResolution(text,'雨⟦2⟧と風','雨和风',issues).ok,false);
 assert.equal(parseRepairResolution(text,'雨と風','雨⟦2⟧和风',issues).ok,false);
 const deletion=JSON.stringify({items:[{id:'i',decision:'resolved',source_quote:'雨',target_quote:'',reason:'声称删除'}]});
 assert.equal(parseRepairResolution(deletion,'雨','⟦1⟧显⟦/1⟧然下雨',[{id:'i',type:'REVIEW:addition',description:'增译',source_quote:'雨',target_quote:'显然'}]).ok,false);
});

test('concrete naturalness diagnoses become stable, deduplicated resolution issues', () => {
  const input = [
    { quote_zh: '句法问题', reason: '成分无法衔接' },
    { quote_zh: '句法问题', reason: '成分无法衔接' },
    { quote_zh: '另一处', reason: '搭配不成立' },
  ];
  const first = naturalnessRepairIssues('p1', input);
  const second = naturalnessRepairIssues('p1', input);
  assert.equal(first.length, 2);
  assert.deepEqual(first, second);
  assert.ok(first.every(issue => issue.type === 'NATURALNESS_UNRESOLVED' && issue.source_quote === null));
});

for (const decision of ['unresolved', 'uncertain', 'resolved'] as const) test(`targeted ${decision} verdict controls adoption despite passing general reviews`, async t => {
  const f = fixture(); t.after(() => f.store.close());
  const previous = f.store.translations.setFinal({ paragraphId: f.paragraphId, text: '下雨。' });
  f.store.translations.addFinding({ paragraphId: f.paragraphId, workstationId: 'fidelity-reviewer', findingType: 'REVIEW:omission', severity: 'blocks_export', description: '遗漏雨势', evidenceJp: '雨', evidenceZh: '下雨' });
  const queue = f.store.translations.enqueue({ seriesId: f.seriesId, paragraphId: f.paragraphId, kind: 'review-block', title: '待修复', payload: {} });
  let checks = 0;
  const ai = fakeAi(f.store, request => {
    if (request.system.includes('你只验收指定问题是否解决')) {
      checks++;
      const input = JSON.parse(request.user);
      assert.equal(input.before, '下雨。'); assert.equal(input.after, '开始下雨。');
      assert.ok(!request.user.includes('模拟验收通过'));
      return { items: input.issues.map((i: {id:string}) => ({ id: i.id, decision, source_quote: '雨', target_quote: '下雨', reason: '独立检查指定问题' })) };
    }
    const simple = alignmentResponse(request) ?? naturalnessResponse(request); if (simple) return simple;
    if (request.system.includes('reviewed_ids')) return { reviewed_ids: requestedItems(request).map(p => p.id), findings: [] };
    return { items: [{ id: f.paragraphId, translation: '开始下雨。', flags: [] }] };
  });
  const result = await new AutoArbiter(f.store).arbitrateAsync(f.seriesId, ai);
  assert.equal(checks, 1);
  assert.equal(result.finalized, decision === 'resolved' ? 1 : 0);
  assert.equal(f.store.translations.getQueueItem(queue)?.status, decision === 'resolved' ? 'resolved' : 'pending');
  if (decision !== 'resolved') assert.equal(f.store.translations.latestFinal(f.paragraphId)?.id, previous);
  else assert.ok(f.store.db.get("SELECT id FROM activity_log WHERE workstation_id='repair-resolution-reviewer' AND message LIKE '%previousFinalId%'"));
});

for (const decision of ['unresolved', 'uncertain', 'resolved', 'not_applicable'] as const) test(`new naturalness keep still requires old concrete issue resolution: ${decision}`, async t => {
  const f = fixture(); t.after(() => f.store.close());
  const previous = f.store.translations.setFinal({ paragraphId: f.paragraphId, text: '下雨。' });
  f.store.translations.addFinding({ paragraphId: f.paragraphId, workstationId: 'naturalness-reviewer', findingType: 'NATURALNESS_UNRESOLVED', severity: 'blocks_export', description: '成分无法衔接', evidenceZh: '下雨' });
  const queue = f.store.translations.enqueue({ seriesId: f.seriesId, paragraphId: f.paragraphId, kind: 'review-block', title: '待修复', payload: {} });
  let resolutionCalls = 0;
  const ai = fakeAi(f.store, request => {
    if (request.system.includes('你只检查当前中文译稿')) {
      const input = JSON.parse(request.user);
      return input.draft === '下雨。' ? { id: input.id, decision: 'edit', issues: [{ quote_zh: '下雨', reason: '成分无法衔接', constraint: '保留含义' }] } : { id: input.id, decision: 'keep', issues: [] };
    }
    if (request.system.includes('你只验收指定问题是否解决')) {
      resolutionCalls++;
      const input = JSON.parse(request.user);
      return { items: input.issues.map((i: { id: string }) => ({ id: i.id, decision, source_quote: '雨', target_quote: '下雨', reason: '具体验收结果' })) };
    }
    const simple = alignmentResponse(request);
    if (simple) return simple;
    if (request.system.includes('reviewed_ids')) return { reviewed_ids: requestedItems(request).map(p => p.id), findings: [] };
    return { items: [{ id: f.paragraphId, translation: '开始下雨。', flags: [] }] };
  });
  const result = await new AutoArbiter(f.store).arbitrateAsync(f.seriesId, ai);
  assert.equal(resolutionCalls, 1);
  assert.equal(result.finalized, decision === 'resolved' || decision === 'not_applicable' ? 1 : 0);
  if (decision === 'resolved' || decision === 'not_applicable') assert.notEqual(f.store.translations.latestFinal(f.paragraphId)?.id, previous);
  else assert.equal(f.store.translations.latestFinal(f.paragraphId)?.id, previous);
  if (decision === 'resolved' || decision === 'not_applicable') assert.equal(f.store.translations.getQueueItem(queue)?.status, 'resolved');
  else assert.equal(f.store.translations.getQueueItem(queue)?.status, 'pending');
});

for (const decision of ['unresolved', 'uncertain', 'resolved', 'not_applicable'] as const) test(`pipeline preserves old naturalness issue after editor keep: ${decision}`, async t => {
  const f = fixture(); t.after(() => f.store.close());
  let resolutionCalls = 0;
  const ai = fakeAi(f.store, request => {
    if (request.system.includes('你只检查当前中文译稿')) {
      const input = JSON.parse(request.user);
      return input.draft === '下雨。' ? { id: input.id, decision: 'edit', issues: [{ quote_zh: '下雨', reason: '成分无法衔接', constraint: '保留含义' }] } : { id: input.id, decision: 'keep', issues: [] };
    }
    if (request.system.includes('你只验收指定问题是否解决')) {
      resolutionCalls++;
      const input = JSON.parse(request.user);
      return { items: input.issues.map((i: { id: string }) => ({ id: i.id, decision, source_quote: '雨', target_quote: '下雨', reason: '具体验收结果' })) };
    }
    const aligned = alignmentResponse(request);
    if (aligned) return aligned;
    if (request.system.includes('reviewed_ids')) return { reviewed_ids: requestedItems(request).map(p => p.id), findings: [] };
    return { items: [{ id: f.paragraphId, translation: request.user.includes('"draft"') ? '开始下雨。' : '下雨。', flags: [] }] };
  });
  const result = await new TranslationPipeline(f.store, ai).run([f.paragraphId]);
  assert.equal(resolutionCalls, 1);
  assert.equal(result.autoAccepted, decision === 'resolved' || decision === 'not_applicable' ? 1 : 0);
  const final = f.store.translations.latestFinal(f.paragraphId)!;
  assert.equal(final.auto_accepted, decision === 'resolved' || decision === 'not_applicable' ? 1 : 0);
  assert.equal(final.final_text, '开始下雨。');
  if (decision === 'resolved' || decision === 'not_applicable') assert.ok(f.store.db.get('SELECT final_id FROM final_audit_receipts WHERE final_id=?', [final.id]));
  else {
    assert.equal(f.store.db.get('SELECT final_id FROM final_audit_receipts WHERE final_id=?', [final.id]), undefined);
    assert.ok(f.store.translations.openFindings(f.paragraphId).some(issue => issue.finding_type === 'NATURALNESS_UNRESOLVED' && issue.evidence_zh === '下雨' && issue.description === '成分无法衔接'));
  }
});

for (const decision of ['unresolved', 'uncertain', 'resolved', 'not_applicable', 'generic', 'changed'] as const) test(`recheck cannot clear a concrete reading issue on general keep: ${decision}`, async t => {
  const f=fixture();t.after(()=>f.store.close());
  const before=f.store.translations.setFinal({paragraphId:f.paragraphId,text:'开始下雨。'});
  const finding=f.store.translations.addFinding({paragraphId:f.paragraphId,workstationId:'naturalness-reviewer',findingType:'NATURALNESS_UNRESOLVED',severity:'blocks_export',description:'成分无法衔接',...(decision==='generic'?{}:{evidenceZh:'下雨'})});
  let calls=0;
  const ai=fakeAi(f.store,request=>{
    if(request.system.includes('你只验收指定问题是否解决')){
      calls++;const input=JSON.parse(request.user);
      assert.equal(input.issues[0].target_quote,'下雨');
      assert.equal(input.issues[0].description,'成分无法衔接');
      if(decision==='changed')f.store.translations.setFinal({paragraphId:f.paragraphId,text:'用户最新稿。',confirmedByUser:true});
      return {items:input.issues.map((i:{id:string})=>({id:i.id,decision:decision==='changed'?'resolved':decision,source_quote:'雨',target_quote:'下雨',reason:'指定问题独立复核'}))};
    }
    const simple=alignmentResponse(request)??naturalnessResponse(request);if(simple)return simple;
    if(request.system.includes('reviewed_ids'))return {reviewed_ids:requestedItems(request).map(p=>p.id),findings:[]};
    throw Error('Unexpected workstation');
  });
  const result=await reverifyFinal(f.store,ai,f.paragraphId);
  const accepted=['resolved','not_applicable','generic'].includes(decision);
  assert.equal(result.ok,accepted);assert.equal(calls,decision==='generic'?0:1);
  assert.equal(f.store.translations.openFindings(f.paragraphId).some(i=>i.id===finding),!accepted);
  if(decision==='changed')assert.equal(f.store.translations.latestFinal(f.paragraphId)?.final_text,'用户最新稿。');
  else if(!accepted)assert.equal(f.store.translations.latestFinal(f.paragraphId)?.id,before);
});

test('pipeline resolution cannot overwrite a final changed during its callback', async t => {
  const f = fixture(); t.after(() => f.store.close());
  let changed = false;
  const ai = fakeAi(f.store, request => {
    if (request.system.includes('你只检查当前中文译稿')) {
      const input = JSON.parse(request.user);
      return input.draft === '下雨。' ? { id: input.id, decision: 'edit', issues: [{ quote_zh: '下雨', reason: '成分无法衔接', constraint: '保留含义' }] } : { id: input.id, decision: 'keep', issues: [] };
    }
    if (request.system.includes('你只验收指定问题是否解决')) {
      const input = JSON.parse(request.user);
      if (!changed) { changed = true; f.store.translations.setFinal({ paragraphId: f.paragraphId, text: '用户当前稿。', confirmedByUser: true }); }
      return { items: input.issues.map((i: { id: string }) => ({ id: i.id, decision: 'resolved', source_quote: '雨', target_quote: '下雨', reason: '具体验收结果' })) };
    }
    const aligned = alignmentResponse(request);
    if (aligned) return aligned;
    if (request.system.includes('reviewed_ids')) return { reviewed_ids: requestedItems(request).map(p => p.id), findings: [] };
    return { items: [{ id: f.paragraphId, translation: request.user.includes('"draft"') ? '开始下雨。' : '下雨。', flags: [] }] };
  });
  await new TranslationPipeline(f.store, ai).run([f.paragraphId]);
  assert.equal(f.store.translations.latestFinal(f.paragraphId)?.final_text, '用户当前稿。');
});


for (const changed of [false,true]) test(`obsolete quote yields current repair target only while source and draft stay current: ${changed}`,async t=>{
 const f=fixture();t.after(()=>f.store.close());
 const before=f.store.translations.setFinal({paragraphId:f.paragraphId,text:'开始下雨。'});
 const old=f.store.translations.addFinding({paragraphId:f.paragraphId,workstationId:'naturalness-reviewer',findingType:'NATURALNESS_UNRESOLVED',severity:'blocks_export',description:'旧稿诊断',evidenceZh:'旧的表达'});
 const ai=fakeAi(f.store,request=>{
  if(request.system.includes('你只验收指定问题是否解决')){
   const input=JSON.parse(request.user);
   if(changed)f.store.translations.setFinal({paragraphId:f.paragraphId,text:'用户最新稿。',confirmedByUser:true});
   return {items:input.issues.map((i:{id:string})=>({id:i.id,decision:'unresolved',source_quote:'雨',target_quote:'开始下雨',reason:'当前候选仍有具体问题'}))};
  }
  const simple=alignmentResponse(request)??naturalnessResponse(request);if(simple)return simple;
  if(request.system.includes('reviewed_ids'))return {reviewed_ids:requestedItems(request).map(p=>p.id),findings:[]};
  throw Error('unexpected');
 });
 const result=await reverifyFinal(f.store,ai,f.paragraphId);assert.equal(result.ok,false);
 assert.equal(result.diagnosticIds?.length??0,changed?0:1);
 assert.ok(f.store.translations.openFindings(f.paragraphId).some(f=>f.id===old));
 if(!changed){const target=f.store.translations.openFindings(f.paragraphId).find(f=>result.diagnosticIds?.includes(f.id))!;assert.equal(target.evidence_zh,'开始下雨');assert.equal(target.description,'当前候选仍有具体问题');assert.equal(f.store.translations.latestFinal(f.paragraphId)?.id,before);}
 else assert.equal(f.store.translations.latestFinal(f.paragraphId)?.final_text,'用户最新稿。');
});


test('partial failed resolution batch cannot replace all outstanding repair targets',async t=>{
 const f=fixture();t.after(()=>f.store.close());
 f.store.translations.setFinal({paragraphId:f.paragraphId,text:'开始下雨。'});
 for(let i=0;i<4;i++)f.store.translations.addFinding({paragraphId:f.paragraphId,workstationId:'naturalness-reviewer',findingType:'NATURALNESS_UNRESOLVED',severity:'blocks_export',description:`旧稿问题${i}`,evidenceZh:'旧的表达'});
 const ai=fakeAi(f.store,request=>{
  if(request.system.includes('你只验收指定问题是否解决')){const input=JSON.parse(request.user);return {items:input.issues.map((i:{id:string})=>({id:i.id,decision:'unresolved',source_quote:'雨',target_quote:'开始下雨',reason:'当前问题仍在'}))};}
  const simple=alignmentResponse(request)??naturalnessResponse(request);if(simple)return simple;
  if(request.system.includes('reviewed_ids'))return {reviewed_ids:requestedItems(request).map(p=>p.id),findings:[]};
  throw Error('unexpected');
 });
 const result=await reverifyFinal(f.store,ai,f.paragraphId);assert.equal(result.ok,false);assert.equal(result.diagnosticIds,undefined);assert.equal(f.store.translations.openFindings(f.paragraphId).length,4);
});
