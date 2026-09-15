import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { ProjectStore } from '../src/core/db';
import { importEpub } from '../src/core/epub/epubImport';
import { parsePreRead, parseTermExtract, parseTermProposal } from '../src/core/ai/protocol';
import { containsVisibleQuote, validNameQuote, visibleNameSource } from '../src/core/validation/nameEvidence';
import { observeWithConflicts } from '../src/core/workflow/characterConflicts';
import { PrepRunner } from '../src/core/workflow/prepRunner';
import { fixture, fakeAi } from './helpers';
import { importTxt } from '../src/core/txt/txtImport';
import { PreReadCheckpoint } from '../src/core/workflow/preReadCheckpoint';
import { fixtureQuote, reviewModelFields } from './helpers/reviewedModelFacts';

test('name evidence permits bounded military, academic and workplace title suffixes',()=>{
  for(const suffix of ['中尉','魔導中尉','陸軍大佐殿','海軍少将閣下','准教授','社長','部長']){
    const source=`「こちらは、アリス${suffix}だ。」`;
    assert.equal(validNameQuote('アリス',source,source),true,suffix);
  }
  const source='「こちらは増援指揮官、ターニャ・デグレチャフ魔導中尉だ。生き残りの先任は？」';
  assert.equal(validNameQuote('ターニャ・デグレチャフ',source,source),true);
});

test('title suffix recognition does not admit cropped words, arbitrary compounds or fabricated quotes',()=>{
  for(const [name,source] of [['律','法律教授が来た。'],['アリス','アリス魔導中尉団が来た。'],['アリス','アリス商店がある。'],['田','田中将棋がある。'],['アリス','アリス未知中尉だ。']]){
    assert.equal(validNameQuote(name!,source!,source!),false,source);
  }
  assert.equal(validNameQuote('アリス','アリス中尉','アリス中尉団が来た。'),false);
  assert.equal(validNameQuote('アリス','アリス大佐','アリス中尉だ。'),false);
  assert.equal(validNameQuote('アリス','アリス魔導中尉','アリ⟦7⟧ス魔導中尉だ。'),false);
});

test('formal titles before names require their own full source boundary',()=>{
  for(const title of ['教皇特使','王室大使','教授','海軍大佐','社長']){
    const source=`その、${title}アルノー・アモーリの言葉。`;
    assert.equal(validNameQuote('アルノー・アモーリ',source,source),true,title);
  }
  for(const source of ['架空教皇特使アルノーの言葉。','法律教授アルノーの言葉。','特使アルノー商会の言葉。']){
    assert.equal(validNameQuote('アルノー','アルノー',source),false,source);
  }
  assert.equal(validNameQuote('律','律','教授法律を読む。'),false);
  assert.equal(validNameQuote('アモーリ','アモーリ','教皇特使アルノーアモーリだ。'),false);
});

test('name evidence checks full source boundaries, exact quotes and current candidate evidence', () => {
  const source = '法律を学ぶ。律という青年だ。';
  assert.equal(validNameQuote('律', '律という青年', source), true);
  assert.equal(validNameQuote('律', '律', '法律を学ぶ。'), false);
  assert.equal(validNameQuote('律', '旋律', '旋律が響く。'), false);
  assert.equal(validNameQuote('空', '空', '空港へ行く。'), false);
  assert.equal(validNameQuote('蒼', '蒼君', '蒼君が来た。'), true);
  assert.equal(validNameQuote('律', '律先生', '律先生が来た。'), true);
  assert.equal(validNameQuote('律', '律先生', '法律先生が来た。'), false);
  const scope = [{id:'p1',seriesOrdinal:1,sourceText:source},{id:'p2',seriesOrdinal:2,sourceText:'律は走った。'}];
  const candidate = {name_jp:'律',evidence_ids:['p1'], name_evidence:{paragraph_id:'p1',quote:'律という青年'}};
  const response = (c: unknown) => JSON.stringify({reviewed_ids:['p1','p2'],characters:[c],relationship_events:[],plot_events:[],knowledge_change_candidates:[]});
  assert.equal(parsePreRead(response(candidate), scope).ok, true);
  for (const evidence of [{paragraph_id:'foreign',quote:'律'},{paragraph_id:'p2',quote:'律は'},{paragraph_id:'p1',quote:'律という少女'},{paragraph_id:'p1',quote:'法律'}]) {
    assert.equal(parsePreRead(response({...candidate,name_evidence:evidence}), scope).ok, false);
  }
  assert.equal(parsePreRead(response({name_jp:'律',evidence_ids:['p1']}), scope).ok, true, 'legacy records remain readable');
});

