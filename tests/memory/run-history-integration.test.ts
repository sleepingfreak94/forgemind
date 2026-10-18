import assert from 'node:assert/strict';
import test from 'node:test';
import { cpSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { digest, serialize } from '../../src/context-engine/validation.js';
import { databasePath } from '../../src/memory/database.js';
import type { RunRecord, TerminalRunInput } from '../../src/memory/run-contracts.js';
import { RunHistory } from '../../src/memory/run-history.js';
import { ProjectMemory } from '../../src/memory/service.js';
import { appendWeeklyRecords, createWeeklyAccumulator, finishWeeklySummary, validateWeeklySummary } from '../../src/memory/weekly-summary.js';
import type { WeeklyScope } from '../../src/memory/weekly-summary.js';
import { fixture } from './fixture.js';

function present<T>(value: T | undefined): T { assert.ok(value !== undefined); return value; }
function run(n: number, execution: 'authenticated' | 'fixture' = 'authenticated'): TerminalRunInput {
  const baselineSource = digest('integration baseline'), candidateSource = digest('integration candidate');
  return { schemaVersion: 1, runId: digest(`integration run ${n}`), taskId: `task-${n}`, execution,
    startedAt: 10, endedAt: 20, outcome: 'completed', lastPhase: 'terminal', baselineSource, candidateSource,
    changedPaths: ['src/example.ts'], checks: [{ phase: 'candidate', id: 'compiler', outcome: 'passed', exitCode: 0,
      source: candidateSource, evidenceSha256: digest('passing candidate evidence') }],
    review: { outcome: 'pass', source: candidateSource, evidenceSha256: digest('passing review evidence') },
    terminalReceiptSha256: digest(`integration receipt ${n}`) };
}
function stopped(n: number, outcome: 'failed' | 'blocked' | 'indeterminate'): TerminalRunInput {
  const { candidateSource: _candidate, review: _review, ...facts } = run(n, 'fixture');
  return { ...facts, outcome, lastPhase: 'setup', changedPaths: [], checks: [] };
}
function inspect<T>(path: string, work: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try { return work(db); } finally { db.close(); }
}
function memoryRows(db: DatabaseSync) {
  return ['identity', 'records', 'memory_fts', 'audit', 'deleted_sources'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}
function snapshot(path: string) {
  return inspect(path, db => ({
    version: db.prepare('PRAGMA user_version').get()?.user_version,
    schema: db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
    memory: memoryRows(db), history: db.prepare('SELECT * FROM run_history ORDER BY sequence').all(),
    sequences: db.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all()
  }));
}
function oneBatch(history: RunHistory, scope: WeeklyScope) {
  const rows = history.list({ afterSequence: scope.lowerExclusive, throughSequence: scope.upperInclusive, limit: 100, order: 'asc' });
  return finishWeeklySummary(appendWeeklyRecords(createWeeklyAccumulator(scope, { maxBytes: 65536 }), rows, scope.upperInclusive));
}
function paged(history: RunHistory, scope: WeeklyScope, limit: number) {
  let state = createWeeklyAccumulator(scope, { maxBytes: 65536 });
  const rows: RunRecord[] = [], pageSizes: number[] = [];
  while (state.cursor < scope.upperInclusive) {
    const page = history.list({ afterSequence: state.cursor, throughSequence: scope.upperInclusive, limit, order: 'asc' });
    pageSizes.push(page.length); rows.push(...page);
    // Advance only through returned records; an empty bounded store read proves the remaining gap.
    const cursor = page.length ? present(page.at(-1)).sequence : scope.upperInclusive;
    state = appendWeeklyRecords(state, page, cursor);
  }
  return { summary: finishWeeklySummary(state), rows, pageSizes };
}

test('real legacy memory migrates with retrieval, packets, audit and tombstones intact alongside history', () => {
  const f = fixture(), path = databasePath(f.directory, f.root, f.projectId);
  let history: RunHistory | undefined;
  try {
    const retiredPath = 'docs/adr/ADR-0002-retired.md';
    writeFileSync(join(f.root, retiredPath), '# Retired choice\n\nStatus: Accepted\n\nRetired durable choice.\n');
    f.memory.ingest();
    const retired = present(f.memory.list().find(record => record.kind === 'document' && record.sources.some(source => source.path === retiredPath)));
    f.memory.validate(retired.id, retired.digest); f.memory.remove(retired.id, retired.digest);
    const id = f.memory.add(f.input()); f.memory.validate(id, id);
    const record = present(f.memory.get(id)), hits = f.memory.search('SQLite'), packet = f.memory.packet('SQLite'), audit = f.memory.audit();
    assert.equal(record.state, 'validated'); assert.ok(hits.some(hit => hit.id === id));
    assert.ok(packet.entries.some(entry => entry.id === id)); f.memory.assertCurrent(packet);
    assert.ok(audit.some(entry => entry.action === 'deleted' && entry.recordId === retired.id));
    f.memory.close();
    // Only in this closed disposable fixture: model the pre-history schema using API-valid data.
    const before = inspect(path, db => {
      assert.equal(db.prepare('SELECT count(*) AS count FROM deleted_sources').get()?.count, 1);
      assert.equal(db.prepare('SELECT count(*) AS count FROM run_history').get()?.count, 0);
      db.exec('BEGIN IMMEDIATE; DROP TABLE run_history; PRAGMA user_version = 1; COMMIT;');
      assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 1);
      return memoryRows(db);
    });
    f.reopen();
    inspect(path, db => {
      assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 2);
      assert.deepEqual(memoryRows(db), before);
      assert.equal(db.prepare('SELECT record_id FROM memory_fts WHERE memory_fts MATCH ?').get('SQLite')?.record_id, id);
    });
    assert.deepEqual(f.memory.get(id), record); assert.deepEqual(f.memory.search('SQLite'), hits);
    assert.deepEqual(f.memory.packet('SQLite'), packet); f.memory.assertCurrent(packet);
    assert.deepEqual(f.memory.audit(), audit); assert.equal(f.memory.get(retired.id), undefined);
    history = new RunHistory(f.directory, f.root, () => 1000);
    const first = history.record(run(1)), second = history.record(stopped(2, 'blocked'));
    assert.deepEqual(history.list({ afterSequence: 0, limit: 100 }), [first, second]);
    const another = f.memory.add(f.input('Use atomic writes for reliable decisions.'));
    f.memory.validate(another, another);
    const currentPacket = f.memory.packet('SQLite'); f.memory.assertCurrent(currentPacket);
    const concurrentRows = inspect(path, memoryRows);
    history.close(); f.reopen(); history = new RunHistory(f.directory, f.root, () => 2000);
    assert.deepEqual(history.inspect(first.id), first);
    assert.deepEqual(history.list({ afterSequence: 0, limit: 100 }), [first, second]);
    assert.deepEqual(f.memory.get(id), record); assert.ok(f.memory.get(another));
    assert.deepEqual(f.memory.packet('SQLite'), currentPacket); f.memory.assertCurrent(currentPacket);
    assert.deepEqual(inspect(path, memoryRows), concurrentRows);
    f.memory.ingest(); assert.equal(f.memory.get(retired.id), undefined);
    assert.ok(!f.memory.list().some(item => item.id === retired.id));
    assert.deepEqual(history.inspect(first.id), first);
  } finally { history?.close(); f.dispose(); }
});

