import type { ProjectStore } from '@core/db';
import { nowIso } from '@core/db';

export interface RepairJob { id: string; paragraph_id: string; workstation_id: string; base_final_id: string | null }
/** Durable, idempotent follow-up jobs. A queue decision is not a completed repair. */
export class RepairQueue {
  constructor(private readonly store: ProjectStore) {}
  recover(): void {
    this.store.db.run("UPDATE workflow_tasks SET status='queued', error_message='上次运行中断，等待继续', updated_at=? WHERE workstation_id LIKE 'repair:%' AND status='running'", [nowIso()]);
  }
  enqueue(queueId: string, paragraphId: string): void {
    const id = `repair:${queueId}:${paragraphId}`;
    const baseFinalId = this.store.translations.latestFinal(paragraphId)?.id ?? null;
    this.store.db.run(`INSERT INTO workflow_tasks(id,workstation_id,paragraph_id,base_final_id,status,created_at,updated_at) VALUES(?,?,?,?,'queued',?,?)
      ON CONFLICT(id) DO UPDATE SET status=CASE WHEN workflow_tasks.status='running' THEN 'running' ELSE 'queued' END,
      base_final_id=CASE WHEN workflow_tasks.status='running' THEN workflow_tasks.base_final_id ELSE excluded.base_final_id END,
      error_message=NULL, updated_at=excluded.updated_at`, [id, `repair:${queueId}`, paragraphId, baseFinalId, nowIso(), nowIso()]);
  }
  claim(): RepairJob | undefined {
    return this.store.transaction(() => {
      const job = this.store.db.get<RepairJob>("SELECT id, paragraph_id, workstation_id, base_final_id FROM workflow_tasks WHERE workstation_id LIKE 'repair:%' AND status='queued' ORDER BY created_at, id LIMIT 1");
      if (job) this.store.db.run("UPDATE workflow_tasks SET status='running', retry_count=retry_count+1, updated_at=? WHERE id=?", [nowIso(), job.id]);
      return job;
    });
  }
  finish(job: RepairJob, status: 'done' | 'failed' | 'queued', message: string | null = null): void {
    this.store.transaction(() => {
      this.store.db.run('UPDATE workflow_tasks SET status=?, error_message=?, updated_at=? WHERE id=?', [status, message, nowIso(), job.id]);
      if (status === 'failed' && this.store.projects.getParagraph(job.paragraph_id)) {
        const seriesId = this.store.projects.getSeriesIdOfParagraph(job.paragraph_id);
        if (!this.store.translations.hasPending(seriesId, 'failed', job.id)) this.store.translations.enqueue({ seriesId, paragraphId: job.paragraph_id, kind: 'failed', groupKey: job.id, title: message ?? '决定后重译未完成', payload: { repairJobId: job.id, error: message } });
      }
      if (status === 'done') this.store.db.run("UPDATE workflow_tasks SET status='done', error_message=NULL, updated_at=? WHERE paragraph_id=? AND workstation_id LIKE 'repair:%' AND status='failed'", [nowIso(), job.paragraph_id]);
    });
  }
  canApply(job: RepairJob): boolean { return (this.store.translations.latestFinal(job.paragraph_id)?.id ?? null) === job.base_final_id; }
  counts(): { queued: number; failed: number } {
    const count = (status: string) => this.store.db.get<{n: number}>("SELECT COUNT(*) AS n FROM workflow_tasks WHERE workstation_id LIKE 'repair:%' AND status=?", [status])?.n ?? 0;
    return { queued: count('queued'), failed: count('failed') };
  }
}
