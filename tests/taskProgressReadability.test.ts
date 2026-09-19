import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import type { WorkflowProgress } from '../src/shared/types';
import type { SeriesDeliveryState } from '../src/shared/ipc';

const root = resolve(import.meta.dirname, '..');
const temporaryRoot = join(root, 'artifacts', 'temp');
await mkdir(temporaryRoot, { recursive: true });
const temporary = await mkdtemp(join(temporaryRoot, 'task-progress-'));
after(async () => {
  assert.equal(dirname(resolve(temporary)), resolve(temporaryRoot));
  await rm(temporary, { recursive: true, force: true });
});
const outfile = join(temporary, 'task-progress.mjs');
await build({ entryPoints: [join(root, 'src/renderer/components/TaskProgressView.tsx')], outfile, bundle: true, packages: 'external', format: 'esm', platform: 'node', tsconfig: join(root, 'tsconfig.renderer.json') });
const { TaskProgressView } = await import(pathToFileURL(outfile).href);
const detail = { phase: 'preread', label: '人物预读', done: 8, total: 32, unit: '段' as const, chapterTitle: '第一章' };
const progress: WorkflowProgress = { running: true, paused: false, phase: '全作品 · 已检查册数', done: 0, total: 1, detail, currentParagraphId: null, costUsd: 0, inputTokens: 0, outputTokens: 0, message: '处理第一章' };
const state: SeriesDeliveryState = {
  seriesId: 'series', status: 'running', phase: 'process', scope: [{ id: 'volume', number: 1 }], originalFileHash: 'hash', mode: 'zh', outputPath: 'D:/output.zip', message: '处理第一章', updatedAt: '2026-09-13', result: null,
  run: { seriesId: 'series', volumeIds: ['volume'], currentVolumeId: 'volume', status: 'running', done: 0, total: 1, message: '处理中', updatedAt: '2026-09-13', usage: { inputTokens: 0, outputTokens: 0, unknownUsageRequests: 0 }, currentRun: { volumeId: 'volume', status: 'running', phase: 'preread', done: 0, total: 300, detail, message: '预读', updatedAt: '2026-09-13', scanKey: null } },
};
const render = (p = progress, s: SeriesDeliveryState | null = state, live = true): string => renderToStaticMarkup(createElement(TaskProgressView, { progress: p, state: s, live }));

test('step progress uses paragraph counts independently of overall volume counts', () => {
  const html = render();
  assert.match(html, /aria-valuemax="32"/);
  assert.match(html, /aria-valuenow="8"/);
  assert.match(html, /25%/);
  assert.match(html, /全任务已检查/);
  assert.match(html, /0 \/ 1/);
  assert.match(html, /第一章/);
});
test('a stopped task restores persisted step progress without using unrelated live counts', () => {
  const html = render({ ...progress, running: false, detail: { ...detail, done: 31 } }, { ...state, status: 'stopped' }, false);
  assert.match(html, /aria-valuenow="8"/);
  assert.doesNotMatch(html, /aria-valuenow="31"/);
});
test('unknown step size never turns overall volume counts into a percentage', () => {
  const html = render({ ...progress, detail: null });
  assert.doesNotMatch(html, /role="progressbar"|\d+%/);
  assert.match(html, /等待当前步骤的完成数量/);
});
test('saving does not show a stale translation percentage or claim saved prematurely', () => {
  const html = render(progress, { ...state, phase: 'export' });
  assert.match(html, /正在写入成品文件/);
  assert.doesNotMatch(html, /role="progressbar"|成品已保存/);
});
test('late knowledge checks and decisions stay in translation and checking', () => {
  const next = structuredClone(state);
  next.status = 'attention'; next.waitingDecisionIds = ['character-decision'];
  Object.assign(next.run!.currentRun!, { phase: 'knowledge', done: 300, total: 300, detail: null });
  const html = render({ ...progress, running: false }, next, false);
  assert.match(html, /aria-current="step"><span>3<\/span>翻译与检查/);
  assert.match(html, /等待确认 · 1 项/);
  assert.doesNotMatch(html, /术语确认/);
});
test('rounding never displays 100 percent before the current step completes', () => {
  const html = render({ ...progress, detail: { ...detail, done: 3462, total: 3463 } });
  assert.match(html, /99%/);
  assert.doesNotMatch(html, /100%/);
});

test('numbered steps distinguish preparation from translation and survive pause', () => {
  const step = { stage: 'preparation' as const, index: 2, total: 8, label: '术语提取' };
  assert.match(render({ ...progress, step }), /预处理 · 第 2\/8 步：术语提取/);
  const stopped = structuredClone(state); stopped.status = 'stopped'; stopped.run!.currentRun!.step = step;
  assert.match(render({ ...progress, step: { stage: 'translation', index: 5, total: 5, label: '成品检查' } }, stopped, false), /预处理 · 第 2\/8 步/);
  assert.match(render({ ...progress, step: { stage: 'translation', index: 3, total: 5, label: '跨章检查' } }), /翻译与检查 · 第 3\/5 步/);
});
