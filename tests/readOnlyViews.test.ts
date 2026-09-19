import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../src/core/db';
import { importTxt } from '../src/core/txt/txtImport';
import { readPrepStatus } from '../src/core/workflow/prepStatus';
test('UI read-only connection cannot mutate data and sees new committed values without a stale cache', t => {
 const dir=mkdtempSync(join(tmpdir(),'v3-readonly-'));const path=join(dir,'library.sqlite');const main=new ProjectStore(path);let view:ProjectStore|undefined;
 t.after(()=>{view?.close();main.close();rmSync(dir,{recursive:true,force:true});});
 const book=importTxt(main,'sample.txt',new TextEncoder().encode('雨が降る。'));const before=readPrepStatus(main,book.volumeId);
 view=new ProjectStore(path,{readOnly:true});assert.deepEqual(readPrepStatus(view,book.volumeId),before);
 assert.throws(()=>view!.db.run("INSERT INTO meta(key,value) VALUES('forbidden','yes')"),/readonly/i);
 assert.equal(main.db.get("SELECT value FROM meta WHERE key='forbidden'"),undefined);
 view.db.raw.exec('BEGIN');view.translations.latestLogId();main.translations.log({level:'info',message:'new committed entry'});assert.equal(view.translations.latestLogId(),0);view.db.raw.exec('COMMIT');assert.equal(view.translations.latestLogId(),1);
});
