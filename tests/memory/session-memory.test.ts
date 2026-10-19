import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, linkSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SessionMemory } from '../../src/memory/session-memory.js';
import { SessionStorage, sessionDatabasePath } from '../../src/memory/session-storage.js';
import { sessionLimits } from '../../src/memory/session-contracts.js';
import type { SessionFields, SessionPacket } from '../../src/memory/session-contracts.js';
import { digest, serialize } from '../../src/context-engine/validation.js';
import { fixture } from './fixture.js';

function fields(sessionId = 'session-1'): SessionFields {
  return { sessionId, taskId: 'task-1', sourceSnapshot: 'a'.repeat(64),
    evidenceRefs: [{ id: 'b'.repeat(64), sha256: 'c'.repeat(64) }],
    completedStepIds: ['inspect'], nextStepIds: ['implement'], hypothesesSummary: 'A checkpoint for owner review.' };
}
const expectation = (packet: Readonly<SessionPacket>) => ({ expectedDigest: packet.record.digest, expectedRevision: packet.record.revision });
function setup(initialNow = 2000) {
  const project = fixture(), directory = join(project.base, 'sessions'); let now = initialNow;
  let store = new SessionMemory(directory, project.root, () => now);
  return { project, directory, get store() { return store; },
    get path() { return sessionDatabasePath(directory, project.root, project.projectId); },
    setNow(value: number) { now = value; },
    reopen() { store.close(); store = new SessionMemory(directory, project.root, () => now); },
    dispose() { store.close(); project.dispose(); } };
}
function trySymlink(target: string, path: string, type: 'dir' | 'file', context: TestContext): boolean {
  try { symlinkSync(target, path, type); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== 'win32' || !code || !['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(code)) throw error;
    context.diagnostic(`Omitted only symlink assertion for ${path}: Windows symlink creation unavailable (${code}).`);
    return false;
  }
  return true;
}

test('session persists across restart with bounded immutable evidence and separate schema', () => {
  const f = setup(); try {
    const original = f.store.put(fields(), 60); f.reopen();
    assert.deepEqual(f.store.get('session-1'), original); assert.deepEqual(f.store.list(), [original]);
    assert.equal(original.trust, 'evidence-only'); assert.ok(Object.isFrozen(original.record.evidenceRefs));
    const { digest: stored, ...body } = original; assert.equal(stored, digest(serialize(body)));
    assert.ok(Buffer.byteLength(serialize(original)) <= 16000);
    const raw = new DatabaseSync(f.path);
    assert.equal(raw.prepare('PRAGMA user_version').get()?.user_version, 1);
    assert.deepEqual(raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map(row => row.name), ['session_identity', 'session_records']);
    raw.close();
    if (typeof process.getuid === 'function') {
      assert.equal(statSync(f.directory).mode & 0o777, 0o700); assert.equal(statSync(f.path).mode & 0o777, 0o600);
    }
    assert.deepEqual(f.project.memory.list(), [], 'project memory schema/content untouched');
  } finally { f.dispose(); }
});

test('explicit owner TTL is required, bounded, safe, and never renewed by checkpoint', () => {
  const f = setup(); try {
    for (const ttl of [0, -1, 0.5, NaN, Infinity, sessionLimits.ttlSeconds + 1]) assert.throws(() => f.store.put(fields(), ttl));
    const missingTtl = f.store.put.bind(f.store) as unknown as (input: SessionFields) => unknown;
    assert.throws(() => missingTtl(fields())); assert.deepEqual(f.store.list(), []);
    const first = f.store.put(fields(), 2); f.setNow(2500);
    const next = f.store.checkpoint({ ...fields(), hypothesesSummary: 'Owner narrowed the hypothesis.' }, expectation(first));
    assert.equal(next.record.expiresAt, first.record.expiresAt); assert.equal(next.record.createdAt, 2000);
    assert.equal(next.record.updatedAt, 2500); assert.equal(next.record.revision, 2);
    f.setNow(Number.MAX_SAFE_INTEGER); assert.throws(() => f.store.put(fields('unsafe-time'), 1));
  } finally { f.dispose(); }
});

test('expiry redacts durably, survives restart/clock rollback, and blocks replay', () => {
  const f = setup(); try {
    const value = { ...fields(), hypothesesSummary: 'uniqueexpirybodytoken' }, packet = f.store.put(value, 1);
    f.setNow(3000); assert.equal(f.store.get(value.sessionId), undefined);
    assert.throws(() => f.store.checkpoint(value, expectation(packet))); f.store.close();
    const raw = new DatabaseSync(f.path), row = raw.prepare('SELECT * FROM session_records').get();
    assert.equal(row?.body, null); assert.equal(row?.state, 'expired'); assert.equal(row?.revision, 2); raw.close();
    assert.equal(readFileSync(f.path).includes(Buffer.from('uniqueexpirybodytoken')), false);
    f.setNow(1000); f.reopen(); assert.equal(f.store.get(value.sessionId), undefined); assert.deepEqual(f.store.list(), []);
    assert.throws(() => f.store.put(value, 60)); assert.throws(() => f.store.remove(value.sessionId, expectation(packet)));
  } finally { f.dispose(); }
});

test('persisted high-water time prevents rollback extending a session lifetime or decreasing update time', () => {
  const f = setup(); try {
    const packet = f.store.put(fields(), 2); f.setNow(3500); assert.ok(f.store.get('session-1'));
    f.setNow(1000); f.reopen();
    const next = f.store.checkpoint(fields(), expectation(packet));
    assert.equal(next.record.updatedAt, 3500); assert.equal(next.record.expiresAt, 4000);
    f.setNow(4000); assert.equal(f.store.get('session-1'), undefined);
    f.setNow(2000); f.reopen(); assert.equal(f.store.get('session-1'), undefined);
  } finally { f.dispose(); }
});

test('delete leaves only permanent content-free tombstone and stale revisions/digests fail closed', () => {
  const f = setup(); try {
    const original = f.store.put({ ...fields(), hypothesesSummary: 'uniquedeletebodytoken' }, 60);
    assert.throws(() => f.store.checkpoint(fields(), { ...expectation(original), expectedDigest: 'f'.repeat(64) }));
    assert.throws(() => f.store.checkpoint(fields(), { ...expectation(original), expectedRevision: 2 }));
    assert.throws(() => f.store.checkpoint({ ...fields(), taskId: 'other-task' }, expectation(original)));
    const next = f.store.checkpoint({ ...fields(), hypothesesSummary: 'uniquedeletebodytoken' }, expectation(original));
    assert.throws(() => f.store.checkpoint(fields(), expectation(original)));
    assert.throws(() => f.store.remove('session-1', expectation(original)));
    f.store.remove('session-1', expectation(next)); f.reopen();
    assert.equal(f.store.get('session-1'), undefined); assert.throws(() => f.store.put(fields(), 60));
    assert.throws(() => f.store.checkpoint(fields(), expectation(next)));
    const raw = new DatabaseSync(f.path), row = raw.prepare('SELECT * FROM session_records').get();
    assert.equal(row?.body, null); assert.equal(row?.state, 'deleted'); assert.equal(row?.revision, 3); raw.close();
    assert.equal(readFileSync(f.path).includes(Buffer.from('uniquedeletebodytoken')), false);
  } finally { f.dispose(); }
});

test('strict structured fields reject unknown data, unsafe IDs, accessors and malformed references without invoking getters', () => {
  const f = setup(); try {
    for (const unknown of ['rawConversation', 'messages', 'secrets', 'authorized']) {
      assert.throws(() => f.store.put({ ...fields(), [unknown]: 'do not persist' } as SessionFields, 60));
    }
    for (const id of ['../escape', '/absolute', 'a/b', 'a.b', '', 'x'.repeat(129)]) assert.throws(() => f.store.put(fields(id), 60));
    assert.throws(() => f.store.put({ ...fields(), evidenceRefs: [{ id: 'bad', sha256: 'c'.repeat(64) }] }, 60));
    assert.throws(() => f.store.put({ ...fields(), nextStepIds: ['inspect'] }, 60));
    assert.throws(() => f.store.put({ ...fields(), completedStepIds: ['one', 'one'] }, 60));
    assert.throws(() => f.store.put({ ...fields(), hypothesesSummary: 'x'.repeat(2049) }, 60));
    let invoked = false; const value = fields();
    Object.defineProperty(value, 'hypothesesSummary', { enumerable: true, get() { invoked = true; return 'bad'; } });
    assert.throws(() => f.store.put(value, 60)); assert.equal(invoked, false);
    const nested = fields(); Object.defineProperty(nested.nextStepIds, '0', { get() { invoked = true; return 'bad'; } });
    assert.throws(() => f.store.put(nested, 60)); assert.equal(invoked, false);
    assert.deepEqual(f.store.list(), []);
    f.setNow(NaN); assert.throws(() => f.store.get('session-1'));
  } finally { f.dispose(); }
});

test('bounded deterministic listing supports pagination and rejects excessive fields/limits', () => {
  const f = setup(); try {
    for (const id of ['c', 'a', 'b']) f.store.put(fields(id), 60);
    assert.deepEqual(f.store.list(2).map(packet => packet.record.sessionId), ['a', 'b']);
    assert.deepEqual(f.store.list(2, 'b').map(packet => packet.record.sessionId), ['c']);
    assert.throws(() => f.store.list(51)); assert.throws(() => f.store.list(1, '../bad'));
    assert.throws(() => f.store.put({ ...fields('large'), nextStepIds: Array.from({ length: 65 }, (_, i) => `step-${i}`) }, 60));
  } finally { f.dispose(); }
});

test('copied database rejects a different workspace/project even with owner-private modes', () => {
  const a = setup(), b = fixture('project-b'); let other: SessionMemory | undefined;
  try {
    a.store.put(fields(), 60); a.store.close();
    other = new SessionMemory(a.directory, b.root, () => 2000); assert.deepEqual(other.list(), []); other.close();
    copyFileSync(a.path, sessionDatabasePath(a.directory, b.root, b.projectId));
    assert.throws(() => new SessionMemory(a.directory, b.root, () => 2000), /identity mismatch/);
  } finally { other?.close(); a.dispose(); b.dispose(); }
});

test('project identity drift denies operations while close remains available', () => {
  const f = setup(); try {
    const packet = f.store.put(fields(), 60), path = join(f.project.root, 'config/forgemind-project.json');
    const profile = JSON.parse(readFileSync(path, 'utf8')); profile.projectId = 'changed'; writeFileSync(path, JSON.stringify(profile));
    assert.throws(() => f.store.get('session-1'), /identity changed/); assert.throws(() => f.store.list());
    assert.throws(() => f.store.checkpoint(fields(), expectation(packet))); assert.throws(() => f.store.remove('session-1', expectation(packet)));
    assert.doesNotThrow(() => f.store.close()); assert.doesNotThrow(() => f.store.close());
  } finally { f.dispose(); }
});

test('outside canonical private directory required; database symlinks/hardlinks and sidecars rejected before open', context => {
  for (const kind of ['database-link', 'database-hardlink', 'journal-link', 'wal-hardlink', 'shm-mode', 'directory-mode', 'database-mode'] as const) {
    if (typeof process.getuid !== 'function' && (kind === 'shm-mode' || kind === 'directory-mode' || kind === 'database-mode')) {
      context.diagnostic(`Omitted only ${kind} case: POSIX UID/mode checks unavailable.`);
      continue;
    }
    const f = setup(); try {
      f.store.close();
      const target = join(f.project.base, 'target'); writeFileSync(target, '', { mode: 0o600 });
      if (kind === 'database-link') { rmSync(f.path); if (!trySymlink(target, f.path, 'file', context)) continue; }
      if (kind === 'database-hardlink') linkSync(f.path, join(f.project.base, 'copy-link'));
      if (kind === 'journal-link' && !trySymlink(target, f.path + '-journal', 'file', context)) continue;
      if (kind === 'wal-hardlink') linkSync(target, f.path + '-wal');
      if (kind === 'shm-mode') writeFileSync(f.path + '-shm', '', { mode: 0o644 });
      if (kind === 'directory-mode') chmodSync(f.directory, 0o755);
      if (kind === 'database-mode') chmodSync(f.path, 0o644);
      assert.throws(() => f.reopen(), /private|canonical/, kind);
    } finally { f.dispose(); }
  }
  const f = setup(); try {
    assert.throws(() => new SessionMemory(join(f.project.root, 'sessions'), f.project.root), /outside/);
    const alias = join(f.project.base, 'alias');
    if (trySymlink(f.directory, alias, 'dir', context)) {
      assert.throws(() => new SessionMemory(alias, f.project.root), /canonical/);
    }
  } finally { f.dispose(); }
});

test('future/malformed schema, corrupt identity and malformed body fail closed on restart', () => {
  for (const mutation of ['future', 'schema', 'identity', 'body'] as const) {
    const f = setup(); try {
      f.store.put(fields(), 60); f.store.close(); const raw = new DatabaseSync(f.path);
      if (mutation === 'future') raw.exec('PRAGMA user_version = 999');
      if (mutation === 'schema') raw.exec('ALTER TABLE session_records ADD COLUMN surprise TEXT');
      if (mutation === 'identity') raw.prepare('UPDATE session_identity SET workspace = ?').run('/foreign');
      if (mutation === 'body') raw.prepare('UPDATE session_records SET body = ?').run('{}');
      raw.close(); assert.throws(() => f.reopen());
    } finally { f.dispose(); }
  }
});

test('short transaction rollback and SQLite timeout leave no partial checkpoint or candidate', () => {
  const f = setup(); try {
    const original = f.store.put(fields(), 60), raw = new DatabaseSync(f.path);
    raw.exec("CREATE TRIGGER reject_checkpoint BEFORE UPDATE ON session_records WHEN NEW.body IS NOT NULL AND NEW.revision > OLD.revision BEGIN SELECT RAISE(ABORT, 'fixture rejection'); END");
    assert.throws(() => f.store.checkpoint({ ...fields(), hypothesesSummary: 'must roll back' }, expectation(original)), /fixture rejection/);
    assert.deepEqual(f.store.get('session-1'), original); raw.exec('DROP TRIGGER reject_checkpoint');
    raw.exec('BEGIN IMMEDIATE');
    try { assert.throws(() => f.store.put(fields('blocked'), 60), /locked/); } finally { raw.exec('ROLLBACK'); raw.close(); }
    assert.equal(f.store.get('blocked'), undefined); assert.deepEqual(f.store.get('session-1'), original);
  } finally { f.dispose(); }
});

test('put uses peer high-water committed between maintenance and insertion', () => {
  const f = setup(1000), originalTick = SessionStorage.prototype.tick;
  let peer: SessionMemory | undefined, peerNow = 1000, fired = false;
  let target: SessionStorage | undefined;
  try {
    peer = new SessionMemory(f.directory, f.project.root, () => peerNow);
    const other = peer;
    SessionStorage.prototype.tick = function (now: number): number {
      const at = originalTick.call(this, now);
      if (!fired && this.path === f.path && (target === undefined || this === target)) {
        target = this; fired = true; peerNow = 3000;
        assert.equal(other.get('unused'), undefined);
      }
      return at;
    };
    const packet = f.store.put({ ...fields(), hypothesesSummary: 'creation race body' }, 1);
    assert.equal(fired, true);
    assert.equal(packet.record.createdAt, 3000); assert.equal(packet.record.updatedAt, 3000);
    assert.equal(packet.record.expiresAt, 4000);
    const raw = new DatabaseSync(f.path);
    try {
      const highWater = raw.prepare('SELECT high_water FROM session_identity WHERE singleton = 1').get()?.high_water;
      const row = raw.prepare('SELECT state, body, expires_at FROM session_records WHERE id = ?').get('session-1');
      assert.equal(highWater, 3000); assert.equal(row?.state, 'active');
      assert.equal(row?.body, JSON.stringify(packet.record)); assert.equal(row?.expires_at, 4000);
      assert.ok(packet.record.expiresAt > (highWater as number));
      assert.deepEqual(other.get('session-1'), packet);
      peerNow = 5000; assert.equal(other.get('session-1'), undefined);
      const expired = raw.prepare('SELECT state, body FROM session_records WHERE id = ?').get('session-1');
      assert.equal(expired?.state, 'expired'); assert.equal(expired?.body, null);
      peerNow = 1000; f.setNow(1000);
      assert.equal(f.store.get('session-1'), undefined); assert.equal(other.get('session-1'), undefined);
    } finally { raw.close(); }
  } finally { SessionStorage.prototype.tick = originalTick; peer?.close(); f.dispose(); }
});

test('put rejects expiry overflow at peer high-water while committed maintenance survives', () => {
  const f = setup(1000), originalTick = SessionStorage.prototype.tick;
  let peer: SessionMemory | undefined, peerNow = 1000, fired = false;
  let target: SessionStorage | undefined;
  try {
    f.store.put({ ...fields('old'), hypothesesSummary: 'overflow maintenance body' }, 1);
    peer = new SessionMemory(f.directory, f.project.root, () => peerNow);
    const other = peer, highWater = Number.MAX_SAFE_INTEGER - 500;
    SessionStorage.prototype.tick = function (now: number): number {
      const at = originalTick.call(this, now);
      if (!fired && this.path === f.path && (target === undefined || this === target)) {
        target = this; fired = true; peerNow = highWater;
        assert.equal(other.get('unused'), undefined);
      }
      return at;
    };
    assert.throws(() => f.store.put(fields('overflow'), 1), /unsafe session expiry/);
    assert.equal(fired, true);
    const raw = new DatabaseSync(f.path);
    try {
      assert.equal(raw.prepare('SELECT high_water FROM session_identity WHERE singleton = 1').get()?.high_water, highWater);
      assert.equal(raw.prepare('SELECT 1 FROM session_records WHERE id = ?').get('overflow'), undefined);
      assert.equal(raw.prepare('SELECT count(*) AS total FROM session_records').get()?.total, 1);
      const expired = raw.prepare('SELECT state, body, revision FROM session_records WHERE id = ?').get('old');
      assert.equal(expired?.state, 'expired'); assert.equal(expired?.body, null); assert.equal(expired?.revision, 2);
      peerNow = 1000; f.setNow(1000);
      assert.equal(f.store.get('old'), undefined); assert.equal(other.get('old'), undefined);
      assert.equal(f.store.get('overflow'), undefined);
    } finally { raw.close(); }
  } finally { SessionStorage.prototype.tick = originalTick; peer?.close(); f.dispose(); }
});