test('known identity discards only an optional literal receipt without accepting it as new name evidence', () => {
  const paragraphs = [{ id: 'p', seriesOrdinal: 8, sourceText: '冒険者レイナちゃんが来た。' }];
  const candidate = { name_jp: 'レイナ', evidence_ids: ['p'], name_evidence: { paragraph_id: 'p', quote: '冒険者レイナちゃん' } };
  const encode = (c: unknown) => JSON.stringify({ reviewed_ids: ['p'], characters: [c], relationship_events: [], plot_events: [], knowledge_change_candidates: [] });
  const rejected = parsePreRead(encode(candidate), paragraphs, ['レイナ']);
  assert.equal(rejected.ok, true);
  if (rejected.ok) assert.equal(rejected.value.characters[0]?.name_evidence, undefined);
  const unknown = parsePreRead(encode(candidate), paragraphs);
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.doesNotMatch(unknown.error.message, /省略整个name_evidence/);
  const { name_evidence, ...existing } = candidate;
  const corrected = parsePreRead(encode(existing), paragraphs, ['レイナ']);
  assert.equal(corrected.ok, true);
  if (corrected.ok) assert.equal(corrected.value.characters[0]?.name_evidence, undefined);
  assert.equal(parsePreRead(encode({ ...existing, voice_notes: '明るい声' }), paragraphs, ['レイナ']).ok, false, 'known identity never certifies voice fields');
  for (const name_evidence of [{ paragraph_id: 'foreign', quote: paragraphs[0]!.sourceText }, { paragraph_id: 'p', quote: 'レイナは帰った。' }]) {
    assert.equal(parsePreRead(encode({ ...existing, name_evidence }), paragraphs, ['レイナ']).ok, false, 'known identity cannot certify foreign or fabricated quotes');
  }
  assert.equal(parsePreRead(encode(candidate), [{ ...paragraphs[0]!, sourceText: '誰もいない。' }], ['レイナ']).ok, false);
});

test('katakana address endings use the actual source boundary, across names and markup', () => {
  for (const name of ['カナタ', 'ミリア', 'ユリウス']) {
    for (const suffix of ['トヤラ', 'サン', 'クン', 'チャン', 'サマ', 'ドノ']) {
      const source = `「${name}${suffix}、ココニ来イ！」`;
      assert.equal(validNameQuote(name, name, source), true, source);
      assert.equal(validNameQuote(name, name, `「${name}${suffix}カンパニー」`), false);
    }
  }
  assert.equal(validNameQuote('カナタ', 'カナタ', '「カナ⟦1⟧タ⟦/1⟧トヤラ、ドウダ？」'), true);
  assert.equal(validNameQuote('カナタ', 'カナタ', '「カナ⟦1⟧タトヤラ、ドウダ？」'), false);
  assert.equal(validNameQuote('律', '律', '法律サン、読ンダ？'), false);
  assert.equal(validNameQuote('アリス', 'アリスサン', 'アリスサン商会だ。'), false);
});

