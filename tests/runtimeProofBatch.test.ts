import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers';
import { bindNarrativeBatch, narrativeSourceCurrent } from '../src/core/db/narrativeSources';
test('shared batch proofs revalidate changed ancestry and never partially commit', t => {
 const f=fixture('雨。\n風。\n雪。');t.after(()=>f.store.close());
 const add=(i:number)=>f.store.knowledge.addEvent({seriesId:f.seriesId,summaryJp:'出来事',atPara:i+1,revealsToReader:true,characterIds:[],evidenceIds:[f.ids[i]!]});
 const parent=add(0), ids=[add(1),add(2)];const batch=ids.map((id,i)=>({kind:'event' as const,id,ids:[f.ids[i+1]!],dependencyIds:[parent]}));
 bindNarrativeBatch(f.store.db,batch);assert.ok(ids.every(id=>narrativeSourceCurrent(f.store.db,'event',id)));
 const before=f.store.db.all('SELECT * FROM narrative_provenance ORDER BY record_id');
 f.store.db.run("UPDATE paragraphs SET source_text='晴れ。' WHERE id=?",[f.ids[0]!]);
 assert.throws(()=>bindNarrativeBatch(f.store.db,batch),/背景依据/);assert.deepEqual(f.store.db.all('SELECT * FROM narrative_provenance ORDER BY record_id'),before);
 assert.ok(ids.every(id=>!narrativeSourceCurrent(f.store.db,'event',id)));
});
test('prepared statements cache SQL only and see writes and rollback immediately', t=>{
 const f=fixture('雨。');t.after(()=>f.store.close());const sql='SELECT source_text FROM paragraphs WHERE id=?';
 const before=f.store.db.get(sql,[f.paragraphId]);
 assert.throws(()=>f.store.transaction(()=>{f.store.db.run("UPDATE paragraphs SET source_text='雪。' WHERE id=?",[f.paragraphId]);assert.equal(f.store.db.get<{source_text:string}>(sql,[f.paragraphId])!.source_text,'雪。');throw Error('rollback');}),/rollback/);
 assert.deepEqual(f.store.db.get(sql,[f.paragraphId]),before);
 f.store.db.raw.prepare("UPDATE paragraphs SET source_text='風。' WHERE id=?").run(f.paragraphId);
 assert.equal(f.store.db.get<{source_text:string}>(sql,[f.paragraphId])!.source_text,'風。');
});
