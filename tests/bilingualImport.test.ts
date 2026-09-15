import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { ProjectStore } from '../src/core/db';
import { importEpub } from '../src/core/epub/epubImport';
import { exportEpub } from '../src/core/epub/epubExport';
import { buildContextPack } from '../src/core/ai/contextPack';
import { AiClient } from '../src/core/ai/client';
import { inspectImport } from '../src/core/workflow/importPreflight';

export async function bilingualFixture(reverse=false, broken=false) {
 const zip=new JSZip(); zip.file('mimetype','application/epub+zip');
 zip.file('META-INF/container.xml','<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>');
 zip.file('OPS/book.opf','<package version="3.0" xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>試験の本</dc:title><dc:language>ja</dc:language></metadata><manifest><item id="p" href="p.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="p"/></spine></package>');
 zip.file('OPS/nav.xhtml','<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="p.xhtml">本文</a></li></ol></nav></body></html>');
 const pairs=[['旧译文隔离标记甲','雨が降る。'],['旧译文隔离标记乙','静寂。']].map(([zh,jp])=>{const a=`<p>${zh}</p>`,b=`<p style="opacity:0.4;">${jp}</p>`;return reverse?b+a:a+b;}).join('');
 zip.file('OPS/p.xhtml',`<html xmlns="http://www.w3.org/1999/xhtml"><head><title>試験</title></head><body><h2>１</h2>${pairs}${broken?'<p>未配对旧译文</p>':''}</body></html>`);
 return zip.generateAsync({type:'uint8array'});
}
for(const reverse of [false,true]) test(`bilingual ${reverse?'JP first':'ZH first'} isolates references and exports only software translation`,async t=>{
 const s=new ProjectStore(':memory:');t.after(()=>s.close());const input=await bilingualFixture(reverse);
 const result=await importEpub(s,'paired.epub',input);assert.equal(result.paragraphs,2);
 const views=s.projects.listParagraphViewsByVolume(result.volumeId);assert.deepEqual(views.map(p=>p.sourceText),['雨が降る。','静寂。']);
 let requests=0;
 const ai=new AiClient(s,{primary:{baseUrl:'https://synthetic.invalid',protocol:'chat-completions',model:'synthetic',apiKey:'',authScheme:'none',temperature:0,maxOutputTokens:100,timeoutMs:1000,thinkingMode:'disabled'},concurrency:1,networkRetries:0},async (_provider,request)=>{
  requests++; assert.doesNotMatch(request.system+request.user,/旧译文隔离标记/);
  return {text:'{}',finishReason:'stop',truncated:false,inputTokens:1,outputTokens:1};
 });
 const refs=s.archives.referenceTranslations(result.volumeId);assert.equal(refs[views[0]!.id],'旧译文隔离标记甲');assert.equal(refs[views[1]!.id],'旧译文隔离标记乙');
 assert.equal(s.translations.finalsForParagraphs(views.map(p=>p.id)).size,0);
 for(const p of views) {
  assert.doesNotMatch(JSON.stringify(p),/旧译文隔离标记/);
  assert.doesNotMatch(JSON.stringify(s.archives.blocksOfParagraph(p.id)),/旧译文隔离标记/);
  assert.doesNotMatch(buildContextPack(s,{paragraphIds:[p.id],workstation:'faithful-translator'}).text,/旧译文隔离标记/);
  await ai.raw({workstation:'faithful-translator',paragraphId:p.id,user:buildContextPack(s,{paragraphIds:[p.id],workstation:'faithful-translator'}).text});
  s.translations.setFinal({paragraphId:p.id,text:'本软件新译'+p.paraOrdinal});
 }
 assert.ok((await inspectImport(s,'paired.epub',input)).warnings.some(w=>w.includes('2段已有译文')));
 for(const mode of ['zh','bilingual'] as const){
  const out=await exportEpub(s,result.volumeId,{mode,bilingualLayout:'zh-top',translateTitle:false,keepOriginalRuby:true});assert.equal(out.ok,true,JSON.stringify(out.failures));
  const z=await JSZip.loadAsync(out.data!);const text=await z.file('OPS/p.xhtml')!.async('string');
  assert.doesNotMatch(text,/旧译文隔离标记/);assert.match(text,/本软件新译/);
  if(mode==='zh')assert.doesNotMatch(text,/雨が降る/);else assert.match(text,/雨が降る/);
 }
 assert.deepEqual(s.archives.archiveBlob(result.archiveId),input);
 assert.equal(requests,views.length);
});
test('unpaired bilingual input fails atomically rather than sending Chinese as Japanese',async t=>{
 const s=new ProjectStore(':memory:');t.after(()=>s.close());await assert.rejects(importEpub(s,'broken.epub',await bilingualFixture(false,true)),/无法唯一配对/);
 assert.equal(s.db.get<{n:number}>('SELECT COUNT(*) n FROM paragraphs')!.n,0);
});
test('ordinary Japanese including kanji-only paragraphs is unchanged',async t=>{
 const z=await JSZip.loadAsync(await bilingualFixture());z.file('OPS/p.xhtml','<html><body><p>静寂。</p><p>雨が降る。</p></body></html>');
 const s=new ProjectStore(':memory:');t.after(()=>s.close());const r=await importEpub(s,'ja.epub',await z.generateAsync({type:'uint8array'}));
 assert.equal(r.paragraphs,2);assert.deepEqual(s.archives.referenceTranslations(r.volumeId),{});
});