test('name evidence projects balanced inline markers without crossing atomic nodes', () => {
  const split = '⟦1⟧彩音⟦/1⟧⟦2⟧レイナ⟦/2⟧は来た。';
  assert.equal(visibleNameSource(split), '彩音レイナは来た。');
  assert.equal(validNameQuote('彩音レイナ', '彩音レイナ', visibleNameSource(split)), true);
  assert.equal(validNameQuote('彩音', '彩音', visibleNameSource(split)), false);
  assert.equal(validNameQuote('彩音レイナ', '彩音レイナ', visibleNameSource('彩音⟦3⟧レイナ')), false);
  assert.equal(validNameQuote('彩音レイナ', '彩音レイナ', visibleNameSource('彩音⟦3⟧レイナ⟦/3⟧')), true);
  assert.equal(validNameQuote('彩音レイナ', '彩音レイナ', visibleNameSource('彩音⟦3⟧レイナ⟦/3⟧。')), true);
  const atomicQuote = '\uFFFC（モンスターをミンチにしてニッコニコのレイナさん）';
  assert.equal(containsVisibleQuote(atomicQuote, atomicQuote), true, 'complete quote may retain an atomic boundary');
  assert.equal(validNameQuote('レイナ', atomicQuote, atomicQuote), true, 'name itself remains contiguous inside the quote');
  assert.equal(validNameQuote('彩音レイナ', '彩\uFFFC音レイナ', '彩\uFFFC音レイナ'), false, 'name cannot bridge an atomic boundary');
  assert.equal(containsVisibleQuote(atomicQuote, '\uFFFC'), false, 'atomic-only quote remains invalid');
  assert.equal(validNameQuote('彩音レイナ', '⟦1⟧⟦/1⟧', '彩音レイナ'), false);
  const paragraphs = [{ id: 'p', sourceText: split, seriesOrdinal: 1 }];
  const response = JSON.stringify({ reviewed_ids: ['p'], characters: [{ name_jp: '彩音レイナ', evidence_ids: ['p'], name_evidence: { paragraph_id: 'p', quote: '彩音レイナ' } }], relationship_events: [], plot_events: [], knowledge_change_candidates: [] });
  assert.equal(parsePreRead(response, paragraphs).ok, true);
  const atomic = JSON.stringify({ reviewed_ids: ['p'], characters: [{ name_jp: '彩音レイナ', evidence_ids: ['p'], name_evidence: { paragraph_id: 'p', quote: '彩音レイナ' } }], relationship_events: [], plot_events: [], knowledge_change_candidates: [] });
  assert.equal(parsePreRead(atomic, [{ id: 'p', sourceText: '彩音⟦3⟧レイナ', seriesOrdinal: 1 }]).ok, false);
  assert.equal(visibleNameSource('⟦/1⟧彩音⟦1⟧レイナ⟦/1⟧'), '\uFFFC彩音\uFFFCレイナ\uFFFC');
  assert.equal(visibleNameSource('⟦1⟧彩音⟦1⟧レイナ⟦/1⟧'), '\uFFFC彩音\uFFFCレイナ\uFFFC');
  assert.equal(visibleNameSource('⟦1⟧彩⟦2⟧音⟦/1⟧レイナ⟦/2⟧'), '\uFFFC彩\uFFFC音\uFFFCレイナ\uFFFC');
  assert.equal(visibleNameSource('⟦1⟧彩⟦2⟧音⟦/2⟧⟦3⟧レイナ⟦/3⟧⟦/1⟧'), '彩音レイナ');
  assert.equal(visibleNameSource('⟦1⟧彩音⟦2⟧レイナ⟦/1⟧'), '彩音\uFFFCレイナ');
  assert.equal(visibleNameSource('⟦1⟧彩⟦/1⟧⟦1⟧音⟦/1⟧'), '\uFFFC彩\uFFFC\uFFFC音\uFFFC');
});

test('unknown-name retry points only to existing independent source positions without accepting the bad quote', () => {
  const paragraphs=[{id:'bad',seriesOrdinal:1,sourceText:'ゆきのん可愛い。'},{id:'good',seriesOrdinal:2,sourceText:'ゆきのん先輩、ありがとう。'}];
  const raw={reviewed_ids:['bad','good'],characters:[{name_jp:'ゆきのん',evidence_ids:['bad'],name_evidence:{paragraph_id:'bad',quote:'ゆきのん'}}],relationship_events:[],plot_events:[],knowledge_change_candidates:[]};
  const result=parsePreRead(JSON.stringify(raw),paragraphs);
  assert.equal(result.ok,false);
  if(!result.ok){assert.match(result.error.message,/段落ID：\["good"\]/);assert.match(result.error.message,/不证明人物身份/);}
  const noPosition=parsePreRead(JSON.stringify({...raw,reviewed_ids:['bad']}),paragraphs.slice(0,1));
  assert.equal(noPosition.ok,false);
  if(!noPosition.ok)assert.doesNotMatch(noPosition.error.message,/段落ID：/);
});

