import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fixture } from './helpers';
import { loadTermExtractionCheckpoint, saveTermExtractionCheckpoint, importTermExtractionCheckpoint } from '../src/core/workflow/termExtractionCheckpoint';

function setup() {
  const f = fixture('ダンジョンに入る。\n\nレイナが来た。');
  const batch = [f.store.projects.getParagraph(f.paragraphId)!];
  const user = JSON.stringify({ existing: [], paragraphs: batch.map(p => ({ id: p.id, source: p.sourceText })) });
  const raw = JSON.stringify({ reviewed_ids: [f.paragraphId], terms: [{ term_jp: 'ダンジョン', term_type: 'concept', sense_identity: '',
    occurrence_paragraph_ids: [f.paragraphId], confidence: 0.5, conflicts: [] }] });
  return { ...f, batch, user, raw };
}

test('successful batch survives a new helper call without completing preparation or creating terms', t => {
  const f = setup(); t.after(() => f.store.close());
  assert.equal(loadTermExtractionCheckpoint(f.store, f.user, f.batch), null);
  saveTermExtractionCheckpoint(f.store, f.user, f.batch, f.raw, { aiCallId: 'successful-call' });
  const cached = loadTermExtractionCheckpoint(f.store, f.user, f.batch)!;
  assert.equal(cached.raw, f.raw);
  assert.equal(cached.value.terms[0]!.term_jp, 'ダンジョン');
  assert.deepEqual(cached.provenance, { aiCallId: 'successful-call' });
  assert.equal(f.store.glossary.activeTerms(f.seriesId).length, 0);
  assert.equal(f.store.projects.prepDoneChapters('terms', f.volumeId).size, 0);
});

test('complete user input and live source identity fence stale cache hits', t => {
  const f = setup(); t.after(() => f.store.close());
  saveTermExtractionCheckpoint(f.store, f.user, f.batch, f.raw);
  const differentUser = JSON.stringify({ ...JSON.parse(f.user), existing: ['レイナ'] });
  assert.equal(loadTermExtractionCheckpoint(f.store, differentUser, f.batch), null);
  f.store.db.run('UPDATE paragraphs SET source_text=? WHERE id=?', ['ダンジョンから出る。', f.paragraphId]);
  assert.equal(loadTermExtractionCheckpoint(f.store, f.user, f.batch), null);
  assert.throws(() => saveTermExtractionCheckpoint(f.store, f.user, f.batch, f.raw), /原文或请求已变化/);
});

test('failed, incomplete and wrongly cited batches are never cached', t => {
  const f = setup(); t.after(() => f.store.close());
  for (const raw of ['not-json', '{"reviewed_ids":[],"terms":[]}', f.raw.replace('ダンジョン', 'シーカー')]) {
    assert.throws(() => saveTermExtractionCheckpoint(f.store, f.user, f.batch, raw), /未通过当前校验/);
  }
  assert.equal(f.store.db.all("SELECT key FROM meta WHERE key LIKE 'prep:term-extraction-batch:%'").length, 0);
});

test('request paragraphs must be complete real source and ordered exactly like the batch', t => {
  const f = setup(); t.after(() => f.store.close());
  const bad = JSON.stringify({ existing: [], paragraphs: [{ id: f.paragraphId, source: '伪造原文' }] });
  assert.throws(() => saveTermExtractionCheckpoint(f.store, bad, f.batch, f.raw), /原文或请求已变化/);
  assert.throws(() => saveTermExtractionCheckpoint(f.store, f.user, [...f.batch, ...f.batch], f.raw), /原文或请求已变化/);
  assert.throws(() => saveTermExtractionCheckpoint(f.store, f.user + '\n\n重试反馈', f.batch, f.raw), /原文或请求已变化/);
});

