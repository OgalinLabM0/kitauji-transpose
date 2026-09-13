import { api } from '../api';
import { DraftIdentityScope } from './draftIdentity';

export const draftIdentity = new DraftIdentityScope();
export const refreshDraftIdentity = (prepare?: () => Promise<void>) => draftIdentity.load(() => api.app.getLibraryIdentity(), prepare);
/** Subscribe before the first read; event data can only invalidate/reload, never declare an ID. */
export function connectDraftIdentity(prepare?: () => Promise<void>): () => void {
  let active = true;
  const reload = () => { if (active) void refreshDraftIdentity(prepare); };
  const stop = api.on('library-identity', state => {
    if (state === 'ready') reload();
    else draftIdentity.invalidate();
  });
  reload();
  return () => { active = false; stop(); draftIdentity.invalidate(); };
}