test('EPUB marker-split name and gender evidence survives preread persistence', async t => {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>');
  zip.file('OPS/book.opf', '<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>測試</dc:title><dc:language>ja</dc:language></metadata><manifest><item id="c" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="n" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="c"/></spine></package>');
  zip.file('OPS/nav.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml#chapter">第一章</a></li></ol></nav></body></html>');
  zip.file('OPS/chapter.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1 id="chapter">第一章</h1><p><span>彩音</span><span>レイナ</span>は<span>少</span><span>女</span>だ。</p></body></html>');
  const store = new ProjectStore(':memory:'); t.after(() => store.close());
  const imported = await importEpub(store, 'markers.epub', await zip.generateAsync({ type: 'uint8array' }));
  const ids = store.projects.listParagraphIdsByVolume(imported.volumeId);
  const target = ids.find(id => store.projects.getParagraph(id)!.sourceText.includes('彩音'))!;
  const before = store.projects.getParagraph(target)!;
  const sourceBefore = store.db.get('SELECT source_text,source_hash FROM paragraphs WHERE id=?', [target]);
  const ai = fakeAi(store, request => {
    const input = JSON.parse(request.user) as { paragraphs: { id: string; source: string }[] };
    assert.equal(input.paragraphs.find(p => p.id === target)!.source, '彩音レイナは少女だ。', 'preread sees visible text, not export markup');
    if (request.system.includes('只提取本次日文paragraphs中的人物')) return {
      reviewed_ids: input.paragraphs.map(p => p.id),
      characters: [{ name_jp: '彩音レイナ', evidence_ids: [target], name_evidence: { paragraph_id: target, quote: '彩音レイナ' }, gender: 'female', gender_confidence: 1, gender_evidence: '少女' }],
    };
    return { reviewed_ids: input.paragraphs.map(p => p.id), relationship_events: [], plot_events: [], knowledge_change_candidates: [] };
  });
  await new PrepRunner(store, ai).preRead(imported.volumeId);
  const after = store.projects.getParagraph(target)!;
  assert.equal(after.sourceText, before.sourceText);
  assert.deepEqual(store.db.get('SELECT source_text,source_hash FROM paragraphs WHERE id=?', [target]), sourceBefore);
  const character = store.knowledge.findByName(imported.seriesId, '彩音レイナ', Number.MAX_SAFE_INTEGER);
  assert.ok(character);
  assert.equal(store.knowledge.characterAt(character!, Number.MAX_SAFE_INTEGER).gender, null);
  await reviewModelFields(store,imported.volumeId,[{characterId:character!.id,field:'gender',value:{gender:'female',confidence:1,evidenceIds:[target]},evidence:[{paragraph_id:target,quote:'少女'}],attribution:[{paragraph_id:target,quote:'彩音レイナは少女だ。'}],scope:'durable'}]);
  assert.equal(store.knowledge.characterAt(character!, Number.MAX_SAFE_INTEGER).gender, 'female');
  assert.ok(store.db.get('SELECT source_proof FROM character_name_observations WHERE character_id=?', [character!.id]));
  assert.ok(store.db.get("SELECT 1 FROM character_field_history WHERE character_id=? AND field='gender'", [character!.id]));
});

test('visible field evidence rejects empty, atomic and invented quotes', () => {
  const paragraphs = [{ id: 'p', sourceText: '彩音レイナは⟦1⟧少⟦/1⟧⟦2⟧女⟦/2⟧だ。⟦3⟧', seriesOrdinal: 1 }];
  const parse = (quote: string) => parsePreRead(JSON.stringify({ reviewed_ids: ['p'], characters: [{ name_jp: '彩音レイナ', evidence_ids: ['p'], speech_register: 'casual', field_evidence: [{ field: 'speech_register', paragraph_id: 'p', quote }] }], relationship_events: [], plot_events: [], knowledge_change_candidates: [] }), paragraphs);
  assert.equal(parse('少女だ。').ok, true);
  for (const quote of ['⟦1⟧⟦/1⟧', '⟦3⟧', '少年だ。']) assert.equal(parse(quote).ok, false, quote);
});

