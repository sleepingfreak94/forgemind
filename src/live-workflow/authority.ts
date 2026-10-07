import { mkdirSync, lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { LocalPolicyRuntime } from '../policy/runtime.js';
import { serialize } from '../context-engine/validation.js';
import { sha256 } from './validation.js';
import type { ActionAuthority, ActionEnvelope, ActionReceipt, LiveTask } from './contracts.js';
export function privateDirectory(path: string): string {
  const absolute = resolve(path);
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  const s = lstatSync(absolute);
  if (
    realpathSync(absolute) !== absolute ||
    s.isSymbolicLink() ||
    !s.isDirectory() ||
    s.uid !== process.getuid?.() ||
    s.mode & 0o077
  )
    throw new Error('Private owner state directory required');
  return absolute;
}
/** Trusted owner facade. No worker receives this object, state paths, or credentials. */
export class RunAuthority implements ActionAuthority {
  readonly directory: string;
  readonly #runtime: LocalPolicyRuntime;
  readonly #db: DatabaseSync;
  readonly #task: LiveTask;
  readonly #deadline: number;
  #source: string;
  #closed = false;
  #finished = false;
  constructor(
    stateDirectory: string,
    workspace: string,
    repositoryId: string,
    task: LiveTask,
    source: string,
  ) {
    this.directory = privateDirectory(stateDirectory);
    if (!relative(workspace, this.directory).startsWith('..'))
      throw new Error('State must be outside worker workspace');
    const dbPath = join(this.directory, 'run.sqlite');
    try {
      writeFileSync(dbPath, '', { flag: 'wx', mode: 0o600 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const s = lstatSync(dbPath);
    if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid?.() || s.mode & 0o077)
      throw new Error('Unsafe ledger');
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec(
      'PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS run(id TEXT PRIMARY KEY, task TEXT NOT NULL, status TEXT NOT NULL, requests INTEGER NOT NULL, input_bytes INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS phases(seq INTEGER PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL, data TEXT NOT NULL);',
    );
    if (this.#db.prepare('SELECT 1 FROM run').get()) {
      this.#db.close();
      throw new Error('Task state already exists; reconcile existing run, never replay automatically');
    }
    this.#db.prepare('INSERT INTO run VALUES(?,?,?,0,0)').run(task.taskId, JSON.stringify(task), 'running');
    this.#task = structuredClone(task);
    this.#source = source;
    this.#deadline = Date.now() + task.maxRuntimeMs;
    this.#runtime = LocalPolicyRuntime.open({
      stateDirectory: join(this.directory, 'policy'),
      workspaceRoot: workspace,
      repositoryId,
      sourceSnapshot: () => this.#source,
    });
  }
  reserve(envelope: ActionEnvelope): ActionReceipt {
    if (this.#closed || this.#finished || Date.now() >= this.#deadline || envelope.source !== this.#source)
      throw new Error('Inactive or stale task authority');
    if (
      !['provider', 'files.apply', 'command', 'git', 'recording', 'worktree', 'artifact'].includes(
        envelope.kind,
      )
    )
      throw new Error('Unsupported action');
    const sealed = structuredClone(envelope),
      resource = 'host:' + sha256(serialize(sealed)),
      invocationId = randomUUID();
    const grant = this.#runtime.issueGrant({
      taskId: this.#task.taskId,
      invocationId,
      role: 'lead',
      capabilities: [{ action: 'command.run', resource }],
      expiresAt: this.#deadline,
      remainingDepth: 0,
      maxActions: 1,
      maxChildren: 0,
    });
    const reservation = this.#runtime.reserveExternal(
      grant.id,
      invocationId,
      {
        requestId: randomUUID(),
        action: 'command.run',
        resource,
        sourceSnapshot: this.#source,
      },
      sealed,
    );
    let finished = false;
    return {
      check: () => {
        if (finished) throw new Error('Finished action');
        reservation.check();
      },
      finish: (status, outputDigest) => {
        if (finished) throw new Error('Duplicate action completion');
        reservation.finish(status, {
          viewDigest: sha256(serialize(sealed)),
          ...(outputDigest ? { outputDigest } : {}),
        });
        finished = true;
      },
    };
  }
  reserveRequest(bytes: number): number {
    if (
      this.#closed ||
      this.#finished ||
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      bytes > this.#task.maxPromptBytes ||
      Date.now() >= this.#deadline
    )
      throw new Error('Provider prompt/deadline limit');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const r = this.#db.prepare('SELECT requests,input_bytes FROM run').get()!;
      if (
        Number(r.requests) >= this.#task.maxModelRequests ||
        Number(r.input_bytes) + bytes > this.#task.maxPromptBytes * this.#task.maxModelRequests
      )
        throw new Error('Provider request budget exhausted');
      this.#db.prepare('UPDATE run SET requests=requests+1,input_bytes=input_bytes+?').run(bytes);
      this.#db.exec('COMMIT');
      return Number(r.requests) + 1;
    } catch (e) {
      this.#db.exec('ROLLBACK');
      throw e;
    }
  }
  phase(name: string, source: string, data: unknown): void {
    this.#db
      .prepare('INSERT INTO phases(name,source,data) VALUES(?,?,?)')
      .run(name, source, JSON.stringify(data));
    this.#source = source;
  }
  export(): unknown {
    return {
      taskId: this.#task.taskId,
      run: this.#db.prepare('SELECT id,status,requests,input_bytes FROM run').get(),
      phases: this.#db.prepare('SELECT * FROM phases').all(),
      receipts: this.#runtime.receipts(),
    };
  }
  finish(status: 'completed' | 'blocked' | 'failed'): void {
    this.#finished = true;
    this.#db.prepare('UPDATE run SET status=?').run(status);
  }
  close(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.#runtime.close();
      this.#db.close();
    }
  }
}
