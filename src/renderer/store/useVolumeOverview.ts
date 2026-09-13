import { useEffect, useState } from 'react';
import type { VolumeOverview } from '@shared/ipc';
import { api } from '../api';
import { useApp } from './app';

export function useVolumeOverview(volumeId: string) {
  const { rev, progress } = useApp();
  const key = JSON.stringify([volumeId, rev, progress.running]);
  const [result, setResult] = useState<{ key: string; value: VolumeOverview | null; error: string } | null>(null);
  useEffect(() => {
    let active = true;
    if (progress.running) { setResult(null); return; }
    void api.workflow.volumeOverview(volumeId)
      .then(value => { if (active) setResult({ key, value, error: '' }); })
      .catch(e => { if (active) setResult({ key, value: null, error: String(e) }); });
    return () => { active = false; };
  }, [key, volumeId, progress.running]);
  // Never display a previous revision's green state while its refresh is pending.
  return { value: result?.key === key ? result.value : null, error: result?.key === key ? result.error : '', running: progress.running };
}