test('term extraction and proposal evidence accept visible marker splits but reject atomic crossings', () => {
  const paragraphs = [{ id: 'p', sourceText: 'オ⟦1⟧ーラ⟦/1⟧を使う。' }];
  const extracted = parseTermExtract(JSON.stringify({ reviewed_ids: ['p'], terms: [{ term_jp: 'オーラ', term_type: 'concept', sense_identity: 'power', occurrence_paragraph_ids: ['p'], confidence: 1, conflicts: [] }] }), paragraphs);
  assert.equal(extracted.ok, true);
  const blocked = parseTermExtract(JSON.stringify({ reviewed_ids: ['p'], terms: [{ term_jp: 'オーラ', term_type: 'concept', sense_identity: '', occurrence_paragraph_ids: ['p'], confidence: 1, conflicts: [] }] }), [{ id: 'p', sourceText: 'オ⟦1⟧ーラ' }]);
  assert.equal(blocked.ok, false);
  const proposal = parseTermProposal(JSON.stringify({ proposals: [{ term_jp: 'オーラ', candidates: [{ zh: 'オーラ' }], variants: [{ variant_jp: 'オーラ', zh: 'オーラ', variant_type: 'contextual', evidence_ids: ['p'] }] }] }), ['オーラ'], paragraphs);
  assert.equal(proposal.ok, true);
});

test('gender retry identifies literal quote positions without automatically changing evidence', () => {
  const paragraphs = [{ id: 'name', sourceText: '彩音レイナは来た。', seriesOrdinal: 1 }, { id: 'gender', sourceText: '⟦1⟧少⟦/1⟧⟦2⟧女⟦/2⟧だった。', seriesOrdinal: 2 }];
  const raw = JSON.stringify({ reviewed_ids: ['name', 'gender'], characters: [{ name_jp: '彩音レイナ', evidence_ids: ['name'], gender: 'female', gender_evidence: '少女だった。' }], relationship_events: [], plot_events: [], knowledge_change_candidates: [] });
  const result = parsePreRead(raw, paragraphs);
  assert.equal(result.ok, false);
  if (!result.ok) { assert.match(result.error.message, /"literal_quote_ids":\["gender"\]/); assert.match(result.error.message, /不证明引文说的是该人物/); }
});

test('name observation has an independent date while full source and field timelines stay bound', async t => {
  const f=fixture('雨が降る。\n\n律という青年が来た。\n\n律は僕と言った。');t.after(()=>f.store.close());
  const input={seriesId:f.seriesId,introducedVolume:1,nameJp:'律',firstPersonType:'boku'};
  const fields={first_person_type:[f.ids[2]!]};
  const id=observeWithConflicts(f.store,input,[f.ids[1]!,f.ids[2]!],fields,{},f.ids);
  const row=f.store.knowledge.getCharacter(id)!;
  assert.equal(f.store.knowledge.nameCurrent(row,2),false,'old full-batch boundary is preserved');
  await reviewModelFields(f.store,f.volumeId,[{characterId:id,field:'first_person_type',value:'boku',evidence:[fixtureQuote(f.store,f.ids[2]!)],attribution:[fixtureQuote(f.store,f.ids[2]!)],scope:'durable'}]);
  observeWithConflicts(f.store,input,[f.ids[1]!,f.ids[2]!],fields,{},f.ids,[],{paragraph_id:f.ids[1]!,quote:'律という青年'});
  assert.equal(f.store.knowledge.nameCurrent(row,1),false);
  assert.equal(f.store.knowledge.nameCurrent(row,2),true);
  assert.equal(f.store.knowledge.characterAt(row,2).first_person_type,null);
  assert.equal(f.store.knowledge.characterAt(row,3).first_person_type,'boku');
  const observations=f.store.db.all<{valid_from_para:number;source_proof:string}>('SELECT valid_from_para,source_proof FROM character_name_observations WHERE character_id=?',[id]);
  assert.deepEqual(observations.map(o=>o.valid_from_para).sort(),[2,3]);
  assert.equal(JSON.parse(observations.find(o=>o.valid_from_para===2)!.source_proof).ids.length,3);
  f.store.db.run('UPDATE paragraphs SET source_text=? WHERE id=?',['別の後文。',f.ids[2]!]);
  assert.equal(f.store.knowledge.nameCurrent(row,2),false,'later model input changes still invalidate the name proof');
});

