import { Db } from './database';
import { initializeLibraryIdentity } from './libraryIdentity';
import { ProjectRepo } from './projectRepo';
import { GlossaryRepo } from './glossaryRepo';
import { KnowledgeRepo } from './knowledgeRepo';
import { TranslationRepo } from './translationRepo';
import { ArchiveRepo } from './archiveRepo';

export * from './database';
export * from './projectRepo';
export * from './glossaryRepo';
export * from './knowledgeRepo';
export * from './translationRepo';
export * from './archiveRepo';
export * from './specialNames';

/** 一个应用库文件，容纳全部系列。 */
export class ProjectStore {
  readonly db: Db;
  readonly projects: ProjectRepo;
  readonly glossary: GlossaryRepo;
  readonly knowledge: KnowledgeRepo;
  readonly translations: TranslationRepo;
  readonly archives: ArchiveRepo;
  constructor(path: string) {
    this.db = new Db(path);
    try { initializeLibraryIdentity(this.db); }
    catch (error) { this.db.close(); throw error; }
    this.projects = new ProjectRepo(this.db);
    this.glossary = new GlossaryRepo(this.db);
    this.knowledge = new KnowledgeRepo(this.db);
    this.translations = new TranslationRepo(this.db);
    this.archives = new ArchiveRepo(this.db);
  }
  transaction<T>(fn: () => T): T { return this.db.transaction(fn); }
  close(): void { this.db.close(); }
}
