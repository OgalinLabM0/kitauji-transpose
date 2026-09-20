import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTermExtract } from '../src/core/ai/protocol';
import { fixture } from './helpers';
import { reconcileTermCandidates } from '../src/core/workflow/termCandidatePolicy';
import { termSplitReceipt } from '../src/core/validation/termGranularity';

const parse = (word: string, kind: string, extra = {}, source = `${word}。`) => parseTermExtract(JSON.stringify({ reviewed_ids: ['p'], terms: [{ term_jp: word, term_type: kind, occurrence_paragraph_ids: ['p'], ...extra }] }), [{ id: 'p', sourceText: source }]);
test('kanji candidates are omitted but kana terms and names remain', () => {
  for (const word of ['中層第一地区', '望月雪乃', '《望月雪乃》', '「望月雪乃」', '第224中隊', '佐々木', 'アシスタント']) {
    const r = parse(word, 'person'); assert.ok(r.ok); assert.deepEqual(r.value.terms, []);
  }
  const r = parse('ダンジョン', 'place'); assert.ok(r.ok); assert.equal(r.value.terms[0]!.term_jp, 'ダンジョン');
});
test('ordinary shop descriptions reduce to the term without quote wrappers', () => {
  const r = parse('高級ダンジョン料理店', 'organization'); assert.ok(r.ok);
  assert.deepEqual(r.value.terms.map(t=>t.term_jp), ['ダンジョン']);
  const q = parse('《レイナ》', 'person'); assert.ok(q.ok);
  assert.deepEqual(q.value.terms.map(t=>t.term_jp), ['レイナ']);
});
test('company brand and generic production component split and personal-name components', () => {
  const r = parse('ドリームライト・プロダクション', 'organization'); assert.ok(r.ok);
  assert.deepEqual(r.value.terms.map(t => t.term_jp), ['ドリームライト', 'プロダクション']);
  const n = parse('レイナ・アヤネ', 'person'); assert.ok(n.ok); assert.deepEqual(n.value.terms.map(t => t.term_jp), ['レイナ', 'アヤネ']);
});
test('semantic split hints are deferred intact to independent contextual selection', () => {
  const parts = [{ term_jp: 'ボス', term_type: 'concept' }, { term_jp: '部屋', term_type: 'place' }];
  for (const extra of [
    { components: parts, split_preserves_meaning: true, split_reason: '普通の部屋' },
    { components: [parts[1], parts[0]], split_preserves_meaning: true, split_reason: 'wrong order' },
    { components: [{ term_jp: 'ラスボス', term_type: 'concept' }, parts[1]], split_preserves_meaning: true },
    { components: 'malformed optional hint', split_preserves_meaning: 'yes', split_reason: 1 },
  ]) {
    const r = parse('ボス部屋', 'place', extra); assert.ok(r.ok);
    assert.deepEqual(r.value.terms.map(t => t.term_jp), ['ボス部屋']);
    assert.equal(r.value.terms[0]!.split_suggestion, null);
    assert.deepEqual(r.value.terms[0]!.components, []);
  }
});
test('literal source validation still rejects invented parents and crossings of atomic boundaries', () => {
  assert.equal(parse('ドリームライト・プロダクション', 'organization', {}, 'ドリーム⟦1/⟧ライト・プロダクション').ok, false);
  assert.equal(parse('ボス部屋', 'place', {}, 'ボスッという音がした。').ok, false);
});
test('candidate reconciliation preserves user choices, characters, old proposals and other-book candidates', t => {
  const f = fixture('望月雪乃。\nドリームライト・プロダクション。\n帝国軍。'); t.after(() => f.store.close());
  const character = f.store.knowledge.upsertCharacter({ seriesId: f.seriesId, introducedVolume: 1, nameJp: '望月雪乃' });
  const add = (jp: string, type: string, zh: string | null = null) => f.store.glossary.upsertTerm({ seriesId: f.seriesId, introducedVolume: 1, termJp: jp, termZh: zh, termType: type, lockLevel: zh ? 'confirmed' : 'suggested' });
  const name = add('望月雪乃', 'person'), company = add('ドリームライト・プロダクション', 'organization');
  const manual = add('帝国軍', 'organization', '帝国军'); add('別巻限定', 'place');
  const q = f.store.translations.enqueue({ seriesId: f.seriesId, paragraphId: f.paragraphId, kind: 'term-proposal', title: 'old', payload: { termId: name, candidates: [{ zh: '旧候选' }] } });
  const result = reconcileTermCandidates(f.store, f.volumeId);
  assert.deepEqual(new Set(result.retired), new Set(['望月雪乃', 'ドリームライト・プロダクション']));
  assert.deepEqual(new Set(result.created), new Set(['ドリームライト', 'プロダクション']));
  assert.equal(f.store.knowledge.getCharacter(character)?.canonical_name_jp, '望月雪乃');
  assert.equal(f.store.glossary.findTermByJp(f.seriesId, '帝国軍')?.id, manual);
  assert.ok(f.store.glossary.findTermByJp(f.seriesId, '別巻限定'));
  assert.equal(f.store.translations.getQueueItem(q)?.status, 'dismissed');
  assert.deepEqual(f.store.translations.getQueueItem(q)?.payload.candidates, [{ zh: '旧候选' }]);
  assert.ok(f.store.db.get('SELECT id FROM terms WHERE id=?', [company]));
  assert.equal(f.store.glossary.findTermByJp(f.seriesId, 'プロダクション')?.term_zh, null);
  assert.deepEqual(reconcileTermCandidates(f.store, f.volumeId), { retired: [], created: [] });
});

test('one bad extraction split cannot reject other literal candidates or certify invented pieces', () => {
 const raw={reviewed_ids:['p'],terms:[{term_jp:'青銅のミレナ',term_type:'person',occurrence_paragraph_ids:['p'],components:[{term_jp:'青銅',term_type:'other'},{term_jp:'ミレナ',term_type:'person'}],split_preserves_meaning:true,split_reason:'称号と名前'}, {term_jp:'ゲート',term_type:'concept',occurrence_paragraph_ids:['p']}]};
 const source=[{id:'p',sourceText:'青銅のミレナはゲートを通った。'}];
 const r=parseTermExtract(JSON.stringify(raw),source);assert.ok(r.ok);assert.deepEqual(r.value.terms.map(t=>t.term_jp),['青銅のミレナ','ゲート']);
 raw.terms[0]!.term_jp='金色のミレナ';assert.equal(parseTermExtract(JSON.stringify(raw),source).ok,false);
});
