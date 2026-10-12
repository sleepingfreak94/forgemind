import assert from 'node:assert/strict';
import test from 'node:test';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { databasePath, MemoryDatabase } from '../../src/memory/database.js';
import { fixture } from './fixture.js';

const legacyDDL = `
  CREATE TABLE identity (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), project_id TEXT NOT NULL, workspace TEXT NOT NULL) STRICT;
  CREATE TABLE records (id TEXT PRIMARY KEY, digest TEXT NOT NULL, kind TEXT NOT NULL,
    state TEXT NOT NULL, expires_at INTEGER, body TEXT) STRICT;
  CREATE VIRTUAL TABLE memory_fts USING fts5(record_id UNINDEXED, title, text, tokenize='unicode61');
  CREATE TABLE audit (sequence INTEGER PRIMARY KEY, action TEXT NOT NULL, record_id TEXT NOT NULL, at INTEGER NOT NULL) STRICT;
  CREATE TABLE deleted_sources (path TEXT NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(path, sha256)) STRICT;
  INSERT INTO memory_fts(memory_fts, rank) VALUES ('secure-delete', 1);
`;
function store(f: ReturnType<typeof fixture>) {
  const directory = join(f.base, 'schema-state'), path = databasePath(directory, f.root, f.projectId);
  mkdirSync(directory, { mode: 0o700 }); mkdirSync(dirname(path), { mode: 0o700 });
  closeSync(openSync(path, 'wx', 0o600));
  return { directory, path };
}
function legacy(f: ReturnType<typeof fixture>, version = 1, projectId = f.projectId) {
  const selected = store(f);
  inspect(selected.path, db => {
    db.exec(legacyDDL);
    db.prepare('INSERT INTO identity VALUES (1, ?, ?)').run(projectId, f.root);
    db.prepare('INSERT INTO records VALUES (?, ?, ?, ?, ?, ?)').run('legacy', 'digest', 'decision', 'active', null, '{"legacy":true}');
    db.prepare('INSERT INTO memory_fts(record_id, title, text) VALUES (?, ?, ?)').run('legacy', 'SQLite storage', 'Durable decisions');
    db.exec("INSERT INTO audit VALUES (7, 'create', 'legacy', 1000); INSERT INTO deleted_sources VALUES ('docs/old.md', 'old-sha');");
    db.exec(`PRAGMA user_version = ${version}`);
  });
  return selected;
}
function inspect<T>(path: string, work: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try { return work(db); } finally { db.close(); }
}
function contents(db: DatabaseSync) {
  return ['identity', 'records', 'memory_fts', 'audit', 'deleted_sources'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}
function snapshot(path: string) {
  return inspect(path, db => ({
    version: db.prepare('PRAGMA user_version').get()?.user_version,
    schema: db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
    contents: contents(db),
    history: db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'run_history'").get() ? db.prepare('SELECT * FROM run_history ORDER BY sequence').all() : null
  }));
}

test('fresh schema 0 becomes schema 2 with STRICT run_history', () => {
  const f = fixture(); try {
    const selected = store(f);
    inspect(selected.path, db => assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 0));
    const memory = new MemoryDatabase(selected.directory, f.root, f.projectId);
    try {
      const db = memory.db;
      assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 2);
      assert.equal(db.prepare("SELECT strict FROM pragma_table_list WHERE name = 'run_history'").get()?.strict, 1);
      assert.deepEqual(db.prepare('PRAGMA table_info(run_history)').all().map(row => row.name), ['sequence', 'id', 'digest', 'body', 'recorded_at', 'revoked']);
      db.exec("INSERT INTO run_history(id, digest, body, recorded_at) VALUES ('first', 'digest', NULL, 1000)");
      assert.equal(db.prepare('SELECT revoked FROM run_history').get()?.revoked, 0);
      assert.throws(() => db.exec("INSERT INTO run_history(id, digest, recorded_at) VALUES ('first', 'digest', 1000)"));
      assert.throws(() => db.exec('UPDATE run_history SET revoked = 2'));
      assert.throws(() => db.exec("UPDATE run_history SET recorded_at = 'invalid'"));
      db.exec("DELETE FROM run_history; INSERT INTO run_history(id, digest, recorded_at) VALUES ('second', 'digest', 1001)");
      assert.equal(db.prepare('SELECT sequence FROM run_history').get()?.sequence, 2);
    } finally { memory.close(); }
  } finally { f.dispose(); }
});
test('explicit legacy schema 1 retains records, FTS, audit and deleted sources', () => {
  const f = fixture(); try {
    const selected = legacy(f), before = inspect(selected.path, contents);
    const memory = new MemoryDatabase(selected.directory, f.root, f.projectId);
    try {
      assert.equal(memory.db.prepare('PRAGMA user_version').get()?.user_version, 2);
      assert.equal(memory.db.prepare("SELECT strict FROM pragma_table_list WHERE name = 'run_history'").get()?.strict, 1);
      assert.deepEqual(contents(memory.db), before);
      assert.equal(memory.db.prepare('SELECT record_id FROM memory_fts WHERE memory_fts MATCH ?').get('SQLite')?.record_id, 'legacy');
    } finally { memory.close(); }
  } finally { f.dispose(); }
});
test('schema 2 restart preserves schema and history', () => {
  const f = fixture(); try {
    const selected = store(f), memory = new MemoryDatabase(selected.directory, f.root, f.projectId);
    try { memory.db.exec("INSERT INTO run_history(id, digest, body, recorded_at) VALUES ('saved', 'digest', 'body', 1000)"); } finally { memory.close(); }
    const before = snapshot(selected.path), reopened = new MemoryDatabase(selected.directory, f.root, f.projectId);
    try { assert.deepEqual(snapshot(selected.path), before); } finally { reopened.close(); }
  } finally { f.dispose(); }
});
test('legacy identity mismatch rolls back schema, version and data', () => {
  const f = fixture(); try {
    const selected = legacy(f, 1, 'another-project'), before = snapshot(selected.path);
    assert.throws(() => new MemoryDatabase(selected.directory, f.root, f.projectId), /identity mismatch/);
    assert.deepEqual(snapshot(selected.path), before);
  } finally { f.dispose(); }
});
test('future schema rejection preserves schema, version and data', () => {
  const f = fixture(); try {
    const selected = legacy(f, 3), before = snapshot(selected.path);
    assert.throws(() => new MemoryDatabase(selected.directory, f.root, f.projectId), /unsupported memory schema/);
    assert.deepEqual(snapshot(selected.path), before);
  } finally { f.dispose(); }
});