test('Japanese dim styling alone cannot silently discard ordinary Japanese',async t=>{
 const z=await JSZip.loadAsync(await bilingualFixture());z.file('OPS/p.xhtml','<html><body><p>雨が降る。</p><p style="opacity:0.4;">風が吹く。</p></body></html>');
 const s=new ProjectStore(':memory:');t.after(()=>s.close());await assert.rejects(importEpub(s,'dim.epub',await z.generateAsync({type:'uint8array'})),/语言方向不明确/);
});

test('reference anchors map to Japanese chapters and survive export without old text',async t=>{
 const z=await JSZip.loadAsync(await bilingualFixture());z.file('OPS/p.xhtml',(await z.file('OPS/p.xhtml')!.async('string')).replace('<p>旧译文隔离标记甲','<p id="ref-title">旧译文隔离标记甲'));
 z.file('OPS/nav.xhtml',(await z.file('OPS/nav.xhtml')!.async('string')).replace('href="p.xhtml"','href="p.xhtml#ref-title"'));
 const s=new ProjectStore(':memory:');t.after(()=>s.close());const r=await importEpub(s,'anchors.epub',await z.generateAsync({type:'uint8array'}));assert.equal(r.tocMapped,1);
 for(const p of s.projects.listParagraphViewsByVolume(r.volumeId))s.translations.setFinal({paragraphId:p.id,text:'新译'});
 const out=await exportEpub(s,r.volumeId,{mode:'zh',bilingualLayout:'jp-top',translateTitle:false,keepOriginalRuby:true});assert.equal(out.ok,true,JSON.stringify(out.failures));
 const output=await JSZip.loadAsync(out.data!);const text=await output.file('OPS/p.xhtml')!.async('string');assert.match(text,/id="ref-title"/);assert.doesNotMatch(text,/旧译文隔离标记/);
});
test('legacy imports cannot silently reuse mixed paragraphs',async t=>{
 const s=new ProjectStore(':memory:');t.after(()=>s.close());const input=await bilingualFixture();const r=await importEpub(s,'legacy.epub',input);
 s.db.run("DELETE FROM epub_text_blocks WHERE block_type='reference-zh'");
 await assert.rejects(importEpub(s,'legacy.epub',input),/旧方式导入/);
 assert.equal(s.projects.listParagraphViewsByVolume(r.volumeId).length,2);
});

async function languageFixture(body: string): Promise<Uint8Array> {
 const z=await JSZip.loadAsync(await bilingualFixture());
 z.file('OPS/p.xhtml',`<html xmlns="http://www.w3.org/1999/xhtml"><head><link rel="stylesheet" href="style.css"/></head><body>${body}</body></html>`);
 z.file('OPS/style.css','p[lang="ja"] { opacity: .4; }');
 return z.generateAsync({type:'uint8array'});
}

