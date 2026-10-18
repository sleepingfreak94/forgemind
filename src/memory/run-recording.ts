import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { dataSnapshot, digest, freeze, object, serialize, string } from '../context-engine/validation.js';
import { readProject } from '../project-workflow/project.js';
import { relativePath } from '../project-workflow/validation.js';
import { databasePath, MemoryDatabase } from './database.js';
import { canonicalWorkspace } from './documents.js';
import { RunHistory } from './run-history.js';
import { terminalRun } from './run-validation.js';
import type { RunCheck, RunPhase, RunRecord, RunReview, TerminalRunInput } from './run-contracts.js';

export function natural(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('invalid owner integer');
}
export function sha(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('invalid owner digest');
}
export function slug(value: unknown): asserts value is string {
  string(value, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) throw new Error('invalid owner identifier');
}
export function privateOwnerPath(path: string, directory: boolean): void {
  const s = lstatSync(path);
  if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1) ||
      typeof process.getuid === 'function' && (s.uid !== process.getuid() || (s.mode & 0o077))) throw new Error('unsafe private owner path');
}
const ddl = 'CREATE TABLE owner_values (key TEXT PRIMARY KEY, body TEXT NOT NULL, digest TEXT NOT NULL) STRICT';
/** A separate MemoryDatabase, never extra tables in the existing project memory DB. */
export class OwnerStore {
  readonly database: MemoryDatabase;
  readonly projectId: string;
  readonly originalRoot: string;
  readonly directory: string;
  constructor(stateDirectory: string, originalRoot: string) {
    this.originalRoot = canonicalWorkspace(originalRoot);
    this.projectId = readProject(this.originalRoot).projectId;
    slug(this.projectId);
    const offset = relative(originalRoot, stateDirectory);
    if (!isAbsolute(stateDirectory) || !offset || !offset.startsWith(`..${sep}`) && offset !== '..' && !isAbsolute(offset)) throw new Error('owner state must be external');
    mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    if (realpathSync(stateDirectory) !== stateDirectory) throw new Error('canonical owner state required');
    privateOwnerPath(stateDirectory, true);
    this.directory = join(stateDirectory, 'weekly-owner');
    const existed = existsSync(databasePath(this.directory, originalRoot, this.projectId));
    this.database = new MemoryDatabase(this.directory, originalRoot, this.projectId);
    try {
      this.database.transaction(() => {
        if (!existed) this.database.db.exec(ddl);
        this.assertCurrent();
      });
    } catch (error) { this.database.close(); throw error; }
  }
  assertCurrent(): void {
    if (readProject(canonicalWorkspace(this.originalRoot)).projectId !== this.projectId) throw new Error('owner scope changed');
    for (const path of [dirname(this.directory), this.directory, dirname(this.database.path)]) {
      privateOwnerPath(path, true);
      if (realpathSync(path) !== path) throw new Error('linked owner storage');
    }
    privateOwnerPath(this.database.path, false);
    const db = this.database.db;
    const table = db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'owner_values' COLLATE NOCASE").get();
    const normalize = (s: string) => s.replace(/\s+/g, '').toLowerCase();
    if (typeof table?.sql !== 'string' || normalize(table.sql) !== normalize(ddl) ||
        db.prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger' AND tbl_name='owner_values' COLLATE NOCASE").get()) throw new Error('invalid owner schema');
  }
  get(key: string): unknown {
    this.assertCurrent();
    const row = this.database.db.prepare('SELECT * FROM owner_values WHERE key=?').get(key);
    if (!row) return undefined;
    if (typeof row.body !== 'string' || Buffer.byteLength(row.body) > 131072 || row.digest !== digest(row.body)) throw new Error('owner state integrity mismatch');
    const value: unknown = JSON.parse(row.body);
    if (serialize(value) !== row.body) throw new Error('noncanonical owner state');
    return dataSnapshot(value);
  }
  put(key: string, value: unknown): void {
    this.assertCurrent();
    const body = serialize(dataSnapshot(value));
    if (Buffer.byteLength(body) > 131072) throw new Error('owner state too large');
    this.database.db.prepare('INSERT INTO owner_values VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body,digest=excluded.digest').run(key, body, digest(body));
  }
  close(): void { this.database.close(); }
}

/** Bounded exact bytes; no symlinks, hardlinks, special files or lossy UTF-8. */
export function readOwnerJSON(path: string, expectedSha256: string): unknown {
  sha(expectedSha256);
  if (!isAbsolute(path) || realpathSync(dirname(path)) !== dirname(path)) throw new Error('canonical artifact path required');
  privateOwnerPath(dirname(path), true); privateOwnerPath(path, false);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > 1048576 ||
        typeof process.getuid === 'function' && (before.uid !== process.getuid() || (before.mode & 0o077))) throw new Error('unsafe artifact');
    const bytes = readFileSync(fd), after = fstatSync(fd);
    if (bytes.length > 1048576 || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        createHash('sha256').update(bytes).digest('hex') !== expectedSha256) throw new Error('artifact bytes changed or digest mismatch');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } finally { closeSync(fd); }
}
export interface OwnerReservation {
  readonly schemaVersion: 1; readonly projectId: string; readonly originalRoot: string;
  readonly reservationId: string; readonly runId: string; readonly taskId: string;
  readonly execution: 'fixture' | 'authenticated'; readonly startedAt: number;
}
export interface ArtifactBinding { readonly sha256: string; readonly source: string; readonly phaseSeq: number }
export interface OwnerArtifactManifest {
  readonly schemaVersion: 1; readonly projectId: string; readonly originalRoot: string;
  readonly runId: string; readonly taskId: string; readonly endedAt: number;
  readonly artifacts: {
    readonly 'receipt.json': { readonly sha256: string };
    readonly 'before-checks.json': ArtifactBinding | null;
    readonly 'after-checks.json': ArtifactBinding | null;
    readonly 'review.json': (ArtifactBinding & { readonly independent: true }) | null;
  };
}
function reservation(raw: unknown): OwnerReservation {
  object(raw, ['schemaVersion', 'projectId', 'originalRoot', 'reservationId', 'runId', 'taskId', 'execution', 'startedAt']);
  if (raw.schemaVersion !== 1 || raw.execution !== 'fixture' && raw.execution !== 'authenticated') throw new Error('invalid reservation');
  slug(raw.projectId); string(raw.originalRoot, 1024); slug(raw.reservationId); sha(raw.runId); slug(raw.taskId); natural(raw.startedAt);
  return raw as unknown as OwnerReservation;
}
type Phase = { seq: number; name: string; source: string; data: Record<string, unknown> };
function phases(raw: unknown): Phase[] {
  if (!Array.isArray(raw) || raw.length > 256) throw new Error('invalid receipt phases');
  let previous = 0;
  return raw.map((p: unknown) => {
    object(p, ['seq', 'name', 'source', 'data']); natural(p.seq); string(p.name, 128); sha(p.source); string(p.data, 65536);
    if (p.seq <= previous) throw new Error('invalid receipt phase order'); previous = p.seq;
    const data: unknown = JSON.parse(p.data); object(data, Object.keys(data as object));
    return { seq: p.seq, name: p.name, source: p.source, data };
  });
}
function uniquePhase(list: Phase[], name: string): Phase | undefined {
  const matches = list.filter(p => p.name === name);
  if (matches.length > 1) throw new Error('ambiguous receipt phase');
  return matches[0];
}
const receiptFields = ['id', 'event', 'outcome', 'reason', 'timestamp', 'principalId', 'sessionId', 'policyVersion', 'sourceSnapshot'];
type TerminalReceipt = { id: string; sourceSnapshot: string; taskId: string; outcome: string; outputDigest?: string };
/** Validate actual policy shapes; unrelated actions need not have an output digest. */
function actionReceipts(raw: unknown, startedAt: number, endedAt: number): { baseline: string; terminals: TerminalReceipt[] } {
  if (!Array.isArray(raw) || raw.length > 8192) throw new Error('invalid action receipts');
  const ids = new Set<string>(), requests = new Set<string>(), sessions: Record<string, unknown>[] = [], terminals: TerminalReceipt[] = [];
  let previous = startedAt;
  for (const event of raw as unknown[]) {
    object(event, [...receiptFields, 'grantId', 'invocationId', 'taskId', 'requestId', 'action', 'resource', 'requestDigest', 'terminalEvidence']);
    for (const key of ['id', 'event', 'outcome', 'reason', 'principalId', 'sessionId', 'policyVersion']) string(event[key], 4096);
    sha(event.sourceSnapshot); natural(event.timestamp);
    if (ids.has(event.id as string)) throw new Error('duplicate action receipt ID');
    ids.add(event.id as string);
    if (event.timestamp < previous || event.timestamp > endedAt) throw new Error('invalid action receipt timestamp');
    previous = event.timestamp;
    if (event.event === 'session.started') {
      object(event, receiptFields);
      if (event.outcome !== 'allow' || event.reason !== 'trusted-local-launch') throw new Error('invalid session baseline');
      sessions.push(event);
    }
    if (event.event !== 'external.finished') continue;
    for (const key of ['grantId', 'invocationId', 'taskId', 'requestId', 'resource']) string(event[key], 4096);
    sha(event.requestDigest);
    if (event.action !== 'command.run' || !['completed', 'failed', 'interrupted', 'denied', 'cancelled', 'timed-out', 'indeterminate'].includes(event.outcome as string)) throw new Error('invalid terminal action receipt');
    if (requests.has(event.requestId as string)) throw new Error('duplicate terminal action request');
    requests.add(event.requestId as string);
    let outputDigest: string | undefined;
    if (event.terminalEvidence !== undefined) {
      object(event.terminalEvidence, ['viewDigest', 'outputDigest']); sha(event.terminalEvidence.viewDigest);
      if (event.terminalEvidence.outputDigest !== undefined) { sha(event.terminalEvidence.outputDigest); outputDigest = event.terminalEvidence.outputDigest; }
    }
    terminals.push({ id: event.id as string, sourceSnapshot: event.sourceSnapshot, taskId: event.taskId as string,
      outcome: event.outcome as string, ...(outputDigest ? { outputDigest } : {}) });
  }
  const session = sessions[0];
  if (sessions.length !== 1 || !session || raw[0] !== session) throw new Error('missing or ambiguous session baseline');
  for (const event of raw as Record<string, unknown>[]) {
    if (event.sessionId !== session.sessionId || event.principalId !== session.principalId) throw new Error('action receipt session mismatch');
  }
  return { baseline: session.sourceSnapshot as string, terminals };
}
const lastPhases: Readonly<Record<string, RunPhase>> = {
  worktree: 'setup', 'plan-accepted': 'planning', 'plan-pending': 'approval', candidate: 'candidate',
  reviewed: 'review', 'delivery-blocked': 'delivery', 'videos-delivered': 'delivery', committed: 'publication', published: 'publication', failed: 'terminal'
};
/** Explicit trusted-owner bridge. Never accepts a native executor completion envelope. */
export class OwnerRunRecorder {
  readonly store: OwnerStore;
  readonly #history: RunHistory;
  readonly #clock: () => number;
  constructor(directory: string, root: string, clock: () => number = Date.now) {
    this.store = new OwnerStore(directory, root); this.#clock = clock;
    try { this.#history = new RunHistory(directory, root, clock); }
    catch (error) { this.store.close(); throw error; }
  }
  #reservation(id: string): OwnerReservation {
    slug(id); const r = reservation(this.store.get(`reservation:${id}`));
    if (r.reservationId !== id || r.projectId !== this.store.projectId || r.originalRoot !== this.store.originalRoot) throw new Error('reservation scope mismatch');
    return r;
  }
  prepare(raw: { readonly reservationId: string; readonly taskId: string; readonly execution: 'fixture' | 'authenticated' }): OwnerReservation {
    const input = dataSnapshot(raw); object(input, ['reservationId', 'taskId', 'execution']);
    slug(input.reservationId); slug(input.taskId);
    if (input.execution !== 'fixture' && input.execution !== 'authenticated') throw new Error('explicit owner provenance required');
    return this.store.database.transaction(() => {
      const key = `reservation:${input.reservationId}`, old = this.store.get(key);
      if (old !== undefined) {
        const r = this.#reservation(input.reservationId);
        if (r.taskId !== input.taskId || r.execution !== input.execution) throw new Error('reservation conflict');
        return r;
      }
      const startedAt = this.#clock(); natural(startedAt);
      const r: OwnerReservation = { schemaVersion: 1, projectId: this.store.projectId, originalRoot: this.store.originalRoot,
        ...input, runId: digest(randomUUID()), startedAt };
      this.store.put(key, r); return freeze(r);
    });
  }
  record(reservationId: string, manifestPath: string, manifestSha256: string): RunRecord {
    const r = this.#reservation(reservationId);
    const m = readOwnerJSON(manifestPath, manifestSha256);
    object(m, ['schemaVersion', 'projectId', 'originalRoot', 'runId', 'taskId', 'endedAt', 'artifacts']);
    if (m.schemaVersion !== 1 || m.projectId !== r.projectId || m.originalRoot !== r.originalRoot || m.runId !== r.runId || m.taskId !== r.taskId) throw new Error('manifest reservation scope mismatch');
    const now = this.#clock(); natural(now);
    natural(m.endedAt); if (m.endedAt < r.startedAt || m.endedAt > now) throw new Error('invalid terminal timestamp');
    const artifacts = m.artifacts;
    object(artifacts, ['receipt.json', 'before-checks.json', 'after-checks.json', 'review.json']);
    for (const key of ['receipt.json', 'before-checks.json', 'after-checks.json', 'review.json']) if (!Object.hasOwn(artifacts, key)) throw new Error('incomplete expected artifact manifest');
    const receiptBinding = artifacts['receipt.json']; object(receiptBinding, ['sha256']); sha(receiptBinding.sha256);
    const receipt = readOwnerJSON(join(dirname(manifestPath), 'receipt.json'), receiptBinding.sha256);
    object(receipt, ['taskId', 'run', 'phases', 'receipts']);
    if (receipt.taskId !== r.taskId) throw new Error('invalid supervised receipt');
    object(receipt.run, ['id', 'status', 'requests', 'input_bytes']);
    if (receipt.run.id !== r.taskId || !['completed', 'failed', 'blocked', 'running'].includes(String(receipt.run.status))) throw new Error('invalid supervised run');
    natural(receipt.run.requests); natural(receipt.run.input_bytes);
    const actions = actionReceipts(receipt.receipts, r.startedAt, m.endedAt), used = new Set<string>();
    const list = phases(receipt.phases), baseline = uniquePhase(list, 'worktree'), candidate = uniquePhase(list, 'candidate'), reviewed = uniquePhase(list, 'reviewed');
    if (baseline) {
      if (list[0] !== baseline || candidate && candidate.seq <= baseline.seq || reviewed && (!candidate || reviewed.seq <= candidate.seq)) throw new Error('insufficient receipt source binding');
    } else {
      if (receipt.run.status === 'completed') throw new Error('incomplete completed run');
      if (candidate || reviewed || list.length > 1 || list.some(p => p.name !== 'failed' || p.source !== actions.baseline) ||
          ['before-checks.json', 'after-checks.json', 'review.json'].some(name => artifacts[name] !== null)) throw new Error('invalid early setup evidence');
    }
    const last = list.at(-1), lastPhase = last ? lastPhases[last.name] : 'setup';
    if (!lastPhase) throw new Error('unsupported terminal phase');
    const checks: RunCheck[] = [];
    const checkFacts: { check: RunCheck; outputDigest: string; producerOutcome: string }[] = [];
    let review: RunReview | undefined;
    for (const name of ['before-checks.json', 'after-checks.json', 'review.json'] as const) {
      const binding = artifacts[name], path = join(dirname(manifestPath), name);
      if (binding === null) {
        try { lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        throw new Error('manifest claims absent existing evidence');
      }
      object(binding, name === 'review.json' ? ['sha256', 'source', 'phaseSeq', 'independent'] : ['sha256', 'source', 'phaseSeq']);
      sha(binding.sha256); sha(binding.source); natural(binding.phaseSeq);
      const phase = name === 'before-checks.json' ? baseline : name === 'after-checks.json' ? candidate : reviewed;
      if (!phase || binding.source !== phase.source || binding.phaseSeq !== phase.seq || name !== 'before-checks.json' && binding.source !== candidate?.source) throw new Error('artifact source mismatch');
      const evidence = readOwnerJSON(path, binding.sha256);
      if (name === 'review.json') {
        object(evidence, ['verdict', 'findings', 'acceptance', 'source']);
        if (binding.independent !== true || evidence.source !== binding.source || !['pass', 'revise', 'blocked'].includes(String(evidence.verdict)) || phase.data.verdict !== evidence.verdict) throw new Error('invalid independent review binding');
        for (const values of [evidence.findings, evidence.acceptance]) {
          if (!Array.isArray(values) || values.length > 100) throw new Error('invalid review');
          values.forEach((v: unknown) => string(v, 4096, true));
        }
        review = { outcome: evidence.verdict as RunReview['outcome'], source: binding.source, evidenceSha256: binding.sha256 };
      } else {
        if (!Array.isArray(evidence) || evidence.length > 24) throw new Error('invalid check evidence');
        const phaseIds = new Set<string>();
        for (const item of evidence as unknown[]) {
          object(item, ['id', 'passed', 'exitCode', 'stdout', 'stderr']); slug(item.id);
          if (phaseIds.has(item.id)) throw new Error('duplicate check ID within phase');
          phaseIds.add(item.id);
          if (typeof item.passed !== 'boolean' || item.exitCode !== null && (!Number.isSafeInteger(item.exitCode) || typeof item.exitCode !== 'number') || item.passed !== (item.exitCode === 0)) throw new Error('contradictory check evidence');
          string(item.stdout, 1048576, true); string(item.stderr, 1048576, true);
          checkFacts.push({ outputDigest: digest(JSON.stringify(item)), producerOutcome: item.passed ? 'completed' : 'failed',
            check: { phase: name === 'before-checks.json' ? 'baseline' : 'candidate', id: item.id,
              outcome: item.exitCode === null ? 'indeterminate' : item.passed ? 'passed' : 'failed', exitCode: item.exitCode as number | null,
              source: binding.source, evidenceSha256: binding.sha256 } });
        }
      }
    }
    // Both artifacts are validated before assigning any terminal. Receipt order is stable.
    const groupKey = (outputDigest: string, source: string, taskId: string) => JSON.stringify([outputDigest, source, taskId]);
    const groups = new Map<string, { facts: typeof checkFacts; terminals: TerminalReceipt[] }>();
    for (const fact of checkFacts) {
      const key = groupKey(fact.outputDigest, fact.check.source, r.taskId);
      let group = groups.get(key);
      if (!group) { group = { facts: [], terminals: [] }; groups.set(key, group); }
      group.facts.push(fact);
    }
    for (const terminal of actions.terminals) {
      if (terminal.outputDigest !== undefined) groups.get(groupKey(terminal.outputDigest, terminal.sourceSnapshot, terminal.taskId))?.terminals.push(terminal);
    }
    for (const group of groups.values()) {
      const expected = group.facts[0]!.producerOutcome;
      if (group.terminals.length !== group.facts.length || !group.facts.every(fact => fact.producerOutcome === expected) ||
          !group.terminals.every(terminal => terminal.outcome === expected)) throw new Error('missing, ambiguous or contradictory check action binding');
      for (const [index, fact] of group.facts.entries()) {
        const terminal = group.terminals[index];
        if (!terminal || terminal.outcome !== fact.producerOutcome || used.has(terminal.id)) throw new Error('missing, ambiguous or contradictory check action binding');
        used.add(terminal.id);
      }
    }
    checks.push(...checkFacts.map(fact => fact.check));
    let changedPaths: string[] = [];
    if (candidate) {
      if (!Array.isArray(candidate.data.paths) || candidate.data.paths.length > 100) throw new Error('invalid candidate paths');
      candidate.data.paths.forEach(relativePath); changedPaths = candidate.data.paths as string[];
    }
    const input: TerminalRunInput = terminalRun({ schemaVersion: 1, runId: r.runId, taskId: r.taskId, execution: r.execution,
      startedAt: r.startedAt, endedAt: m.endedAt, outcome: receipt.run.status === 'running' ? 'indeterminate' : receipt.run.status,
      lastPhase, baselineSource: baseline?.source ?? actions.baseline, ...(candidate ? { candidateSource: candidate.source } : {}), changedPaths, checks,
      ...(review ? { review } : {}), terminalReceiptSha256: receiptBinding.sha256 });
    // History is committed first. A crash before saving this import can retry without execution.
    return this.store.database.transaction(() => {
      const current = this.#reservation(reservationId);
      if (serialize(current) !== serialize(r)) throw new Error('reservation changed');
      const key = `import:${r.runId}`, old = this.store.get(key);
      const imported = { schemaVersion: 1, manifestSha256, factsSha256: digest(serialize(input)) };
      if (old !== undefined && serialize(old) !== serialize(imported)) throw new Error('receipt import conflict');
      const record = this.#history.record(input);
      this.store.put(key, imported); return record;
    });
  }
  close(): void { this.#history.close(); this.store.close(); }
}
