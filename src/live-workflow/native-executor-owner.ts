import { assertCompiledStage } from './native-compiled-check.js';
import { isCompiledTestCheck } from './native-checks-contracts.js';
import { serialize } from '../context-engine/validation.js';
import { randomUUID } from 'node:crypto';
import { lstatSync, writeFileSync } from 'node:fs';
import { join, relative, sep, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LocalPolicyRuntime } from '../policy/runtime.js';
import { privateDirectory } from './authority.js';
import { sha256 } from './validation.js';
import type { ActionAuthority, ActionEnvelope, ActionReceipt } from './contracts.js';
import type { NativeTask } from './native-executor-contracts.js';

export function ownerLedger(directory: string, root: string, name: 'owner' | 'lifecycle'): DatabaseSync {
  const dir = privateDirectory(directory), rel = relative(resolve(root), dir);
  if (!(rel === '..' || rel.startsWith('..' + sep))) throw new Error('Owner ledger must be outside project');
  const path = join(dir, name + '.sqlite');
  try { writeFileSync(path, '', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & 0o077) throw new Error('Unsafe native owner ledger');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA synchronous=FULL');
  return db;
}

/** Source-bound file/check authority. Runtime lifecycle uses a different ledger. */
export class NativeOwner implements ActionAuthority {
  readonly #runtime: LocalPolicyRuntime;
  readonly #db: DatabaseSync;
  readonly #task: NativeTask;
  readonly #deadline: number;
  readonly #parent: () => void;
  #source: string;
  #closed = false;
  constructor(directory: string, task: NativeTask, deadline: number, parent: () => void) {
    this.#task = structuredClone(task); this.#source = task.source;
    this.#deadline = deadline; this.#parent = parent;
    this.#db = ownerLedger(directory, task.root, 'owner');
    this.#db.exec('CREATE TABLE IF NOT EXISTS source(id INTEGER PRIMARY KEY CHECK(id=1), task TEXT NOT NULL, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS phases(id TEXT PRIMARY KEY, before_source TEXT NOT NULL, after_source TEXT NOT NULL, data TEXT NOT NULL)');
    const binding = sha256(JSON.stringify({ ...task, source: undefined }));
    const current = this.#db.prepare('SELECT task,value FROM source WHERE id=1').get();
    if (current && (current.task !== binding || current.value !== task.source)) {
      this.#db.close(); throw new Error('Native owner source requires reconciliation');
    }
    this.#db.prepare('INSERT OR IGNORE INTO source VALUES(1,?,?)').run(binding, task.source);
    this.#runtime = LocalPolicyRuntime.open({ stateDirectory: join(directory, 'policy'), workspaceRoot: task.root,
      repositoryId: task.project, sourceSnapshot: () => this.#source });
    this.active();
  }
  active(): void {
    this.#parent();
    if (this.#closed || Date.now() >= this.#deadline) throw new Error('Native owner expired or closed');
  }
  get source(): string { return this.#source; }
  #allowed(envelope: ActionEnvelope, original: unknown): void {
    const detail = envelope.detail as Record<string, unknown>;
    if (!detail || typeof detail !== 'object') throw new Error('Invalid native owner action');
    if (envelope.kind === 'files.apply') {
      const edits = detail.edits as {path?:string}[];
      if (!Array.isArray(edits) || !edits.length || edits.some(edit => !edit || !this.#task.writePaths.includes(String(edit.path)))) throw new Error('Native writes outside exact grant');
    } else if (envelope.kind === 'artifact' && detail.operation === 'native.read') {
      if (!this.#task.readPaths.includes(String(detail.path))) throw new Error('Native read outside exact grant');
    } else if (envelope.kind === 'artifact' && detail.operation === 'native.source-transition') {
      if (detail.before !== this.#source || typeof detail.source !== 'string') throw new Error('Invalid native transition');
    } else if (envelope.kind === 'command') {
      const id = detail.id ?? (detail.command as {id?:string}|undefined)?.id;
      const expected = this.#task.checks.find(check => check.id === id);
      if (!expected) throw new Error('Native command outside exact grant');
      if (detail.command && JSON.stringify(detail.command) !== JSON.stringify(expected)) throw new Error('Changed predefined native check');
      if (isCompiledTestCheck(expected)) {
        if (detail.operation === 'native.predefined-check' && Object.keys(detail).sort().join() === 'command,operation') return;
        assertCompiledStage(original, expected, this.#task.root, detail);
        return;
      }
      if (detail.executable && (detail.executable !== expected.executable || JSON.stringify(detail.args) !== JSON.stringify(expected.args) || detail.cwd !== this.#task.root)) throw new Error('Changed native command');
    } else throw new Error('Unsupported native owner action');
  }
  reserve(raw: ActionEnvelope): ActionReceipt {
    this.active();
    const envelope = structuredClone(raw);
    if (envelope.source !== this.#source) throw new Error('Stale native action source');
    this.#allowed(envelope, raw.detail);
    const source = this.#source, resource = 'host:' + sha256(serialize(envelope)), invocationId = randomUUID();
    const grant = this.#runtime.issueGrant({ taskId: this.#task.task, invocationId, role: 'lead',
      capabilities: [{action:'command.run',resource}], expiresAt:this.#deadline, remainingDepth:0, maxActions:1, maxChildren:0 });
    const reservation = this.#runtime.reserveExternal(grant.id, invocationId, {
      requestId: randomUUID(), action:'command.run',resource,sourceSnapshot:source,
    }, envelope);
    let finished = false;
    const check = () => {
      this.active();
      if (finished || source !== this.#source) throw new Error('Finished or stale native action');
      reservation.check();
    };
    return { check, finish: (status, outputDigest) => {
      if (finished) throw new Error('Duplicate native action finish');
      if (status === 'completed') check();
      reservation.finish(status, {viewDigest:sha256(serialize(envelope)),...(outputDigest?{outputDigest}:{})});
      finished = true;
    } };
  }
  phase(name: string, source: string, raw: unknown): void {
    this.active();
    const data = raw as {transitionReceiptId?:string;before?:string;source?:string};
    if (name !== 'native.source-transition' || data.before !== this.#source || data.source !== source || typeof data.transitionReceiptId !== 'string') throw new Error('Invalid native source phase');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.#db.prepare('UPDATE source SET value=? WHERE id=1 AND value=?').run(source,this.#source);
      if (Number(result.changes) !== 1) throw new Error('Stale source phase owner');
      this.#db.prepare('INSERT INTO phases VALUES(?,?,?,?)').run(data.transitionReceiptId,this.#source,source,JSON.stringify(data));
      this.active(); this.#db.exec('COMMIT'); this.#source = source;
    } catch(error) {this.#db.exec('ROLLBACK');throw error;}
  }
  export() { return { source:this.#source, phases:this.#db.prepare('SELECT * FROM phases').all(), receipts:this.#runtime.receipts() }; }
  close(): void { if(!this.#closed){this.#closed=true;this.#runtime.close();this.#db.close();} }
}
