import { DatabaseSync } from 'node:sqlite';
import { lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep, isAbsolute } from 'node:path';
import { privateDirectory } from './authority.js';
import { sha256 } from './validation.js';
import { budgetKeys, nativeSchema, validateBudget } from './native-executor-contracts.js';
import type { NativeTask, NativeCheckpoint, BudgetKey } from './native-executor-contracts.js';

function bindingFor(task: NativeTask): string {
  return sha256(JSON.stringify({ ...task, source: undefined }));
}

/** Validate the real workspace before creating any owner state. */
function canonicalWorkspace(root: string): string {
  if (root !== resolve(root) || realpathSync(root) !== root || !lstatSync(root).isDirectory()) {
    throw new Error('Canonical real workspace directory required');
  }
  return root;
}

function validateCheckpoint(raw: unknown, task: NativeTask): asserts raw is NativeCheckpoint {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid checkpoint schema');
  const value = raw as NativeCheckpoint;
  const expected = 'binding,counters,pending,schema,seen,source,stage,status,thread';
  const boundedThread = value.thread === null || (typeof value.thread === 'string' && value.thread.length <= 256);
  const boundedStage = typeof value.stage === 'string' && value.stage.length <= 128;
  const pending = value.pending === null || typeof value.pending === 'string';
  const strings = typeof value.schema === 'string' && typeof value.binding === 'string' && typeof value.source === 'string';
  if (Object.keys(value).sort().join() !== expected || !boundedThread || !boundedStage || !pending || !strings) {
    throw new Error('Invalid checkpoint schema');
  }
  if (!value.counters || typeof value.counters !== 'object' || Array.isArray(value.counters) ||
      Object.keys(value.counters).sort().join() !== [...budgetKeys].sort().join()) {
    throw new Error('Invalid checkpoint counters');
  }
  for (const key of budgetKeys) {
    const count = value.counters[key];
    if (!Number.isSafeInteger(count) || count < 0 || count > task.budget[key]) {
      throw new Error('Invalid checkpoint counters');
    }
  }
  const seen = value.seen;
  if (!Array.isArray(seen) || seen.length > task.budget.toolCalls ||
      seen.some(call => typeof call !== 'string' || !call || call.length > 128) ||
      new Set(seen).size !== seen.length ||
      !['ready', 'running', 'completed', 'stopped', 'indeterminate'].includes(value.status)) {
    throw new Error('Invalid checkpoint schema');
  }
}

/** Owner-only durable state, never placed in the worker's filesystem. */
export class NativeState {
  readonly #db: DatabaseSync;
  readonly #task: NativeTask;
  #value: NativeCheckpoint;
  #saved: string | null = null;

  constructor(directory: string, task: NativeTask) {
    validateBudget(task.budget);
    const root = canonicalWorkspace(task.root);
    this.#task = structuredClone(task);
    const dir = privateDirectory(directory);
    const rel = relative(root, dir);
    if (!(rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))) {
      throw new Error('State must be outside workspace');
    }
    const file = join(dir, 'native.sqlite');
    try {
      writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
        stat.uid !== process.getuid?.() || stat.mode & 0o077) {
      throw new Error('Unsafe checkpoint');
    }
    this.#db = new DatabaseSync(file);
    try {
      this.#db.exec('PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS checkpoint(id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)');
      const row = this.#db.prepare('SELECT value FROM checkpoint WHERE id=1').get();
      const binding = bindingFor(task);
      const raw: unknown = row ? JSON.parse(String(row.value)) : {
        schema: nativeSchema, binding, source: task.source, thread: null,
        stage: 'new', pending: null, seen: [], status: 'ready',
        counters: Object.fromEntries(budgetKeys.map(key => [key, 0])),
      };
      validateCheckpoint(raw, task);
      this.#value = raw;
      if (raw.schema !== nativeSchema || raw.binding !== binding || raw.source !== task.source) {
        throw new Error('Checkpoint binding mismatch');
      }
      if (raw.pending || ['running', 'indeterminate'].includes(raw.status)) {
        throw new Error('Interrupted operation requires owner reconciliation; no automatic replay');
      }
      if (row) this.#saved = String(row.value);
      this.#save();
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  matches(task: NativeTask): boolean {
    return this.#value.binding === bindingFor(task) && this.#value.source === task.source;
  }
  get value(): NativeCheckpoint { return structuredClone(this.#value); }

  #save(): void {
    const value = JSON.stringify(this.#value);
    const result = this.#saved === null
      ? this.#db.prepare('INSERT OR IGNORE INTO checkpoint VALUES(1,?)').run(value)
      : this.#db.prepare('UPDATE checkpoint SET value=? WHERE id=1 AND value=?').run(value, this.#saved);
    if (Number(result.changes) !== 1) throw new Error('Concurrent checkpoint owner; reacquire fresh authority');
    this.#saved = value;
  }

  charge(key: BudgetKey, count: number): void {
    if (!Number.isSafeInteger(count) || count < 0 ||
        this.#value.counters[key] + count > this.#task.budget[key]) {
      throw new Error('Native budget exhausted: ' + key);
    }
    this.#value.counters[key] += count;
    this.#save();
  }
  update(patch: Partial<Pick<NativeCheckpoint, 'thread' | 'stage' | 'pending' | 'status' | 'source'>>): void {
    Object.assign(this.#value, patch);
    this.#save();
  }
  claim(call: string): void {
    if (this.#value.seen.includes(call)) throw new Error('Replayed callback');
    if (this.#value.counters.toolCalls >= this.#task.budget.toolCalls) throw new Error('Native budget exhausted: toolCalls');
    if (!call || call.length > 128) throw new Error('Invalid callback identity');
    this.#value.counters.toolCalls++;
    this.#value.seen.push(call);
    this.#save();
  }
  close(): void { this.#db.close(); }
}