test('repository rejects name evidence outside source scope, false names and foreign series without writes', t=>{
 const f=fixture('律は来た。\n\n雨が降る。');t.after(()=>f.store.close());
 const input={seriesId:f.seriesId,introducedVolume:1,nameJp:'律'};
 for(const evidence of [{paragraph_id:'foreign',quote:'律'},{paragraph_id:f.ids[1]!,quote:'律'},{paragraph_id:f.ids[0]!,quote:'律は帰った'}]){
  assert.throws(()=>f.store.knowledge.observeCharacter(input,[f.ids[0]!],undefined,{},f.ids,[],evidence),/姓名证据/);
 }
 assert.throws(()=>f.store.knowledge.observeCharacter(input,[f.ids[0]!],undefined,{},[f.ids[1]!],[],{paragraph_id:f.ids[0]!,quote:'律'}),/姓名证据/);
 const other=importTxt(f.store,'other.txt',new TextEncoder().encode('律は来た。'));
 const foreignId=f.store.projects.listParagraphIdsByVolume(other.volumeId)[0]!;
 assert.throws(()=>f.store.knowledge.observeCharacter(input,[foreignId],undefined,{},[foreignId],[],{paragraph_id:foreignId,quote:'律'}),/不属于当前作品/);
 assert.equal(f.store.knowledge.listCharacters(f.seriesId).length,0);
});

test('earlier alias cannot date a later revealed canonical identity',t=>{
 const f=fixture('仮名はユキだった。\n\n本名は千鶴だった。');t.after(()=>f.store.close());
 assert.throws(()=>f.store.knowledge.observeCharacter({seriesId:f.seriesId,introducedVolume:1,nameJp:'千鶴'},f.ids,undefined,{},f.ids,[],{paragraph_id:f.ids[0]!,quote:'ユキ'}),/姓名证据/);
 assert.equal(f.store.knowledge.listCharacters(f.seriesId).length,0);
});

test('production pre-reader passes distinct name evidence without advancing later voice knowledge',async t=>{
 const f=fixture('律という青年が来た。\n\n律は僕と言った。');t.after(()=>f.store.close());
 const ai=fakeAi(f.store,r=>{
  const input=JSON.parse(r.user);const ids=input.paragraphs.map((p:{id:string})=>p.id);
  if(r.system.includes('只提取本次日文paragraphs中的人物'))return {reviewed_ids:ids,characters:[{name_jp:'律',evidence_ids:ids,name_evidence:{paragraph_id:ids[0],quote:'律という青年'},first_person_type:'boku',field_evidence:[{field:'first_person_type',paragraph_id:ids[1],quote:'律は僕と言った'}]}]};
  return {reviewed_ids:ids,relationship_events:[],plot_events:[],knowledge_change_candidates:[]};
 });
 await new PrepRunner(f.store,ai).preRead(f.volumeId);
 const character=f.store.knowledge.findByName(f.seriesId,'律',1);
 assert.ok(character);assert.equal(f.store.knowledge.characterAt(character,1).first_person_type,null);
 await reviewModelFields(f.store,f.volumeId,[{characterId:character.id,field:'first_person_type',value:'boku',evidence:[{paragraph_id:f.ids[1]!,quote:'律は僕と言った'}],attribution:[fixtureQuote(f.store,f.ids[1]!)],scope:'durable'}]);
 assert.equal(f.store.knowledge.characterAt(character,1).first_person_type,null);
 assert.equal(f.store.knowledge.characterAt(character,2).first_person_type,'boku');
});

