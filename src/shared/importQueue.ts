import type { ImportPreflight, ImportSummary } from './ipc';

export interface ImportQueueTarget { seriesId: string | null; title: string; volumeNumber: number }
export interface ImportQueueEntry {
  id: string; path: string; name: string;
  state: 'pending' | 'inspected' | 'importing' | 'done' | 'error';
  report: ImportPreflight | null; result: ImportSummary | null; error: string | null;
}
export interface ImportQueueState {
  version: 1; id: string; revision: number; updatedAt: string;
  target: ImportQueueTarget; entries: ImportQueueEntry[];
}

/** Damage diagnostics contain no raw stored content. Quarantine is preservation, not repair. */
export interface ImportQueueDamage {
  id: string;
  fingerprint: string;
  message: string;
}
