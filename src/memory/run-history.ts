import { dataSnapshot, digest, freeze, object, serialize } from '../context-engine/validation.js';
import { readProject } from '../project-workflow/project.js';
import { MemoryDatabase } from './database.js';
import { canonicalWorkspace } from './documents.js';
import type { RunListOptions, RunRecord, TerminalRunInput } from './run-contracts.js';
import { terminalRun } from './run-validation.js';

function sha(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('invalid run hash');
}
function natural(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('invalid run integer');
}
type ListOptions = Omit<RunListOptions, 'order'> & { readonly order?: RunListOptions['order'] };

/** Structural facts only; this store does not authenticate providers or artifacts. */
export class RunHistory {
  readonly #database: MemoryDatabase;
  readonly #workspaceRoot: string;
  readonly #projectId: string;
  readonly #clock: () => number;
  constructor(directory: string, originalCanonicalWorkspace: string, clock: () => number = Date.now) {
    this.#workspaceRoot = canonicalWorkspace(originalCanonicalWorkspace);
    this.#projectId = readProject(this.#workspaceRoot).projectId;
    this.#clock = clock;
    this.#database = new MemoryDatabase(directory, this.#workspaceRoot, this.#projectId);
  }
  #scope(): void {
    if (readProject(canonicalWorkspace(this.#workspaceRoot)).projectId !== this.#projectId) throw new Error('project identity changed');
  }
  #facts(input: TerminalRunInput) {
    return { ...input, projectId: this.#projectId, workspaceRoot: this.#workspaceRoot };
  }
  #id(runId: string): string {
    return digest(serialize({ projectId: this.#projectId, workspaceRoot: this.#workspaceRoot, runId }));
  }
  #verify(row: Record<string, unknown>): RunRecord | undefined {
    sha(row.id); sha(row.digest); natural(row.sequence); natural(row.recorded_at);
    if (row.sequence === 0 || row.revoked !== 0 && row.revoked !== 1) throw new Error('invalid persisted run metadata');
    if (row.revoked === 1) {
      if (row.body !== null) throw new Error('unredacted revoked run');
      return undefined;
    }
    if (typeof row.body !== 'string' || Buffer.byteLength(row.body) > 65536) throw new Error('invalid persisted run body');
    const value: unknown = JSON.parse(row.body);
    object(value, ['schemaVersion', 'runId', 'taskId', 'execution', 'startedAt', 'endedAt', 'outcome', 'lastPhase',
      'baselineSource', 'candidateSource', 'changedPaths', 'checks', 'review', 'terminalReceiptSha256', 'projectId', 'workspaceRoot']);
    const { projectId, workspaceRoot, ...input } = value;
    if (projectId !== this.#projectId || workspaceRoot !== this.#workspaceRoot) throw new Error('persisted run scope mismatch');
    const facts = this.#facts(terminalRun(input)), body = serialize(facts);
    if (row.body !== body || row.id !== this.#id(facts.runId) || row.digest !== digest(body)) throw new Error('persisted run integrity mismatch');
    return freeze({ ...facts, id: row.id, digest: row.digest, sequence: row.sequence, recordedAt: row.recorded_at });
  }
  record(raw: unknown): RunRecord {
    this.#scope();
    const facts = this.#facts(terminalRun(raw)), id = this.#id(facts.runId), body = serialize(facts), factsDigest = digest(body);
    return this.#database.transaction(() => {
      const existing = this.#database.db.prepare('SELECT * FROM run_history WHERE id = ?').get(id);
      if (existing) {
        const record = this.#verify(existing);
        if (!record) throw new Error('run revoked');
        if (record.digest !== factsDigest) throw new Error('run facts conflict');
        return record;
      }
      const recordedAt = this.#clock(); natural(recordedAt); this.#scope();
      this.#database.db.prepare('INSERT INTO run_history (id, digest, body, recorded_at) VALUES (?, ?, ?, ?)').run(id, factsDigest, body, recordedAt);
      const inserted = this.#database.db.prepare('SELECT * FROM run_history WHERE id = ?').get(id);
      if (!inserted) throw new Error('missing inserted run');
      const record = this.#verify(inserted);
      if (!record) throw new Error('inserted run revoked');
      return record;
    });
  }
  inspect(id: string): RunRecord | undefined {
    this.#scope(); sha(id);
    const row = this.#database.db.prepare('SELECT * FROM run_history WHERE id = ?').get(id);
    return row ? this.#verify(row) : undefined;
  }
  list(options: ListOptions): readonly RunRecord[] {
    this.#scope();
    const value: unknown = dataSnapshot(options);
    object(value, ['afterSequence', 'throughSequence', 'limit', 'order']);
    natural(value.afterSequence); natural(value.limit);
    if (value.limit < 1 || value.limit > 100) throw new Error('invalid run list limit');
    const through = value.throughSequence === undefined ? Number.MAX_SAFE_INTEGER : value.throughSequence;
    natural(through);
    const order = value.order === undefined ? 'asc' : value.order;
    if (order !== 'asc' && order !== 'desc') throw new Error('invalid run list order');
    const query = order === 'asc'
      ? 'SELECT * FROM run_history WHERE sequence > ? AND sequence <= ? AND revoked = 0 ORDER BY sequence ASC, id ASC LIMIT ?'
      : 'SELECT * FROM run_history WHERE sequence > ? AND sequence <= ? AND revoked = 0 ORDER BY sequence DESC, id DESC LIMIT ?';
    return Object.freeze(this.#database.db.prepare(query).all(value.afterSequence, through, value.limit).map(row => {
      const record = this.#verify(row);
      if (!record) throw new Error('unexpected revoked run');
      return record;
    }));
  }
  revoke(id: string, expectedDigest: string): void {
    this.#scope(); sha(id); sha(expectedDigest);
    this.#database.transaction(() => {
      const row = this.#database.db.prepare('SELECT * FROM run_history WHERE id = ?').get(id);
      if (!row) throw new Error('run not found');
      this.#verify(row);
      if (row.digest !== expectedDigest) throw new Error('run digest conflict');
      this.#database.db.prepare('UPDATE run_history SET body = NULL, revoked = 1 WHERE id = ? AND digest = ? AND revoked = 0').run(id, expectedDigest);
    });
  }
  close(): void { this.#database.close(); }
}
