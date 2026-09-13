import { createHash, randomUUID } from 'node:crypto';
import { ProjectStore, nowIso } from '@core/db';
import type { EpubChapterRebuildResult } from '@shared/ipc';
import { importEpub } from './epubImport';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function snapshot(store:ProjectStore,volumeId:string){
  const chapters=store.db.all<{id:string;chapter_number:number;title:string|null}>('SELECT * FROM chapters WHERE volume_id=? ORDER BY chapter_number',[volumeId]);
  const scenes=store.db.all<{id:string;chapter_id:string;scene_ordinal:number}>('SELECT s.* FROM scenes s JOIN chapters c ON c.id=s.chapter_id WHERE c.volume_id=? ORDER BY c.chapter_number,s.scene_ordinal',[volumeId]);
  const paragraphs=store.db.all<{id:string;scene_id:string;series_ordinal:number;source_text:string;source_hash:string}>('SELECT p.* FROM paragraphs p JOIN scenes s ON s.id=p.scene_id JOIN chapters c ON c.id=s.chapter_id WHERE c.volume_id=? ORDER BY p.series_ordinal',[volumeId]);
  const blocks=store.db.all<{paragraph_id:string|null;href:string;xpath:string;block_hash:string}>('SELECT b.*,s.href FROM epub_text_blocks b JOIN spine_items s ON s.id=b.spine_item_id JOIN source_archives a ON a.id=s.archive_id WHERE a.volume_id=? ORDER BY s.spine_index,b.xpath',[volumeId]);
  const finals=store.db.all('SELECT f.* FROM translation_finals f JOIN paragraphs p ON p.id=f.paragraph_id JOIN scenes s ON s.id=p.scene_id JOIN chapters c ON c.id=s.chapter_id WHERE c.volume_id=? ORDER BY f.id',[volumeId]);
  const analyses=store.db.all('SELECT a.* FROM paragraph_analysis a JOIN paragraphs p ON p.id=a.paragraph_id JOIN scenes s ON s.id=p.scene_id JOIN chapters c ON c.id=s.chapter_id WHERE c.volume_id=? ORDER BY a.paragraph_id',[volumeId]);
  return {chapters,scenes,paragraphs,blocks,finals,analyses};
}

