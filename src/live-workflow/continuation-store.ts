import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { inside, text } from '../policy/validation.js';
import { budgetKeys } from './native-executor-contracts.js';
import { digestText, hash, serialize, subset, validateCheckpoint } from './continuation-validation.js';
import type { ContinuationCheckpoint, StoredContinuation } from './continuation-contracts.js';

function uid(): number {
  if (!process.getuid) throw new Error('continuation owner mode requires POSIX');
  return process.getuid();
}
/** Reject links and writable ancestors. Root-owned sticky temporary parents are supported. */
export function safeAncestors(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('absolute canonical path required');
  const paths: string[] = [];
  for (let current = path;; current = dirname(current)) {
    paths.unshift(current);
    if (dirname(current) === current) break;
  }
  for (const current of paths) {
    const st = lstatSync(current);
    const stickyRoot = st.uid === 0 && Boolean(st.mode & 0o1000) && current !== path;
    if (!st.isDirectory() || st.isSymbolicLink() || ![0, uid()].includes(st.uid) ||
        ((st.mode & 0o022) !== 0 && !stickyRoot)) throw new Error('unsafe path ancestor');
  }
  if (realpathSync(path) !== path) throw new Error('noncanonical private path');
}
export function privateFile(path: string): void {
  safeAncestors(dirname(path));
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('noncanonical file path');
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== uid() || (st.mode & 0o777) !== 0o600) throw new Error('owner file must be regular, unlinked and 0600');
}
export interface ContinuationStoreOptions {
  workspaceRoot: string;
  projectId: string;
  stateDirectory: string;
  /** Host source reader; production CLI uses sourceIdentity, tests inject a pure getter. */
  source: () => string;
  clock?: () => number;
}
type Consumption = { status: string; instance: string | null; fence: number | null };
export class ContinuationStore {
  readonly root: string;
  readonly projectId: string;
  readonly stateDirectory: string;
  readonly #db: DatabaseSync;
  readonly #options: ContinuationStoreOptions;
  #closed = false;
  constructor(options: ContinuationStoreOptions) {
    this.#options = { ...options };
    text(options.projectId, 'project', 128);
    this.root = realpathSync(options.workspaceRoot);
    if (resolve(options.workspaceRoot) !== this.root) throw new Error('canonical workspace required');
    this.projectId = options.projectId;
    const state = options.stateDirectory;
    if (!isAbsolute(state) || resolve(state) !== state || inside(this.root, state) || inside(state, this.root)) throw new Error('state must be outside workspace');
    safeAncestors(dirname(state));
    try { mkdirSync(state, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    this.stateDirectory = state;
    this.#directory();
    const file = join(state, 'continuation.sqlite');
    try {
      const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { if (fstatSync(fd).nlink !== 1) throw new Error('unsafe new database'); } finally { closeSync(fd); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    this.#files();
    this.#db = new DatabaseSync(file);
    try {
      this.#db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;
        CREATE TABLE IF NOT EXISTS registration (id INTEGER PRIMARY KEY CHECK(id=1), project TEXT NOT NULL, root TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS checkpoints (digest TEXT PRIMARY KEY, json TEXT NOT NULL, task TEXT NOT NULL, parent TEXT UNIQUE REFERENCES checkpoints(digest));
        CREATE UNIQUE INDEX IF NOT EXISTS one_task_origin ON checkpoints(task) WHERE parent IS NULL;
        CREATE TABLE IF NOT EXISTS consumption (digest TEXT PRIMARY KEY REFERENCES checkpoints(digest), status TEXT NOT NULL, instance TEXT UNIQUE, fence INTEGER);
        CREATE TABLE IF NOT EXISTS heads (task TEXT PRIMARY KEY, instance TEXT NOT NULL, fence INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS cancellations (task TEXT PRIMARY KEY);
        CREATE TRIGGER IF NOT EXISTS immutable_checkpoint_update BEFORE UPDATE ON checkpoints BEGIN SELECT RAISE(ABORT,'immutable checkpoint'); END;
        CREATE TRIGGER IF NOT EXISTS immutable_checkpoint_delete BEFORE DELETE ON checkpoints BEGIN SELECT RAISE(ABORT,'immutable checkpoint'); END;`);
      this.#transaction(() => {
        const row = this.#db.prepare('SELECT project,root FROM registration WHERE id=1').get();
        if (row && (row.project !== this.projectId || row.root !== this.root)) throw new Error('continuation registration mismatch');
        if (!row) this.#db.prepare('INSERT INTO registration VALUES(1,?,?)').run(this.projectId, this.root);
      });
    } catch (error) { this.#db.close(); throw error; }
  }
  #directory(): void {
    safeAncestors(this.stateDirectory);
    const st = lstatSync(this.stateDirectory);
    if (st.uid !== uid() || (st.mode & 0o777) !== 0o700) throw new Error('state directory must be owner-private 0700');
  }
  #files(): void {
    this.#directory();
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try { privateFile(join(this.stateDirectory, `continuation.sqlite${suffix}`)); }
      catch (error) { if (suffix && (error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    }
  }
  #safe(): void {
    if (this.#closed) throw new Error('closed continuation store');
    this.#files();
    if (realpathSync(this.root) !== this.root) throw new Error('workspace moved');
  }
  #transaction<T>(work: () => T): T {
    this.#safe(); this.#db.exec('BEGIN IMMEDIATE');
    try { const value = work(); this.#db.exec('COMMIT'); return value; }
    catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  now(): number { return (this.#options.clock ?? Date.now)(); }
  currentSource(): string { this.#safe(); const source = this.#options.source(); digestText(source); return source; }
  #read(digest: string): StoredContinuation {
    digestText(digest);
    const row = this.#db.prepare('SELECT json,task,parent FROM checkpoints WHERE digest=?').get(digest);
    if (!row || typeof row.json !== 'string' || Buffer.byteLength(row.json) > 262144) throw new Error('missing or oversized checkpoint');
    const checkpoint = validateCheckpoint(JSON.parse(row.json));
    if (hash(checkpoint) !== digest || serialize(checkpoint) !== row.json || row.task !== checkpoint.taskId || row.parent !== checkpoint.parentDigest ||
        checkpoint.root !== this.root || checkpoint.projectId !== this.projectId) throw new Error('checkpoint integrity mismatch');
    return Object.freeze({ digest, checkpoint });
  }
  #transition(parent: Readonly<ContinuationCheckpoint>, child: Readonly<ContinuationCheckpoint>): void {
    if (parent.taskId !== child.taskId || parent.projectId !== child.projectId || parent.root !== child.root ||
        child.createdAt < parent.createdAt || child.expiresAt > parent.expiresAt ||
        serialize(child.budget.limit) !== serialize(parent.budget.limit) ||
        budgetKeys.some(key => child.budget.used[key] < parent.budget.used[key]) ||
        !subset(child.requestCapabilities, parent.requestCapabilities) || child.objective !== parent.objective ||
        serialize(child.acceptanceCriteria) !== serialize(parent.acceptanceCriteria)) throw new Error('parent binding or cumulative budget reset');
    if (parent.status === 'cancelled' || parent.status === 'completed') throw new Error('terminal parent');
    const drift = parent.sourceIdentity !== child.sourceIdentity || parent.policyVersion !== child.policyVersion;
    const unresolved = parent.pendingEffects.filter(effect => effect.status !== 'reconciled');
    if ((drift || unresolved.length || parent.status === 'indeterminate' || parent.reconciliation.status === 'required') && child.reconciliation.status !== 'owner-reconciled') throw new Error('owner reconciliation required');
    if (drift && (child.hypotheses.length || child.decisions.length)) throw new Error('invalidate assumptions after drift');
    for (const effect of unresolved) {
      if (!child.pendingEffects.some(next => next.id === effect.id && next.status === 'reconciled' && next.evidenceIds.length)) throw new Error('unresolved parent effect');
    }
  }
  inspect(digest: string): StoredContinuation {
    this.#safe();
    const result = this.#read(digest);
    let child = result;
    const seen = new Set<string>();
    while (child.checkpoint.parentDigest !== null) {
      if (seen.size >= 256 || seen.has(child.digest)) throw new Error('invalid parent chain');
      seen.add(child.digest);
      const parent = this.#read(child.checkpoint.parentDigest);
      this.#transition(parent.checkpoint, child.checkpoint); child = parent;
    }
    return result;
  }
  /** Owner-only evidence publication. Source is read afresh, never supplied as a ready flag. */
  save(input: unknown): StoredContinuation {
    const checkpoint = validateCheckpoint(input);
    return this.#transaction(() => {
      const now = this.now();
      if (checkpoint.projectId !== this.projectId || checkpoint.root !== this.root || checkpoint.createdAt > now || checkpoint.expiresAt <= now ||
          checkpoint.sourceIdentity !== this.currentSource()) throw new Error('checkpoint current binding mismatch');
      if (this.cancelled(checkpoint.taskId)) throw new Error('task cancelled');
      const digest = hash(checkpoint);
      const existing = this.#db.prepare('SELECT digest FROM checkpoints WHERE digest=?').get(digest);
      if (existing) return this.inspect(digest);
      if (checkpoint.parentDigest !== null) {
        const parent = this.inspect(checkpoint.parentDigest).checkpoint;
        this.#transition(parent, checkpoint);
        const state = this.#consumption(checkpoint.parentDigest);
        if (['reserved', 'failed'].includes(state.status) && checkpoint.reconciliation.status !== 'owner-reconciled') throw new Error('interrupted preparation requires owner reconciliation');
      }
      this.#db.prepare('INSERT INTO checkpoints VALUES(?,?,?,?)').run(digest, serialize(checkpoint), checkpoint.taskId, checkpoint.parentDigest);
      this.#db.prepare("INSERT INTO consumption(digest,status) VALUES(?,'saved')").run(digest);
      return Object.freeze({ digest, checkpoint });
    });
  }
  #consumption(digest: string): Consumption {
    const row = this.#db.prepare('SELECT status,instance,fence FROM consumption WHERE digest=?').get(digest);
    if (!row || typeof row.status !== 'string') throw new Error('missing checkpoint consumption');
    return row as unknown as Consumption;
  }
  cancelled(taskId: string): boolean {
    this.#safe(); text(taskId, 'task', 128);
    return Boolean(this.#db.prepare('SELECT task FROM cancellations WHERE task=?').get(taskId));
  }
  cancel(taskId: string): void {
    text(taskId, 'task', 128);
    this.#transaction(() => { this.#db.prepare('INSERT OR IGNORE INTO cancellations VALUES(?)').run(taskId); });
  }
  /** Irreversible CAS. A reserved checkpoint is never automatically retried, even after a crash. */
  consume(digest: string, instance: string): number {
    text(instance, 'instance', 128);
    return this.#transaction(() => {
      const { checkpoint } = this.inspect(digest);
      if (checkpoint.expiresAt <= this.now() || this.cancelled(checkpoint.taskId) || checkpoint.status !== 'ready' ||
          checkpoint.reconciliation.status === 'required' || checkpoint.pendingEffects.some(e => e.status !== 'reconciled') || instance === checkpoint.origin.instanceId) throw new Error('checkpoint not runnable');
      if (this.#db.prepare('SELECT digest FROM checkpoints WHERE parent=?').get(digest)) throw new Error('checkpoint superseded by child');
      if (this.#consumption(digest).status !== 'saved') throw new Error('checkpoint already consumed');
      const head = this.#db.prepare('SELECT fence FROM heads WHERE task=?').get(checkpoint.taskId);
      const fence = head ? Number(head.fence) + 1 : 1;
      if (!Number.isSafeInteger(fence)) throw new Error('fence exhausted');
      this.#db.prepare("UPDATE consumption SET status='reserved',instance=?,fence=? WHERE digest=? AND status='saved'").run(instance, fence, digest);
      this.#db.prepare('INSERT INTO heads VALUES(?,?,?) ON CONFLICT(task) DO UPDATE SET instance=excluded.instance,fence=excluded.fence').run(checkpoint.taskId, instance, fence);
      return fence;
    });
  }
  terminalize(digest: string, instance: string, fence: number, status: 'prepared' | 'failed'): void {
    this.#transaction(() => {
      const state = this.#consumption(digest);
      if (state.status !== 'reserved' || state.instance !== instance || state.fence !== fence) throw new Error('inactive preparation');
      this.#db.prepare('UPDATE consumption SET status=? WHERE digest=?').run(status, digest);
    });
  }
  checkFence(digest: string, instance: string, fence: number, preparing = false): void {
    const { checkpoint } = this.inspect(digest);
    const state = this.#consumption(digest);
    const head = this.#db.prepare('SELECT instance,fence FROM heads WHERE task=?').get(checkpoint.taskId);
    if (state.status !== (preparing ? 'reserved' : 'prepared') || state.instance !== instance || state.fence !== fence ||
        head?.instance !== instance || head.fence !== fence || this.cancelled(checkpoint.taskId) || checkpoint.expiresAt <= this.now()) throw new Error('stale fence, cancellation or expiry');
  }
  close(): void { if (!this.#closed) { this.#db.close(); this.#closed = true; } }
}
