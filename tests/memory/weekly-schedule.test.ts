import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, cpSync, linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { digest, serialize } from '../../src/context-engine/validation.js';
import { databasePath } from '../../src/memory/database.js';
import { RunHistory } from '../../src/memory/run-history.js';
import { WeeklySchedule } from '../../src/memory/weekly-schedule.js';
import { WeeklyService } from '../../src/memory/weekly-service.js';
import type { TerminalRunInput } from '../../src/memory/run-contracts.js';
import { fixture } from './fixture.js';

const due = Date.UTC(2026, 9, 18, 4, 30), week = 7 * 86400000;
function run(n: number): TerminalRunInput {
  return { schemaVersion: 1, runId: digest(`scheduled fixture ${n}`), taskId: `fixture-${n}`, execution: 'fixture',
    startedAt: due - 1000, endedAt: due - 500, outcome: 'blocked', lastPhase: 'setup', baselineSource: digest('scheduled source'),
    checks: [], changedPaths: [], terminalReceiptSha256: digest(`scheduled receipt ${n}`) };
}
function inspect<T>(path: string, work: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try { return work(db); } finally { db.close(); }
}

test('inactive by default; Sunday before/exact/after, restart, retained results and disable', () => {
  const f = fixture(); let now = due - 1;
  let schedule = new WeeklySchedule(f.directory, f.root, () => now);
  const history = new RunHistory(f.directory, f.root, () => now);
  try {
    assert.equal(schedule.status().enabled, false); assert.equal(schedule.status().activatedAt, null);
    assert.deepEqual(schedule.tick(), { status: 'disabled' }); assert.throws(() => schedule.result(), /no committed/);
    const recorded = history.record(run(1));
    schedule.configure({ executionSelection: 'all' });
    assert.equal(schedule.status().dueAt, null); assert.deepEqual(schedule.tick(), { status: 'not-due' });
    now = due;
    assert.equal(schedule.status().dueAt, due);
    const result = schedule.tick(); assert.equal(result.status, 'committed'); assert.ok(result.summary);
    assert.equal(result.summary.dependencyCount, 1); assert.equal(result.summary.fixture.runs, 1);
    assert.equal(schedule.status().lowerExclusive, recorded.sequence);
    const exact = serialize(schedule.result());
    schedule.close(); now = due + 1; schedule = new WeeklySchedule(f.directory, f.root, () => now);
    assert.deepEqual(schedule.tick(), { status: 'not-due' }); assert.equal(serialize(schedule.result()), exact);
    history.revoke(recorded.id, recorded.digest);
    assert.equal(serialize(schedule.result()), exact);
    const service = new WeeklyService(f.directory, f.root);
    try { assert.equal(service.generate({ dueAt: due, lowerExclusive: 0, upperInclusive: recorded.sequence }).dependencyCount, 0); }
    finally { service.close(); }
    const later = history.record(run(2));
    now = due + 3 * week + 1;
    const collapsed = schedule.tick(); assert.ok(collapsed.summary);
    assert.equal(collapsed.summary.dueAt, due + 3 * week); assert.equal(collapsed.summary.lowerExclusive, recorded.sequence);
    assert.equal(collapsed.summary.upperInclusive, later.sequence); assert.equal(collapsed.summary.dependencyCount, 1);
    schedule.disable(); now += week;
    assert.equal(schedule.status().enabled, false); assert.deepEqual(schedule.tick(), { status: 'disabled' });
    assert.equal(serialize(schedule.result(due)), exact);
    schedule.close(); schedule = new WeeklySchedule(f.directory, f.root, () => now);
    assert.equal(schedule.status().enabled, false);
    schedule.configure(); assert.equal(schedule.status().lowerExclusive, later.sequence);
    assert.equal(schedule.tick().status, 'committed');
  } finally { schedule.close(); history.close(); f.dispose(); }
});

test('generation failure after the first page rolls back cursor and result; restart repairs safely', () => {
  const f = fixture(); let now = due - 1;
  let schedule = new WeeklySchedule(f.directory, f.root, () => now);
  const history = new RunHistory(f.directory, f.root, () => now), path = databasePath(f.directory, f.root, f.projectId);
  try {
    const rows = Array.from({ length: 102 }, (_, n) => history.record(run(n)));
    schedule.configure(); now = due;
    const before = schedule.status();
    const broken = rows[100]!;
    const original = inspect(path, db => db.prepare('SELECT body FROM run_history WHERE id=?').get(broken.id)?.body);
    assert.equal(typeof original, 'string');
    inspect(path, db => { db.prepare('UPDATE run_history SET body=? WHERE id=?').run('{malformed', broken.id); });
    assert.throws(() => schedule.tick());
    assert.deepEqual(schedule.status(), before);
    assert.throws(() => schedule.result(), /no committed/);
    assert.equal(schedule.store.get(`summary:${due}`), undefined);
    schedule.close(); schedule = new WeeklySchedule(f.directory, f.root, () => now);
    assert.deepEqual(schedule.status(), before);
    inspect(path, db => { db.prepare('UPDATE run_history SET body=? WHERE id=?').run(original as string, broken.id); });
    const result = schedule.tick(); assert.ok(result.summary); assert.equal(result.summary.dependencyCount, 102);
    const persisted = serialize(result.summary);
    // Simulate interruption after commit and before stdout: reopening only reads committed output.
    schedule.close(); schedule = new WeeklySchedule(f.directory, f.root, () => now);
    assert.equal(serialize(schedule.result()), persisted); assert.equal(schedule.tick().status, 'not-due');
  } finally { schedule.close(); history.close(); f.dispose(); }
});