test('cache reads revalidate raw content and reject changed contracts without deleting history', t => {
  const f = setup(); t.after(() => f.store.close());
  saveTermExtractionCheckpoint(f.store, f.user, f.batch, f.raw);
  const row = f.store.db.get<{ key: string; value: string }>("SELECT key,value FROM meta WHERE key LIKE 'prep:term-extraction-batch:%'")!;
  const altered = { ...JSON.parse(row.value), contract: 'old-contract' };
  f.store.db.run('UPDATE meta SET value=? WHERE key=?', [JSON.stringify(altered), row.key]);
  assert.equal(loadTermExtractionCheckpoint(f.store, f.user, f.batch), null);
  saveTermExtractionCheckpoint(f.store, f.user, f.batch, f.raw);
  assert.equal(f.store.db.all("SELECT key FROM meta WHERE key LIKE '%:history:%'").length, 1);
  f.store.db.run('UPDATE meta SET value=? WHERE key=?', [JSON.stringify({ ...JSON.parse(row.value), raw: '{}' }), row.key]);
  assert.equal(loadTermExtractionCheckpoint(f.store, f.user, f.batch), null);
  // Even an internally consistent stored checksum cannot certify a protocol-invalid result.
  f.store.db.run('UPDATE meta SET value=? WHERE key=?', [JSON.stringify({ ...JSON.parse(row.value), raw: '{}', rawHash: createHash('sha256').update('{}').digest('hex') }), row.key]);
  assert.equal(loadTermExtractionCheckpoint(f.store, f.user, f.batch), null);
});

test('formal exchange import accepts only exact successful first requests and preserves provenance', t => {
  const f = setup(); t.after(() => f.store.close());
  const exchange = { exchangeId: 'report:3', user: f.user, raw: f.raw, status: 200, sourcePath: 'official/report.json', sourceHash: 'original-sha256', index: 3 };
  for (const invalid of [{ ...exchange, status: 503 }, { ...exchange, error: 'timeout' },
    { ...exchange, user: f.user + '\n\n【本次重试须同时满足】修正' }, { ...exchange, raw: '{}' }]) {
    assert.throws(() => importTermExtractionCheckpoint(f.store, f.user, f.batch, invalid));
  }
  const cached = importTermExtractionCheckpoint(f.store, f.user, f.batch, exchange);
  assert.equal(cached.raw, f.raw);
  assert.deepEqual(cached.provenance, { exchangeId: 'report:3', sourcePath: 'official/report.json', sourceHash: 'original-sha256', index: 3 });
});

test('a second valid response does not silently replace an existing successful raw response', t => {
  const f = setup(); t.after(() => f.store.close());
  saveTermExtractionCheckpoint(f.store, f.user, f.batch, f.raw);
  const other = JSON.stringify({ reviewed_ids: [f.paragraphId], terms: [] });
  assert.equal(saveTermExtractionCheckpoint(f.store, f.user, f.batch, other).raw, f.raw);
});

test('the exact old extraction cache is reparsed without a repeat request or rewriting history',t=>{
 const f=setup();t.after(()=>f.store.close());saveTermExtractionCheckpoint(f.store,f.user,f.batch,f.raw);
 const row=f.store.db.get<{key:string;value:string}>("SELECT key,value FROM meta WHERE key LIKE 'prep:term-extraction-batch:%'")!;
 const contract='16463d576fc82f858d9d9441c033e867e2b42986e05eca3e12069f74aa4c20a0';
 const sources=f.batch.map(p=>{const r=f.store.projects.getParagraph(p.id)!;return [f.seriesId,r.chapterId,r.seriesOrdinal,r.id,r.sourceText];});
 const signature=createHash('sha256').update(JSON.stringify([contract,f.user,sources])).digest('hex');
 const key='prep:term-extraction-batch:'+signature,value=JSON.stringify({...JSON.parse(row.value),contract,signature});
 f.store.db.run('DELETE FROM meta WHERE key=?',[row.key]);f.store.db.run('INSERT INTO meta(key,value) VALUES(?,?)',[key,value]);
 assert.equal(loadTermExtractionCheckpoint(f.store,f.user,f.batch)?.raw,f.raw);
 assert.equal(f.store.db.get<{value:string}>('SELECT value FROM meta WHERE key=?',[key])!.value,value);
 f.store.db.run("UPDATE paragraphs SET source_text='別の原文。' WHERE id=?",[f.paragraphId]);
 assert.equal(loadTermExtractionCheckpoint(f.store,f.user,f.batch),null);
});
