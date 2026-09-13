import { Db, newId, nowIso } from './database';

export interface SpineItemRow { id: string; archive_id: string; href: string; spine_index: number; parseable: number }
export interface BlockRow { id: string; spine_item_id: string; paragraph_id: string | null; xpath: string; block_hash: string; block_type: string; protocol: 'slots' | 'markers' | 'untranslatable'; inline_template: string | null; source_text: string }
export interface TocRow { id: string; archive_id: string; toc_source: 'nav' | 'ncx'; entry_path: string; source_label: string; heading_block_id: string | null }

/** EPUB/TXT 源快照与 AST 文本块 */
export class ArchiveRepo {
  constructor(private readonly db: Db) {}

  createArchive(a: { volumeId: string; fileName: string; fileKind: 'epub' | 'txt'; sha256: string; blob: Uint8Array }): string {
    const id = newId();
    this.db.run('INSERT INTO source_archives(id,volume_id,file_name,file_kind,sha256,blob,imported_at) VALUES(?,?,?,?,?,?,?)', [id, a.volumeId, a.fileName, a.fileKind, a.sha256, a.blob, nowIso()]);
    return id;
  }
  findArchiveBySha(sha256: string): { id: string; volume_id: string } | undefined { return this.db.get('SELECT id, volume_id FROM source_archives WHERE sha256=?', [sha256]); }
  archiveOfVolume(volumeId: string): { id: string; file_name: string; file_kind: 'epub' | 'txt'; sha256: string } | undefined {
    return this.db.get('SELECT id, file_name, file_kind, sha256 FROM source_archives WHERE volume_id=?', [volumeId]);
  }
  archiveBlob(archiveId: string): Uint8Array | undefined { return this.db.get<{ blob: Uint8Array }>('SELECT blob FROM source_archives WHERE id=?', [archiveId])?.blob; }

  addSpineItem(archiveId: string, href: string, spineIndex: number, parseable: boolean): string {
    const id = newId();
    this.db.run('INSERT INTO spine_items(id,archive_id,href,spine_index,parseable) VALUES(?,?,?,?,?)', [id, archiveId, href, spineIndex, parseable ? 1 : 0]);
    return id;
  }
  spineItems(archiveId: string): SpineItemRow[] { return this.db.all<SpineItemRow>('SELECT * FROM spine_items WHERE archive_id=? ORDER BY spine_index', [archiveId]); }

  addBlock(b: Omit<BlockRow, 'id'>): string {
    const id = newId();
    this.db.run('INSERT INTO epub_text_blocks(id,spine_item_id,paragraph_id,xpath,block_hash,block_type,protocol,inline_template,source_text) VALUES(?,?,?,?,?,?,?,?,?)',
      [id, b.spine_item_id, b.paragraph_id, b.xpath, b.block_hash, b.block_type, b.protocol, b.inline_template, b.source_text]);
    return id;
  }
  blocksOfSpineItem(spineItemId: string): BlockRow[] { return this.db.all<BlockRow>('SELECT * FROM epub_text_blocks WHERE spine_item_id=? ORDER BY rowid', [spineItemId]); }
  blocksOfParagraph(paragraphId: string): BlockRow[] { return this.db.all<BlockRow>('SELECT * FROM epub_text_blocks WHERE paragraph_id=? ORDER BY rowid', [paragraphId]); }
  blockById(id: string): BlockRow | undefined { return this.db.get<BlockRow>('SELECT * FROM epub_text_blocks WHERE id=?', [id]); }

  addToc(t: Omit<TocRow, 'id'>): string {
    const id = newId();
    this.db.run('INSERT INTO toc_entries(id,archive_id,toc_source,entry_path,source_label,heading_block_id) VALUES(?,?,?,?,?,?)', [id, t.archive_id, t.toc_source, t.entry_path, t.source_label, t.heading_block_id]);
    return id;
  }
  tocEntries(archiveId: string): TocRow[] { return this.db.all<TocRow>('SELECT * FROM toc_entries WHERE archive_id=?', [archiveId]); }
}