test('BEGIN IMMEDIATE serializes competing tick connections without partial writes', () => {
  const f = fixture(); let now = due - 1;
  const first = new WeeklySchedule(f.directory, f.root, () => now), second = new WeeklySchedule(f.directory, f.root, () => now);
  const lock = new DatabaseSync(first.store.database.path);
  try {
    first.configure(); now = due;
    lock.exec('BEGIN IMMEDIATE');
    try { assert.throws(() => second.tick(), /locked|busy/i); }
    finally { lock.exec('ROLLBACK'); }
    assert.equal(first.status().lowerExclusive, 0); assert.equal(first.status().lastCompletedDue, null);
    assert.equal(first.tick().status, 'committed'); assert.equal(second.tick().status, 'not-due');
    assert.deepEqual(first.result(), second.result());
    const count = first.store.database.db.prepare("SELECT count(*) AS n FROM owner_values WHERE key LIKE 'summary:%'").get()?.n;
    assert.equal(count, 1);
  } finally { lock.close(); second.close(); first.close(); f.dispose(); }
});

test('separate schedule schema coexists with project memory and isolates registered clones', () => {
  const f = fixture(), clone = join(f.base, 'clone'); cpSync(f.root, clone, { recursive: true });
  const path = databasePath(f.directory, f.root, f.projectId);
  const schema = () => inspect(path, db => ({ version: db.prepare('PRAGMA user_version').get()?.user_version,
    tables: db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY name').all() }));
  const before = schema(), id = f.memory.add(f.input()); f.memory.validate(id, id);
  const schedule = new WeeklySchedule(f.directory, f.root, () => due), other = new WeeklySchedule(f.directory, clone, () => due);
  try {
    assert.notEqual(schedule.store.database.path, path); assert.notEqual(schedule.store.database.path, other.store.database.path);
    schedule.configure(); schedule.tick(); assert.equal(other.tick().status, 'disabled');
    assert.deepEqual(schema(), before); assert.ok(f.memory.get(id)); f.memory.assertCurrent(f.memory.packet('SQLite'));
    assert.throws(() => other.result(), /no committed/);
  } finally { other.close(); schedule.close(); f.dispose(); }
});

test('malformed state, schema, result and project identity fail closed', () => {
  const f = fixture(); const schedule = new WeeklySchedule(f.directory, f.root, () => due);
  try {
    schedule.configure(); schedule.tick();
    const state = schedule.store.get('schedule') as Record<string, unknown>;
    schedule.store.put('schedule', { ...state, originalRoot: f.base });
    assert.throws(() => schedule.status(), /scope/); schedule.store.put('schedule', state);
    const summary = schedule.result();
    schedule.store.put(`summary:${due}`, { ...summary, selectedRuns: summary.selectedRuns + 1 });
    assert.throws(() => schedule.result(), /invalid weekly summary/); schedule.store.put(`summary:${due}`, summary);
    const db = schedule.store.database.db;
    db.exec("CREATE TRIGGER unexpected AFTER INSERT ON owner_values BEGIN SELECT 1; END");
    assert.throws(() => schedule.tick(), /schema/); db.exec('DROP TRIGGER unexpected');
    const profilePath = join(f.root, 'config/forgemind-project.json'), profile: unknown = JSON.parse(readFileSync(profilePath, 'utf8'));
    writeFileSync(profilePath, JSON.stringify({ ...(profile as object), projectId: 'changed' }));
    assert.throws(() => schedule.status(), /scope changed/);
  } finally { schedule.close(); f.dispose(); }
});

test('public state, linked roots/state/databases and in-project state reject', () => {
  const f = fixture();
  try {
    if (typeof process.getuid === 'function') {
      const state = join(f.base, 'public'); mkdirSync(state, { mode: 0o755 }); chmodSync(state, 0o755);
      assert.throws(() => new WeeklySchedule(state, f.root), /private/);
    }
    assert.throws(() => new WeeklySchedule(join(f.root, 'private-state'), f.root), /external/);
    if (process.platform !== 'win32') {
      const alias = join(f.base, 'alias'); symlinkSync(f.directory, alias);
      assert.throws(() => new WeeklySchedule(alias, f.root), /canonical/);
    }
    const schedule = new WeeklySchedule(f.directory, f.root, () => due), path = schedule.store.database.path;
    schedule.close();
    const linked = join(f.base, 'linked.sqlite'); linkSync(path, linked);
    assert.throws(() => new WeeklySchedule(f.directory, f.root), /unsafe/); rmSync(linked);
    if (typeof process.getuid === 'function') {
      chmodSync(path, 0o644); assert.throws(() => new WeeklySchedule(f.directory, f.root), /private/); chmodSync(path, 0o600);
    }
  } finally { f.dispose(); }
});
