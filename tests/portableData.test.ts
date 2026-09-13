import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { prepareDataPaths } from '../electron/dataPaths';

test('packaged and development storage stay beside the application; explicit test isolation wins', t => {
  mkdirSync('artifacts/temp', { recursive: true });
  const root = mkdtempSync(resolve('artifacts/temp/portable-path-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = prepareDataPaths(join(root, 'app', 'workshop.exe'), join(root, 'dev'), true);
  assert.equal(paths.data, join(root, 'app', 'data'));
  for (const path of Object.values(paths)) assert.ok(existsSync(path));
  assert.equal(prepareDataPaths(join(root, 'electron.exe'), join(root, 'dev'), false).data, join(root, 'dev', 'data'));
  assert.equal(prepareDataPaths(join(root, 'other.exe'), root, true, join(root, 'isolated')).data, join(root, 'isolated'));
});
test('an unusable data path fails explicitly without a fallback directory', t => {
  mkdirSync('artifacts/temp', { recursive: true });
  const root = mkdtempSync(resolve('artifacts/temp/portable-fail-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'data'), 'occupied by a file');
  assert.throws(() => prepareDataPaths(join(root, 'app.exe'), root, true), /不会改用C盘/);
});