for(const reverse of [false,true]) test(`explicit Japanese language pairs with external CSS, ${reverse?'JP first':'ZH first'}`,async t=>{
 const pair=(zh:string,jp:string,attr:string)=>reverse?`<p ${attr}>${jp}</p><p>${zh}</p>`:`<p>${zh}</p><p ${attr}>${jp}</p>`;
 const input=await languageFixture('<h3>中文展示标题</h3><p> </p>'+pair('已有中文甲','雨が降る。','lang="ja"')+'<p></p>'+pair('已有中文乙','静寂。','xml:lang="ja-JP"')+'<p> </p>');
 const s=new ProjectStore(':memory:');t.after(()=>s.close());const r=await importEpub(s,'language.epub',input);
 const views=s.projects.listParagraphViewsByVolume(r.volumeId);
 assert.deepEqual(views.map(p=>p.sourceText),['雨が降る。','静寂。']);
 assert.deepEqual(Object.values(s.archives.referenceTranslations(r.volumeId)),['已有中文甲','已有中文乙']);
 for(const p of views){
  assert.doesNotMatch(buildContextPack(s,{paragraphIds:[p.id],workstation:'faithful-translator'}).text,/已有中文|中文展示标题/);
  s.translations.setFinal({paragraphId:p.id,text:'软件译文'});
 }
 const out=await exportEpub(s,r.volumeId,{mode:'bilingual',bilingualLayout:'jp-top',translateTitle:false,keepOriginalRuby:true});
 assert.equal(out.ok,true,JSON.stringify(out.failures));
 const text=await(await JSZip.loadAsync(out.data!)).file('OPS/p.xhtml')!.async('string');
 assert.doesNotMatch(text,/已有中文/);assert.match(text,/中文展示标题/);assert.match(text,/软件译文/);
});

test('explicit Japanese permits kanji-only paired source without guessing language from text',async t=>{
 const s=new ProjectStore(':memory:');t.after(()=>s.close());const r=await importEpub(s,'kanji.epub',await languageFixture('<p lang="zh-CN">安静。</p><p lang="ja-JP">静寂。</p>'));
 assert.deepEqual(s.projects.listParagraphViewsByVolume(r.volumeId).map(p=>p.sourceText),['静寂。']);
 assert.deepEqual(Object.values(s.archives.referenceTranslations(r.volumeId)),['安静。']);
});

test('ordinary Japanese paragraph language labels do not create reference pairs',async t=>{
 const s=new ProjectStore(':memory:');t.after(()=>s.close());const r=await importEpub(s,'ordinary.epub',await languageFixture('<h3>本文</h3><p lang="ja">静寂。</p><p xml:lang="ja-JP">雨が降る。</p>'));
 assert.deepEqual(s.projects.listParagraphViewsByVolume(r.volumeId).map(p=>p.sourceText),['本文','静寂。','雨が降る。']);
 assert.deepEqual(s.archives.referenceTranslations(r.volumeId),{});
});

for(const [label,body] of [
 ['conflicting language attributes','<p>中文。</p><p lang="ja" xml:lang="zh">雨が降る。</p>'],
 ['dim styling conflicts with Chinese label','<p>中文。</p><p lang="zh" style="opacity:0.4">雨が降る。</p>'],
 ['unsupported language counterpart','<p lang="en">A sentence.</p><p lang="ja">雨が降る。</p>'],
 ['orphan reference','<p>中文。</p><p lang="ja">雨が降る。</p><p>多余中文。</p>'],
 ['blank inside pair','<p>中文。</p><p></p><p lang="ja">雨が降る。</p>'],
 ['mixed pair directions','<p>中文甲。</p><p lang="ja">雨が降る。</p><p lang="ja">風が吹く。</p><p>中文乙。</p>'],
 ['Chinese language without Japanese marker','<p lang="zh">中文。</p><p>雨が降る。</p>'],
] as const) test(`${label} fails atomically`,async t=>{
 const s=new ProjectStore(':memory:');t.after(()=>s.close());
 await assert.rejects(importEpub(s,'bad-language.epub',await languageFixture(body)),/语言|配对/);
 assert.equal(s.db.get<{n:number}>('SELECT COUNT(*) n FROM paragraphs')!.n,0);
});