test('real small pages exhaust a fixed watermark and fresh active rows rebuild after revocation', () => {
  const f = fixture(); let history = new RunHistory(f.directory, f.root, () => 1000);
  try {
    const inputs = [run(1), stopped(2, 'failed'), run(3), stopped(4, 'blocked'), run(5)];
    const records = inputs.map(input => history.record(input)), last = present(records.at(-1));
    const scope: WeeklyScope = { projectId: f.projectId, originalRoot: f.root, dueAt: 2000, lowerExclusive: 0, upperInclusive: last.sequence };
    const later = history.record(run(6)); assert.ok(later.sequence > scope.upperInclusive);
    const original = paged(history, scope, 2), batch = oneBatch(history, scope);
    assert.deepEqual(original.pageSizes, [2, 2, 1]); assert.deepEqual(original.rows, records);
    assert.deepEqual(original.summary, batch);
    assert.equal(batch.dependencyCount, 5); assert.equal(batch.selectedRuns, 3); assert.equal(batch.excludedFixtureCount, 2);
    assert.equal(batch.authenticated.outcomes.completed, 3); assert.equal(batch.authenticated.checks.candidatePassed, 3);
    assert.equal(batch.authenticated.reviews.pass, 3); assert.equal(batch.fixture.reviews.absent, 2);
    assert.equal(batch.fixture.outcomes.failed, 1); assert.equal(batch.fixture.outcomes.blocked, 1);
    const historical = serialize(batch), target = present(history.inspect(last.id));
    history.revoke(target.id, target.digest);
    assert.equal(history.inspect(target.id), undefined);
    const rebuilt = paged(history, scope, 2);
    assert.deepEqual(rebuilt.pageSizes, [2, 2, 0]); assert.deepEqual(rebuilt.rows, records.slice(0, -1));
    assert.deepEqual(rebuilt.summary, oneBatch(history, scope));
    assert.equal(rebuilt.summary.dependencyCount, 4); assert.equal(rebuilt.summary.selectedRuns, 2);
    assert.equal(rebuilt.summary.authenticated.outcomes.completed, 2);
    assert.notEqual(rebuilt.summary.dependencySha256, batch.dependencySha256);
    assert.notEqual(rebuilt.summary.id, batch.id); assert.notEqual(rebuilt.summary.digest, batch.digest);
    assert.ok(!rebuilt.summary.examples.some(example => example.id === target.id || example.id === later.id));
    assert.deepEqual(validateWeeklySummary(JSON.parse(historical)), batch);
    assert.throws(() => history.record(present(inputs.at(-1))), /revoked/);
    history.close(); history = new RunHistory(f.directory, f.root, () => 2000);
    assert.equal(history.inspect(target.id), undefined);
    assert.throws(() => history.record(present(inputs.at(-1))), /revoked/);
    assert.throws(() => history.record({ ...present(inputs.at(-1)), taskId: 'changed' }), /revoked/);
    assert.deepEqual(paged(history, scope, 1).summary, rebuilt.summary);
    inspect(databasePath(f.directory, f.root, f.projectId), db => {
      const tombstone = present(db.prepare('SELECT * FROM run_history WHERE id = ?').get(target.id));
      assert.equal(tombstone.body, null); assert.equal(tombstone.revoked, 1);
      assert.equal(tombstone.digest, target.digest); assert.equal(tombstone.sequence, target.sequence);
      assert.equal(tombstone.recorded_at, target.recordedAt);
    });
    assert.deepEqual(validateWeeklySummary(JSON.parse(historical)), batch);
  } finally { history.close(); f.dispose(); }
});

