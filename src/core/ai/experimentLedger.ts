import { DatabaseSync } from 'node:sqlite';
import { closeSync, openSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

export const EXPERIMENT_ENDPOINT = 'https://opencode.ai/zen/go/v1/chat/completions';
export const OFFICIAL_EXPERIMENT_ENDPOINT = 'https://api.deepseek.com/chat/completions';
// User authorized continued same-book tests and finite increases; allocation is 6000.
// Raising this ceiling alone never changes an existing ledger or clears its stop.
export const OFFICIAL_EXPERIMENT_CEILING = 6000;
export interface ExperimentConfig {
  /** One fixed, local path for the entire experiment, outside any book/library. Never rotate it on restart. */
  ledgerPath: string;
  /** Explicit first-time creation only. Reopening a missing ledger fails closed. */
  create?: boolean;
  maxRequests?: number;
  concurrency?: number;
  networkRetries?: number;
  timeoutMs?: number;
  endpoint?: typeof EXPERIMENT_ENDPOINT | typeof OFFICIAL_EXPERIMENT_ENDPOINT;
  /** Explicit diagnostic bootstrap only; ordinary experiment calls remain disabled. */
  thinkingComparison?: 'stage-20260911';
}
export class ExperimentStopped extends Error {
  constructor(readonly reason: 'request-limit' | 'consecutive-failures' | 'storage' | 'configuration' | 'endpoint' | 'incompatible-response') {
    super(`隔离评测已停止：${reason}`); this.name = 'ExperimentStopped';
  }
}
export type ExperimentOutcome = 'success' | 'http' | 'network' | 'timeout' | 'abort' | 'shape' | 'truncated' | 'protocol' | 'crash' | 'incompatible';
interface State { max_requests: number; concurrency: number; retries: number; timeout_ms: number; failures: number; stopped: number }
interface Pending { id: string; pid: number }
const validToken = (v: number | null): number | null => v !== null && Number.isSafeInteger(v) && v >= 0 ? v : null;

/** Separate SQLite file, FULL synchronous commits + BEGIN IMMEDIATE serialize reservations across processes.
 * Reserved rows are never deleted/refunded. No time-based lease stealing: a slow live process retains its slot.
 * A provably dead local process releases only its concurrency slot, never its request allowance.
 */
export class ExperimentLedger {
  private readonly db: DatabaseSync;
  private broken = false;
  readonly endpoint: string;
  readonly thinkingComparison: boolean;
  readonly limits: Readonly<{ maxRequests: number; concurrency: number; networkRetries: number; timeoutMs: number }>;
  constructor(config: ExperimentConfig) {
    this.endpoint = config.endpoint ?? EXPERIMENT_ENDPOINT;
    this.thinkingComparison = config.thinkingComparison === 'stage-20260911';
    if (config.thinkingComparison !== undefined && (!this.thinkingComparison || this.endpoint !== OFFICIAL_EXPERIMENT_ENDPOINT)) throw new ExperimentStopped('configuration');
    if (![EXPERIMENT_ENDPOINT, OFFICIAL_EXPERIMENT_ENDPOINT].includes(this.endpoint)) throw new ExperimentStopped('endpoint');
    const limits = { maxRequests: config.maxRequests ?? 1200, concurrency: config.concurrency ?? 1, networkRetries: config.networkRetries ?? 2, timeoutMs: config.timeoutMs ?? 180_000 };
    const authorizedCeiling = this.endpoint === OFFICIAL_EXPERIMENT_ENDPOINT ? OFFICIAL_EXPERIMENT_CEILING : 1200;
    if (!isAbsolute(config.ledgerPath) || /^(?:\\\\|\/\/)/.test(config.ledgerPath) || !Number.isSafeInteger(limits.maxRequests) || limits.maxRequests < 1 || limits.maxRequests > authorizedCeiling || !Number.isSafeInteger(limits.concurrency) || limits.concurrency < 1 || !Number.isSafeInteger(limits.networkRetries) || limits.networkRetries < 0 || limits.networkRetries > 2 || !Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs < 1 || limits.timeoutMs > 180_000) throw new ExperimentStopped('configuration');
    this.limits = Object.freeze(limits);
    let db: DatabaseSync | undefined;
    try {
      // Exclusive creation is deliberate: neither a typo nor a missing file silently resets the budget.
      if (config.create) closeSync(openSync(config.ledgerPath, 'wx', 0o600));
      else closeSync(openSync(config.ledgerPath, 'r+'));
      db = new DatabaseSync(config.ledgerPath);
      this.db = db;
      db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
      this.transaction(() => {
        if (config.create) {
          db!.exec(`CREATE TABLE experiment (id INTEGER PRIMARY KEY CHECK(id=1), max_requests INTEGER NOT NULL, concurrency INTEGER NOT NULL, retries INTEGER NOT NULL, timeout_ms INTEGER NOT NULL, failures INTEGER NOT NULL DEFAULT 0, stopped INTEGER NOT NULL DEFAULT 0, not_before INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE requests (id TEXT PRIMARY KEY, pid INTEGER NOT NULL, reserved_at INTEGER NOT NULL, finished_at INTEGER, active INTEGER NOT NULL DEFAULT 1, outcome TEXT, input_tokens INTEGER, output_tokens INTEGER, unknown_usage INTEGER NOT NULL DEFAULT 1);`);
          db!.prepare('INSERT INTO experiment(id,max_requests,concurrency,retries,timeout_ms) VALUES(1,?,?,?,?)').run(limits.maxRequests, limits.concurrency, limits.networkRetries, limits.timeoutMs);
          db!.exec('CREATE TABLE experiment_endpoint (id INTEGER PRIMARY KEY CHECK(id=1), endpoint TEXT NOT NULL)');
          db!.prepare('INSERT INTO experiment_endpoint VALUES(1,?)').run(this.endpoint);
        }
        const hasEndpoint = db!.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='experiment_endpoint'").get();
        const savedEndpoint = hasEndpoint ? db!.prepare('SELECT endpoint FROM experiment_endpoint WHERE id=1').get()?.endpoint : EXPERIMENT_ENDPOINT;
        if (savedEndpoint !== this.endpoint) throw new ExperimentStopped('endpoint');
        const state = this.state();
        if (state.max_requests !== limits.maxRequests || state.concurrency !== limits.concurrency || state.retries !== limits.networkRetries || state.timeout_ms !== limits.timeoutMs) throw new ExperimentStopped('configuration');
      });
    } catch (error) { try { db?.close(); } catch { /* preserve safe error */ } throw error instanceof ExperimentStopped ? error : new ExperimentStopped('storage'); }
  }
  private state(): State { const row = this.db.prepare('SELECT * FROM experiment WHERE id=1').get(); if (!row) throw new ExperimentStopped('storage'); return row as unknown as State; }
  private transaction<T>(fn: () => T): T {
    if (this.broken) throw new ExperimentStopped('storage');
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* a failed BEGIN has nothing to roll back */ }
      if (error instanceof ExperimentStopped) throw error;
      this.broken = true;
      throw new ExperimentStopped('storage');
    }
  }
  /** Read-only early rejection; reserve() remains the final cross-process transaction.
   * Never recover, reserve, refund or clear a stop during this preflight.
   */
  assertRunnable(): void {
    if (this.broken) throw new ExperimentStopped('storage');
    try {
      const row = this.db.prepare('SELECT stopped,max_requests,(SELECT COUNT(*) FROM requests) AS requests FROM experiment WHERE id=1').get();
      if (!row) throw new ExperimentStopped('storage');
      if (Number(row.stopped) === 2) throw new ExperimentStopped('incompatible-response');
      if (Number(row.stopped)) throw new ExperimentStopped('consecutive-failures');
      if (Number(row.requests) >= Number(row.max_requests)) throw new ExperimentStopped('request-limit');
    } catch (error) { throw error instanceof ExperimentStopped ? error : new ExperimentStopped('storage'); }
  }
  private recoverDeadProcesses(): void {
    const pending = this.db.prepare('SELECT id,pid FROM requests WHERE active=1').all() as unknown as Pending[];
    for (const row of pending) {
      try { process.kill(row.pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue;
        this.finishInTransaction(row.id, 'crash', null, null);
      }
    }
  }
  /** null means another process owns the concurrency slot or a Retry-After wait is active. */
  reserve(): string | null {
    const reservation = this.transaction(() => {
      this.recoverDeadProcesses();
      const state = this.state();
      // Return stop reason after COMMIT so crash recovery is not rolled back by the stop itself.
      // stopped=2 is a sticky compatibility stop; old ledgers keep stopped=1
      // for consecutive failures. Both states prohibit any new reservation.
      if (state.stopped === 2) return '!incompatible-response';
      if (state.stopped) return '!consecutive-failures';
      const count = Number(this.db.prepare('SELECT COUNT(*) AS n FROM requests').get()!.n);
      if (count >= state.max_requests) return '!request-limit';
      const active = Number(this.db.prepare('SELECT COUNT(*) AS n FROM requests WHERE active=1').get()!.n);
      const notBefore = Number(this.db.prepare('SELECT not_before FROM experiment WHERE id=1').get()!.not_before);
      if (active >= state.concurrency || Date.now() < notBefore) return null;
      const id = randomUUID();
      this.db.prepare('INSERT INTO requests(id,pid,reserved_at) VALUES(?,?,?)').run(id, process.pid, Date.now());
      return id;
    });
    if (reservation === '!incompatible-response') throw new ExperimentStopped('incompatible-response');
    if (reservation === '!request-limit') throw new ExperimentStopped('request-limit');
    if (reservation === '!consecutive-failures') throw new ExperimentStopped('consecutive-failures');
    return reservation;
  }
  finish(id: string, outcome: ExperimentOutcome, input: number | null = null, output: number | null = null, retryAfterMs = 0): void {
    this.transaction(() => {
      this.finishInTransaction(id, outcome, input, output);
      if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) this.db.prepare('UPDATE experiment SET not_before=MAX(not_before,?) WHERE id=1').run(Date.now() + retryAfterMs);
    });
  }
  private finishInTransaction(id: string, outcome: ExperimentOutcome, input: number | null, output: number | null): void {
    const i = validToken(input), o = validToken(output);
    const result = this.db.prepare('UPDATE requests SET active=0,finished_at=?,outcome=?,input_tokens=?,output_tokens=?,unknown_usage=? WHERE id=? AND active=1').run(Date.now(), outcome, i, o, i === null || o === null ? 1 : 0, id);
    if (!result.changes) return;
    if (outcome === 'incompatible') this.db.prepare('UPDATE experiment SET failures=failures+1,stopped=2 WHERE id=1').run();
    else if (outcome === 'success') this.db.prepare('UPDATE experiment SET failures=0 WHERE id=1 AND stopped=0').run();
    else if (outcome !== 'abort') this.db.prepare('UPDATE experiment SET failures=failures+1,stopped=CASE WHEN stopped<>0 THEN stopped WHEN failures+1>=3 THEN 1 ELSE 0 END WHERE id=1').run();
  }
  snapshot(): { requests: number; active: number; inputTokens: number; outputTokens: number; unknownUsageRequests: number; consecutiveFailures: number; stopped: boolean } {
    const row = this.db.prepare('SELECT COUNT(*) AS n,COALESCE(SUM(active),0) AS active,COALESCE(SUM(input_tokens),0) AS i,COALESCE(SUM(output_tokens),0) AS o,COALESCE(SUM(unknown_usage),0) AS u FROM requests').get()!;
    const state = this.state();
    return { requests: Number(row.n), active: Number(row.active), inputTokens: Number(row.i), outputTokens: Number(row.o), unknownUsageRequests: Number(row.u), consecutiveFailures: state.failures, stopped: !!state.stopped };
  }
  close(): void { this.db.close(); }
}

// Opt-in process bootstrap only; ordinary product execution never creates/opens this ledger.
// No disable/reset API: once enabled, every adapter call remains protected until process exit.
let processLedger: ExperimentLedger | undefined;
let configurationFailed = false;
export function configureProcessExperiment(config: ExperimentConfig): ExperimentLedger {
  if (processLedger || configurationFailed) throw new ExperimentStopped('configuration');
  try { processLedger = new ExperimentLedger(config); return processLedger; }
  catch (error) { configurationFailed = true; throw error; }
}
export function getProcessExperiment(): ExperimentLedger | undefined {
  if (configurationFailed) throw new ExperimentStopped('configuration');
  return processLedger;
}
export function validateExperimentEndpoint(url: string): void {
  // Exact spelling deliberately rejects credentials, query/fragment, encoded traversal and alternate ports.
  if (url !== (getProcessExperiment()?.endpoint ?? EXPERIMENT_ENDPOINT)) throw new ExperimentStopped('endpoint');
}
