import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers';

test('log pages stay bounded, preserve history, search full detail and use stable cursors', t => {
 const {store}=fixture();t.after(()=>store.close());
 for(let i=0;i<235;i++)store.translations.log({level:i%2?'warning':'error',workstationId:'translator',message:`${i} `+'文'.repeat(15000)+(i===4?'targetneedle':'')});
 const newest=store.translations.logPage();assert.equal(newest.entries.length,100);assert.equal(newest.hasMore,true);assert.equal(newest.entries.at(-1)!.id,store.translations.latestLogId());assert.ok(newest.entries.every(l=>l.message.length===500));
 const older=store.translations.logPage({beforeId:newest.entries[0]!.id});assert.equal(older.entries.length,100);assert.ok(older.entries.at(-1)!.id<newest.entries[0]!.id);
 const oldest=store.translations.logPage({beforeId:older.entries[0]!.id});assert.equal(oldest.entries.length,35);assert.equal(oldest.hasMore,false);
 const found=store.translations.logPage({search:'targetneedle'});assert.equal(found.entries.length,1);
 const id=found.entries[0]!.id;const a=store.translations.logDetail(id)!, b=store.translations.logDetail(id,12000)!;assert.equal(a.text.length,12000);assert.equal(a.hasMore,true);assert.equal(b.hasMore,false);assert.equal(a.text+b.text,'4 '+'文'.repeat(15000)+'targetneedle');
 assert.equal(store.translations.recentLogs(0,1000).find(l=>l.id===id)!.message,a.text+b.text);
 assert.equal(store.translations.logPage({level:'error'}).entries.every(l=>l.level==='error'),true);
 assert.equal(store.translations.logPage({workstation:'book-pre-reader'}).entries.length,0);
 assert.equal(store.translations.recentLogs(0,200,true)[0]!.message.length,500);
 store.translations.clearLogs();assert.equal(store.translations.latestLogId(),0);assert.equal(store.translations.logDetail(id),null);store.translations.log({level:'info',message:'new'});assert.ok(store.translations.latestLogId()>id);
});
