import { parentPort } from 'node:worker_threads';
import { ProjectStore } from '../src/core/db';
import { readPrepStatus } from '../src/core/workflow/prepStatus';
import { withAuditStatus } from '../src/core/workflow/taskOverview';
parentPort!.on('message', (request: { seq: number; kind: 'prep'|'chapter'|'volume'; id: string; path: string }) => {
  let store: ProjectStore | undefined;
  try {
    store = new ProjectStore(request.path, { readOnly:true });
    // Each answer comes from one consistent committed snapshot; no stale cross-request cache.
    store.db.raw.exec('BEGIN');
    const value = request.kind === 'prep' ? readPrepStatus(store, request.id)
      : withAuditStatus(store, request.kind === 'chapter' ? store.projects.listParagraphViews(request.id) : store.projects.listParagraphViewsByVolume(request.id));
    store.db.raw.exec('COMMIT');
    parentPort!.postMessage({ seq:request.seq, value });
  } catch (error) { parentPort!.postMessage({ seq:request.seq, error:(error as Error).message }); }
  finally { store?.close(); }
});