test('production preread continues across full-name, omitted alias and katakana short-name observations', async t => {
  const name = 'ミリア・ローズ';
  const lines = Array.from({ length: 65 }, (_, i) => i === 0 ? `${name}が来た。` : i === 32 || i === 64 ? '「ミリアトヤラ、準備ハイイカ？」' : `風が吹く。${i}。`);
  const f = fixture(lines.join('\n\n')); t.after(() => f.store.close());
  const batches: string[][] = [];
  let calls = 0;
  const ai = fakeAi(f.store, request => {
    calls++;
    const input = JSON.parse(request.user);
    const ids = input.paragraphs.map((p: { id: string }) => p.id);
    if (request.system.includes('只提取本次日文paragraphs中的人物')) {
      batches.push(ids);
      const first = input.paragraphs[0];
      if (first.id !== f.ids[0]) assert.ok(input.known_names.includes(name));
      return { reviewed_ids: ids, characters: [{ name_jp: first.id === f.ids[64] ? 'ミリア' : name, aliases: first.id === f.ids[32] ? ['ミリア'] : [], evidence_ids: [first.id], name_evidence: { paragraph_id: first.id, quote: first.source } }] };
    }
    return { reviewed_ids: ids, relationship_events: [], knowledge_change_candidates: [], plot_events: [{ summary_jp: `${name}が登場する。`, at_para: input.paragraphs.at(-1).seriesOrdinal, character_names: [name], evidence_ids: [ids[0]] }] };
  });
  await new PrepRunner(f.store, ai).preRead(f.volumeId);
  assert.equal(calls, 6, 'three complete batches without regeneration or automatic splitting');
  assert.deepEqual(batches.map(b => b.length), [32, 32, 1]);
  assert.equal(f.store.projects.prepDoneChapters('preread', f.volumeId).size, 1);
  const characters = f.store.knowledge.listCharacters(f.seriesId);
  assert.equal(characters.length, 1, 'short form stays bound to the existing identity');
  assert.equal(characters[0]!.canonical_name_jp, name);
  assert.ok(f.store.knowledge.aliasesOf(characters[0]!.id).includes('ミリア'));
  const observations = f.store.db.all<{ source_proof: string; valid_from_para: number }>('SELECT source_proof,valid_from_para FROM character_name_observations WHERE character_id=?', [characters[0]!.id]);
  assert.equal(observations.filter(o => JSON.parse(o.source_proof).nameEvidence).length, 1, 'only the original full name has a main-name quotation');
  assert.equal(Math.min(...observations.map(o => o.valid_from_para)), 1);
  const chapter = f.store.projects.listChapters(f.volumeId)[0]!;
  const checkpoint = new PreReadCheckpoint(f.store, chapter.id, false);
  assert.deepEqual(checkpoint.doneMany(f.ids.map(id => f.store.projects.getParagraph(id)!)), Array(65).fill(true), 'saved observations leave resume checkpoints valid');
});

test('student designations delimit names without accepting compound fragments', () => {
  for (const title of ['一号生','二号生','三年生','１年生','第十二期生']) {
    const source=`「おい、アリス${title}。答えよ。」`;
    assert.equal(validNameQuote('アリス',source,source),true,title);
    const input=JSON.stringify({reviewed_ids:['p'],characters:[{name_jp:'アリス',evidence_ids:['p'],name_evidence:{paragraph_id:'p',quote:source}}],relationship_events:[],plot_events:[],knowledge_change_candidates:[]});
    assert.equal(parsePreRead(input,[{id:'p',seriesOrdinal:889,sourceText:source}],[]).ok,true);
  }
  for (const source of ['アリス一号生徒会。','アリス三年生代表。','アリス未知号生。','アリス一号生会社。','スーパーアリス一号生。'])
    assert.equal(validNameQuote('アリス',source,source),false,source);
  assert.equal(validNameQuote('アリス','アリス一号生','アリス一号生徒会。'),false);
});