async function withSeparatePages(pages: string[]): Promise<Uint8Array> {
 const z=await JSZip.loadAsync(await languageFixture('<h3>中文标题不作原文</h3><p>已有中文。</p><p lang="ja">雨が降る。</p>'));
 let opf=await z.file('OPS/book.opf')!.async('string');
 for(const [index,body] of pages.entries()) {
  const id=`appendix${index}`;
  opf=opf.replace('</manifest>',`<item id="${id}" href="${id}.xhtml" media-type="application/xhtml+xml"/></manifest>`)
   .replace('</spine>',`<itemref idref="${id}"/></spine>`);
  z.file(`OPS/${id}.xhtml`,`<html><body>${body}</body></html>`);
 }
 z.file('OPS/book.opf',opf);return z.generateAsync({type:'uint8array'});
}

test('bilingual book preserves unlabelled separate pages without assuming they are Japanese',async t=>{
 const input=await withSeparatePages(['<h3>制作信息隔离</h3><p>制作文字隔离。</p>','<p>これは未指定の後書きです。</p>']);
 const s=new ProjectStore(':memory:');t.after(()=>s.close());const r=await importEpub(s,'appendices.epub',input);
 const views=s.projects.listParagraphViewsByVolume(r.volumeId);assert.deepEqual(views.map(p=>p.sourceText),['雨が降る。']);
 assert.doesNotMatch(buildContextPack(s,{paragraphIds:[views[0]!.id],workstation:'faithful-translator'}).text,/制作文字|制作信息|未指定の後書き|中文标题/);
 const preflight=await inspectImport(s,'appendices.epub',input);
 assert.ok(preflight.warnings.some(w=>w.includes('2页')&&w.includes('未配对')));
 s.translations.setFinal({paragraphId:views[0]!.id,text:'软件译文'});
 const out=await exportEpub(s,r.volumeId,{mode:'zh',bilingualLayout:'jp-top',translateTitle:false,keepOriginalRuby:true});assert.equal(out.ok,true,JSON.stringify(out.failures));
 const z=await JSZip.loadAsync(out.data!);assert.match(await z.file('OPS/appendix0.xhtml')!.async('string'),/制作文字隔离/);
 assert.match(await z.file('OPS/appendix1.xhtml')!.async('string'),/これは未指定の後書きです/);
});

test('explicit Japanese independent page remains translatable in a bilingual book',async t=>{
 const s=new ProjectStore(':memory:');t.after(()=>s.close());
 const r=await importEpub(s,'japanese-appendix.epub',await withSeparatePages(['<p xml:lang="ja-JP">これは日本語の後書きです。</p>']));
 assert.deepEqual(s.projects.listParagraphViewsByVolume(r.volumeId).map(p=>p.sourceText),['雨が降る。','これは日本語の後書きです。']);
});

test('one Japanese label cannot authorize unrelated unlabelled Chinese blocks on an independent page',async t=>{
 const s=new ProjectStore(':memory:');t.after(()=>s.close());
 const r=await importEpub(s,'mixed-appendix.epub',await withSeparatePages(['<h3>附页中文标题隔离</h3><p lang="ja">これは日本語の後書きです。</p><div>附页中文制作信息隔离。</div><ul><li>附页中文条目隔离。</li></ul>']));
 const views=s.projects.listParagraphViewsByVolume(r.volumeId);
 assert.deepEqual(views.map(p=>p.sourceText),['雨が降る。','これは日本語の後書きです。']);
 for(const p of views)assert.doesNotMatch(buildContextPack(s,{paragraphIds:[p.id],workstation:'faithful-translator'}).text,/附页中文/);
});

test('explicit Japanese heading in paired body remains source while unlabelled heading is presentation only',async t=>{
 const s=new ProjectStore(':memory:');t.after(()=>s.close());
 const r=await importEpub(s,'headings.epub',await languageFixture('<h3>中文标题</h3><h3 lang="ja-JP">第一章</h3><p>已有中文。</p><p lang="ja">雨が降る。</p>'));
 assert.deepEqual(s.projects.listParagraphViewsByVolume(r.volumeId).map(p=>p.sourceText),['第一章','雨が降る。']);
});