/** Explicit maintenance only. No model use, no replacement of source or manuscripts. */
export async function rebuildEpubChapters(store:ProjectStore,volumeId:string,backup:()=>Promise<string>,checkpoint:()=>void=()=>{}):Promise<EpubChapterRebuildResult>{
  checkpoint();
  const archive=store.archives.archiveOfVolume(volumeId);
  if(!archive||archive.file_kind!=='epub')throw new Error('这册不是 EPUB，不能按书内目录整理章节');
  const blob=store.archives.archiveBlob(archive.id);
  if(!blob||createHash('sha256').update(blob).digest('hex')!==archive.sha256)throw new Error('保存的原 EPUB 快照校验失败，原稿未改动');
  const before=snapshot(store,volumeId),stamp=hash(before);
  const scratch=new ProjectStore(':memory:');
  let desired:{title:string|null;ids:string[]}[]=[];
  try{
    const imported=await importEpub(scratch,archive.file_name,blob);checkpoint();
    const source=snapshot(scratch,imported.volumeId);
    const oldByLocation=new Map(before.blocks.filter(b=>b.paragraph_id).map(b=>[JSON.stringify([b.href,b.xpath,b.block_hash]),b.paragraph_id!]));
    const mapping=new Map<string,string>();
    for(const block of source.blocks.filter(b=>b.paragraph_id)){
      const id=oldByLocation.get(JSON.stringify([block.href,block.xpath,block.block_hash]));
      if(!id||[...mapping.values()].includes(id))throw new Error('段落与原 EPUB 位置不能一一对应，原稿未改动');
      mapping.set(block.paragraph_id!,id);
    }
    if(mapping.size!==before.paragraphs.length||mapping.size!==source.paragraphs.length||source.paragraphs.some((p,i)=>mapping.get(p.id)!==before.paragraphs[i]?.id||p.source_text!==before.paragraphs[i]?.source_text||p.source_hash!==before.paragraphs[i]?.source_hash))throw new Error('原文或段落顺序已变化，不能安全整理章节，原稿未改动');
    desired=source.chapters.map(c=>({title:c.title,ids:source.paragraphs.filter(p=>source.scenes.find(s=>s.id===p.scene_id)!.chapter_id===c.id).map(p=>mapping.get(p.id)!)}));
  }finally{scratch.close()}
  const members=(chapterId:string)=>before.paragraphs.filter(p=>before.scenes.find(s=>s.id===p.scene_id)!.chapter_id===chapterId).map(p=>p.id);
  const existing=before.chapters.map(c=>({title:c.title,ids:members(c.id)}));
  const counts={beforeChapters:before.chapters.length,afterChapters:desired.length,paragraphs:before.paragraphs.length};
  if(hash(existing)===hash(desired))return {changed:false,...counts,backupPath:null};
  // A previously analysed scene crossing a new chapter boundary needs a separate
  // reviewed migration. Never silently split its identity or relationships here.
  const destination=new Map(desired.flatMap((c,i)=>c.ids.map(id=>[id,i] as const)));
  for(const scene of before.scenes){const groups=new Set(before.paragraphs.filter(p=>p.scene_id===scene.id).map(p=>destination.get(p.id)));if(groups.size>1)throw new Error('现有场景跨越新的章节边界，不能安全自动拆分；请保留原稿和备份，暂不整理');}
  const backupPath=await backup();checkpoint();
  if(!backupPath)throw new Error('安全备份未完成，原稿未改动');
  return store.transaction(()=>{
    checkpoint();
    if(hash(snapshot(store,volumeId))!==stamp||store.archives.archiveOfVolume(volumeId)?.sha256!==archive.sha256)throw new Error('整理期间书籍或稿件已变化，原稿未改动，请重试');
    const historyId=`epub-chapter-rebuild:${volumeId}:${randomUUID()}`;
    store.db.run('INSERT INTO meta(key,value) VALUES(?,?)',[historyId,JSON.stringify({at:nowIso(),backupPath,archiveSha:archive.sha256,chapters:before.chapters,scenes:before.scenes,analyses:before.analyses})]);
    // Temporarily vacate unique chapter/scene ordinals inside the transaction.
    before.chapters.forEach((c,i)=>store.db.run('UPDATE chapters SET chapter_number=? WHERE id=?',[-i-1,c.id]));
    before.scenes.forEach((s,i)=>store.db.run('UPDATE scenes SET scene_ordinal=? WHERE id=?',[-i-1,s.id]));
    const retained=new Set<string>();
    for(const [index,group] of desired.entries()){
      const old=before.chapters.find(c=>hash(members(c.id))===hash(group.ids));
      const chapterId=old?.id??store.projects.createChapter(volumeId,index+1,group.title);retained.add(chapterId);
      if(old)store.db.run('UPDATE chapters SET chapter_number=?,title=? WHERE id=?',[index+1,group.title,old.id]);
      const orderedScenes=before.scenes.filter(s=>before.paragraphs.some(p=>p.scene_id===s.id&&destination.get(p.id)===index));
      orderedScenes.forEach((scene,i)=>store.db.run('UPDATE scenes SET chapter_id=?,scene_ordinal=? WHERE id=?',[chapterId,i+1,scene.id]));
      for(const pid of group.ids){const p=before.paragraphs.find(p=>p.id===pid)!;if(before.scenes.find(s=>s.id===p.scene_id)!.chapter_id!==chapterId){
        store.db.run('UPDATE paragraph_analysis SET scene_source_hash=NULL WHERE paragraph_id=?',[pid]);
        if(store.translations.latestFinal(pid))store.translations.addRecheck(pid,historyId,'章节范围已按原书目录整理，需要重新核对章内上下文；保存稿保持不变');
      }}
    }
    // Preserve otherwise empty scenes too; they may hold old observations.
    for(const scene of before.scenes)if(!before.paragraphs.some(p=>p.scene_id===scene.id)){
      const chapter=before.chapters.find(c=>c.id===scene.chapter_id)!;
      const fallback=retained.has(chapter.id)?chapter.id:store.projects.listChapters(volumeId).find(c=>retained.has(c.id))!.id;
      const ordinal=store.db.get<{n:number}>('SELECT COALESCE(MAX(scene_ordinal),0)+1 n FROM scenes WHERE chapter_id=?',[fallback])!.n;
      store.db.run('UPDATE scenes SET chapter_id=?,scene_ordinal=? WHERE id=?',[fallback,ordinal,scene.id]);
    }
    for(const old of before.chapters)if(!retained.has(old.id))store.db.run('DELETE FROM chapters WHERE id=?',[old.id]);
    store.projects.touchSeries(store.projects.getVolumeSeriesId(volumeId));
    checkpoint();return {changed:true,...counts,backupPath};
  });
}
