import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readDataLocation, scheduleDataMove, finishDataMove } from '../electron/dataLocation';

function fixture(t: TestContext) {
  mkdirSync('artifacts/temp', { recursive: true });
  const root = mkdtempSync(resolve('artifacts/temp/data-location-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'data'), target = join(root, 'chosen');
  mkdirSync(source); mkdirSync(target);
  writeFileSync(join(source, 'synthetic-file'), 'synthetic-library');
  mkdirSync(join(source, 'Local Storage'));
  writeFileSync(join(source, 'Local Storage', 'draft'), 'saved draft');
  return { root, source, target };
}
test('directory change waits for restart and preserves library, drafts and source backup', t => {
  const { root, source, target } = fixture(t);
  scheduleDataMove(root, source, target);
  assert.equal(readDataLocation(root).current, source);
  assert.equal(finishDataMove(root), target);
  for (const folder of [source, target]) {
    assert.equal(readFileSync(join(folder, 'synthetic-file'), 'utf8'), 'synthetic-library');
    assert.equal(readFileSync(join(folder, 'Local Storage', 'draft'), 'utf8'), 'saved draft');
  }
  assert.equal(readDataLocation(root).pending, undefined);
  assert.equal(finishDataMove(root), target);
});
test('occupied and overlapping destinations never overwrite data', t => {
  const { root, source, target } = fixture(t);
  assert.throws(() => scheduleDataMove(root, source, join(source, 'Local Storage')), /互不包含/);
  writeFileSync(join(target, 'keep'), 'existing');
  assert.throws(() => scheduleDataMove(root, source, target), /空文件夹/);
  assert.equal(readFileSync(join(target, 'keep'), 'utf8'), 'existing');
});
test('destination changed before restart cancels pending move without adopting partial data', t => {
  const { root, source, target } = fixture(t);
  scheduleDataMove(root, source, target);
  writeFileSync(join(target, 'other'), 'keep');
  assert.throws(() => finishDataMove(root), /仍使用原目录/);
  assert.equal(readDataLocation(root).current, source);
  assert.equal(readDataLocation(root).pending, undefined);
});

 test('verified profile move preserves scoped draft identity; ordinary copies remain isolated', async t => {
  const { ProjectStore } = await import('../src/core/db');
  const { readLibraryIdentity } = await import('../src/core/db/libraryIdentity');
  const { copyFileSync } = await import('node:fs');
  const { root, source, target } = fixture(t);
  const original = new ProjectStore(join(source,'library.sqlite'));
  const identity = readLibraryIdentity(original.db); original.close();
  scheduleDataMove(root,source,target); finishDataMove(root);
  const moved = new ProjectStore(join(target,'library.sqlite'));
  assert.deepEqual(readLibraryIdentity(moved.db),identity); moved.close();
  copyFileSync(join(target,'library.sqlite'),join(root,'ordinary.sqlite'));
  const ordinary = new ProjectStore(join(root,'ordinary.sqlite'));
  assert.notEqual(readLibraryIdentity(ordinary.db).libraryId,identity.libraryId); ordinary.close();
 });
