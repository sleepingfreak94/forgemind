import { strict as assert } from 'node:assert';
import { copyFileSync, cpSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { digest, serialize } from '../../src/context-engine/validation.js';
import { databasePath } from '../../src/memory/database.js';
import type { TerminalRunInput } from '../../src/memory/run-contracts.js';
import { RunHistory } from '../../src/memory/run-history.js';
import { profilePath } from '../../src/project-workflow/project.js';
import { fixture } from './fixture.js';

const sha = (value: number) => digest(`run-${value}`);
function run(value = 1): TerminalRunInput {
  return { schemaVersion: 1, runId: sha(value), taskId: 'task', execution: 'fixture', startedAt: 10, endedAt: 20,
    outcome: 'completed', lastPhase: 'terminal', baselineSource: sha(100), candidateSource: sha(101),
    changedPaths: ['src/example.ts'], checks: [{ phase: 'candidate', id: 'compiler', outcome: 'passed', exitCode: 0,
      source: sha(101), evidenceSha256: sha(102) }], review: { outcome: 'pass', source: sha(101), evidenceSha256: sha(103) },
    terminalReceiptSha256: sha(104) };
}
const options = { afterSequence: 0, limit: 100 };

test('immutable scoped facts survive restart and registered clones remain isolated', () => {
  const f = fixture(); let now = 1000, history = new RunHistory(f.directory, f.root, () => now);
  let clone: RunHistory | undefined;
  try {
    const input = { ...run(), changedPaths: ['src/example.ts'] }, first = history.record(input);
    input.changedPaths.push('src/later.ts'); now = 2000;
    assert.deepEqual(first.changedPaths, ['src/example.ts']);
    assert.ok(Object.isFrozen(first) && Object.isFrozen(first.changedPaths) && Object.isFrozen(first.checks));
    const check = first.checks.at(0); assert.ok(check); assert.ok(Object.isFrozen(check));
    assert.ok(first.review); assert.ok(Object.isFrozen(first.review));
    assert.throws(() => (first.changedPaths as string[]).push('mutated.ts'));
    assert.equal(first.id, digest(serialize({ projectId: f.projectId, workspaceRoot: f.root, runId: run().runId })));
    assert.equal(first.digest, digest(serialize({ ...run(), projectId: f.projectId, workspaceRoot: f.root })));
    assert.deepEqual(history.record(run()), first);
    history.close(); history = new RunHistory(f.directory, f.root, () => now);
    assert.deepEqual(history.inspect(first.id), first);
    const cloneRoot = join(f.base, 'clone'); cpSync(f.root, cloneRoot, { recursive: true });
    clone = new RunHistory(f.directory, cloneRoot, () => now);
    assert.equal(clone.inspect(first.id), undefined); assert.deepEqual(clone.list(options), []);
    const other = clone.record(run()); assert.notEqual(other.id, first.id); assert.notEqual(other.digest, first.digest);
    clone.close(); history.close();
    copyFileSync(databasePath(f.directory, f.root, f.projectId), databasePath(f.directory, cloneRoot, f.projectId));
    assert.throws(() => new RunHistory(f.directory, cloneRoot), /identity mismatch/);
  } finally { clone?.close(); history.close(); f.dispose(); }
});

test('profile and canonical root drift fail closed while close always releases storage', () => {
  const f = fixture(), path = join(f.root, profilePath), original = readFileSync(path, 'utf8');
  let history = new RunHistory(f.directory, f.root);
  try {
    const first = history.record(run());
    writeFileSync(path, original.replace('"projectId": "project-a"', '"projectId": "project-b"'));
    for (const operation of [() => history.record(run(2)), () => history.inspect(first.id),
      () => history.list(options), () => history.revoke(first.id, first.digest)]) assert.throws(operation, /project identity changed/);
    assert.doesNotThrow(() => history.close()); writeFileSync(path, original);
    history = new RunHistory(f.directory, f.root); assert.deepEqual(history.inspect(first.id), first);
    const moved = join(f.base, 'moved'); renameSync(f.root, moved); symlinkSync(moved, f.root, 'dir');
    try {
      for (const operation of [() => history.record(run(2)), () => history.inspect(first.id),
        () => history.list(options), () => history.revoke(first.id, first.digest)]) assert.throws(operation, /canonical workspace/);
      assert.doesNotThrow(() => history.close());
    } finally { unlinkSync(f.root); renameSync(moved, f.root); }
    history = new RunHistory(f.directory, f.root); assert.deepEqual(history.inspect(first.id), first);
  } finally { history.close(); writeFileSync(path, original); f.dispose(); }
});

test('deduplication is immutable and revocation retains only a permanent tombstone', () => {
  const f = fixture(); let history = new RunHistory(f.directory, f.root, () => 1000);
  const peer = new DatabaseSync(databasePath(f.directory, f.root, f.projectId));
  try {
    const first = history.record(run()); assert.deepEqual(history.record(run()), first);
    assert.throws(() => history.record({ ...run(), taskId: 'changed' }), /conflict/);
    assert.throws(() => history.record({ ...run(), transcript: 'unapproved payload' }));
    assert.throws(() => history.inspect('invalid')); assert.throws(() => history.revoke(first.id, 'invalid'));
    assert.throws(() => history.revoke(first.id, sha(999)), /digest conflict/);
    assert.deepEqual(history.inspect(first.id), first);
    history.revoke(first.id, first.digest); history.revoke(first.id, first.digest);
    assert.throws(() => history.revoke(first.id, sha(999)), /digest conflict/);
    assert.equal(history.inspect(first.id), undefined); assert.deepEqual(history.list(options), []);
    const row = peer.prepare('SELECT * FROM run_history WHERE id = ?').get(first.id); assert.ok(row);
    assert.equal(row.body, null); assert.equal(row.revoked, 1); assert.equal(row.id, first.id);
    assert.equal(row.digest, first.digest); assert.equal(row.sequence, first.sequence); assert.equal(row.recorded_at, first.recordedAt);
    assert.throws(() => history.record(run()), /revoked/);
    history.close(); history = new RunHistory(f.directory, f.root);
    assert.equal(history.inspect(first.id), undefined); assert.throws(() => history.record(run()), /revoked/);
    assert.throws(() => history.record({ ...run(), taskId: 'changed' }), /revoked/);
    history.revoke(first.id, first.digest);
    assert.equal(peer.prepare('SELECT count(*) AS count FROM run_history').get()?.count, 1);
  } finally { peer.close(); history.close(); f.dispose(); }
});

test('bounded pagination defaults ascending and insertion watermarks do not hide revocations', () => {
  const f = fixture(), history = new RunHistory(f.directory, f.root, () => 0);
  try {
    const first = history.record(run(1)), second = history.record(run(2)), third = history.record(run(3));
    const page = history.list({ afterSequence: 0, limit: 1 }), cursor = page.at(0); assert.ok(cursor);
    assert.equal(page.length, 1); assert.equal(cursor.id, first.id);
    assert.deepEqual(history.list({ afterSequence: cursor.sequence, limit: 2 }).map(row => row.id), [second.id, third.id]);
    assert.deepEqual(history.list({ afterSequence: 0, limit: 2, order: 'desc' }).map(row => row.id), [third.id, second.id]);
    assert.deepEqual(history.list({ ...options, order: 'asc' }).map(row => row.id), [first.id, second.id, third.id]);
    const watermark = third.sequence; history.record(run(4)); history.revoke(second.id, second.digest);
    assert.deepEqual(history.list({ ...options, throughSequence: watermark }).map(row => row.id), [first.id, third.id]);
    assert.deepEqual(history.list({ ...options, throughSequence: 0 }), []);
    const invalid: unknown[] = [null, { ...options, extra: true }, { ...options, order: 'sideways' }, { ...options, order: null },
      ...[-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(afterSequence => ({ ...options, afterSequence })),
      ...[-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null].map(throughSequence => ({ ...options, throughSequence })),
      ...[0, -1, 101, 1.5, NaN, Infinity].map(limit => ({ ...options, limit }))];
    for (const value of invalid) assert.throws(() => history.list(value as Parameters<RunHistory['list']>[0]));
  } finally { history.close(); f.dispose(); }
});

test('invalid clocks and a second SQLite writer leave no partial records or revocations', () => {
  const f = fixture(); let now = -1;
  const history = new RunHistory(f.directory, f.root, () => now), peer = new DatabaseSync(databasePath(f.directory, f.root, f.projectId));
  let locked = false;
  try {
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      now = value; assert.throws(() => history.record(run())); assert.deepEqual(history.list(options), []);
    }
    now = 0; const first = history.record(run()); assert.equal(first.recordedAt, 0);
    peer.exec('BEGIN IMMEDIATE'); locked = true;
    assert.throws(() => history.record(run(2)), /locked|busy/i);
    assert.throws(() => history.revoke(first.id, first.digest), /locked|busy/i);
    assert.equal(peer.prepare('SELECT count(*) AS count FROM run_history').get()?.count, 1);
    assert.deepEqual(history.inspect(first.id), first);
    peer.exec('ROLLBACK'); locked = false;
    assert.equal(peer.prepare('SELECT count(*) AS count FROM run_history').get()?.count, 1);
    const second = history.record(run(2)); assert.equal(second.sequence, first.sequence + 1);
  } finally { if (locked) peer.exec('ROLLBACK'); peer.close(); history.close(); f.dispose(); }
});

test('persisted body, scope, identity, digest and metadata are verified before return', () => {
  const f = fixture(), history = new RunHistory(f.directory, f.root, () => 1000);
  const peer = new DatabaseSync(databasePath(f.directory, f.root, f.projectId));
  try {
    const first = history.record(run()), facts = { ...run(), projectId: f.projectId, workspaceRoot: f.root }, body = serialize(facts);
    const valid = { body, digest: first.digest, sequence: first.sequence, at: first.recordedAt };
    const foreign = serialize({ ...facts, workspaceRoot: join(f.base, 'foreign') });
    for (const change of [{ ...valid, body: '{' }, { ...valid, body: JSON.stringify(facts, null, 2) },
      { ...valid, body: serialize({ ...facts, extra: true }) }, { ...valid, body: foreign, digest: digest(foreign) },
      { ...valid, body: serialize({ ...facts, runId: sha(999) }), digest: digest(serialize({ ...facts, runId: sha(999) })) },
      { ...valid, digest: sha(999) }, { ...valid, sequence: 0 }, { ...valid, at: -1 }]) {
      peer.prepare('UPDATE run_history SET body = ?, digest = ?, sequence = ?, recorded_at = ? WHERE id = ?')
        .run(change.body, change.digest, change.sequence, change.at, first.id);
      assert.throws(() => history.inspect(first.id));
      assert.throws(() => history.record(run()));
      assert.throws(() => history.revoke(first.id, first.digest));
      if (change.sequence > 0) assert.throws(() => history.list(options));
    }
    peer.prepare('UPDATE run_history SET body = ?, digest = ?, sequence = ?, recorded_at = ? WHERE id = ?')
      .run(body, first.digest, first.sequence, first.recordedAt, first.id);
    assert.deepEqual(history.inspect(first.id), first);
    history.revoke(first.id, first.digest);
    peer.prepare('UPDATE run_history SET body = ? WHERE id = ?').run(body, first.id);
    assert.throws(() => history.inspect(first.id), /unredacted/);
    assert.throws(() => history.record(run()), /unredacted/);
  } finally { peer.close(); history.close(); f.dispose(); }
});
