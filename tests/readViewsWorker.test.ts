import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { ProjectStore } from '../src/core/db';
import { importTxt } from '../src/core/txt/txtImport';

test('read worker cancels pending readers, restarts and follows a replaced library path', async () => {
 const dir=await mkdtemp(join(tmpdir(),'v3-worker-'));let reads:any;
 const a=join(dir,'a.sqlite'),b=join(dir,'b.sqlite');
 try {
  for(const [path,text] of [[a,'雨。'],[b,'風。\n\n雪。']] as const){const store=new ProjectStore(path);importTxt(store,'test.txt',new TextEncoder().encode(text));store.close();}
  await build({entryPoints:['electron/readViews.ts','electron/readViewsWorker.ts'],outdir:dir,bundle:true,platform:'node',format:'esm',outExtension:{'.js':'.mjs'},tsconfig:resolve('tsconfig.electron.json')});
  const {ReadViews}=await import(pathToFileURL(join(dir,'readViews.mjs')).href);let path=a;reads=new ReadViews(()=>path);
  const store=new ProjectStore(a,{readOnly:true});const volume=store.projects.listSeries()[0]!.volumes[0]!.id;store.close();
  const pending=reads.read('volume',volume);const rejected=assert.rejects(pending,/取消/);await reads.cancel();await rejected;
  const first=await reads.read('volume',volume);assert.equal(first.length,1);
  await reads.cancel();path=b;
  const other=new ProjectStore(b,{readOnly:true});const v2=other.projects.listSeries()[0]!.volumes[0]!.id;other.close();
  assert.equal((await reads.read('volume',v2)).length,2);
 } finally {await reads?.cancel();await rm(dir,{recursive:true,force:true});}
});