test('registered roots sharing external storage isolate memory, run identity and summary inputs', () => {
  const f = fixture(), otherRoot = join(f.base, 'registered-clone');
  let history: RunHistory | undefined, otherHistory: RunHistory | undefined, otherMemory: ProjectMemory | undefined;
  try {
    cpSync(f.root, otherRoot, { recursive: true });
    otherMemory = new ProjectMemory(f.directory, otherRoot, () => 1000);
    history = new RunHistory(f.directory, f.root, () => 1000); otherHistory = new RunHistory(f.directory, otherRoot, () => 1000);
    const id = f.memory.add(f.input()), otherId = otherMemory.add(f.input());
    f.memory.validate(id, id); otherMemory.validate(otherId, otherId);
    assert.notEqual(id, otherId); assert.equal(f.memory.get(otherId), undefined); assert.equal(otherMemory.get(id), undefined);
    const first = history.record(run(1)), other = otherHistory.record(run(1));
    assert.equal(first.runId, other.runId); assert.notEqual(first.id, other.id); assert.notEqual(first.digest, other.digest);
    const path = databasePath(f.directory, f.root, f.projectId), otherPath = databasePath(f.directory, otherRoot, f.projectId);
    assert.notEqual(path, otherPath);
    inspect(path, db => assert.equal(db.prepare('SELECT workspace FROM identity').get()?.workspace, f.root));
    inspect(otherPath, db => assert.equal(db.prepare('SELECT workspace FROM identity').get()?.workspace, otherRoot));
    assert.equal(history.inspect(other.id), undefined); assert.equal(otherHistory.inspect(first.id), undefined);
    assert.throws(() => history?.revoke(other.id, other.digest), /not found/);
    assert.throws(() => otherHistory?.revoke(first.id, first.digest), /not found/);
    assert.throws(() => history?.revoke(first.id, other.digest), /digest conflict/);
    assert.throws(() => otherHistory?.revoke(other.id, first.digest), /digest conflict/);
    const scope: WeeklyScope = { projectId: f.projectId, originalRoot: f.root, dueAt: 2000, lowerExclusive: 0, upperInclusive: first.sequence };
    const state = createWeeklyAccumulator(scope), otherState = createWeeklyAccumulator({ ...scope, originalRoot: otherRoot });
    const before = serialize(state), otherBefore = serialize(otherState), stored = snapshot(path), otherStored = snapshot(otherPath);
    assert.throws(() => appendWeeklyRecords(state, [other], scope.upperInclusive), /invalid weekly summary/);
    assert.throws(() => appendWeeklyRecords(otherState, [first], scope.upperInclusive), /invalid weekly summary/);
    assert.throws(() => history?.record(other)); assert.throws(() => otherHistory?.record(first));
    assert.equal(serialize(state), before); assert.equal(serialize(otherState), otherBefore);
    assert.deepEqual(snapshot(path), stored); assert.deepEqual(snapshot(otherPath), otherStored);
    history.revoke(first.id, first.digest);
    assert.deepEqual(otherHistory.inspect(other.id), other); assert.deepEqual(otherHistory.record(run(1)), other);
    assert.deepEqual(otherHistory.list({ afterSequence: 0, limit: 100 }), [other]);
    assert.deepEqual(snapshot(otherPath), otherStored); assert.equal(history.inspect(first.id), undefined);
    assert.ok(f.memory.get(id)); assert.ok(otherMemory.get(otherId));
    f.memory.assertCurrent(f.memory.packet('SQLite')); otherMemory.assertCurrent(otherMemory.packet('SQLite'));
  } finally { otherHistory?.close(); history?.close(); otherMemory?.close(); f.dispose(); }
});

for (const projectId of ['Project Alpha', '项目 甲']) {
  test(`broader project label ${projectId} remains usable while summary rejects without store changes`, () => {
    const f = fixture(projectId); let history = new RunHistory(f.directory, f.root, () => 1000);
    try {
      const id = f.memory.add(f.input()); f.memory.validate(id, id);
      const record = present(f.memory.get(id)), packet = f.memory.packet('SQLite');
      assert.equal(record.projectId, projectId); assert.equal(packet.projectId, projectId);
      assert.ok(f.memory.search('SQLite').some(hit => hit.id === id)); f.memory.assertCurrent(packet);
      const first = history.record(run(1)); assert.equal(first.projectId, projectId);
      assert.equal(first.id, digest(serialize({ projectId, workspaceRoot: f.root, runId: first.runId })));
      const path = databasePath(f.directory, f.root, projectId), before = snapshot(path);
      // Documented protocol boundary: project labels are broader than summary slugs.
      assert.throws(() => createWeeklyAccumulator({ projectId, originalRoot: f.root, dueAt: 2000,
        lowerExclusive: 0, upperInclusive: first.sequence }), /invalid weekly summary/);
      assert.deepEqual(snapshot(path), before);
      assert.deepEqual(history.inspect(first.id), first); assert.deepEqual(f.memory.get(id), record);
      assert.deepEqual(f.memory.packet('SQLite'), packet); f.memory.assertCurrent(packet);
      const second = history.record(stopped(2, 'indeterminate'));
      const another = f.memory.add(f.input('Use atomic writes for reliable decisions.')); f.memory.validate(another, another);
      history.close(); f.reopen(); history = new RunHistory(f.directory, f.root, () => 2000);
      assert.deepEqual(history.list({ afterSequence: 0, limit: 100 }), [first, second]);
      assert.deepEqual(f.memory.get(id), record); assert.equal(present(f.memory.get(another)).projectId, projectId);
      inspect(path, db => assert.equal(db.prepare('SELECT project_id FROM identity').get()?.project_id, projectId));
    } finally { history.close(); f.dispose(); }
  });
}
