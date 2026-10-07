import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './fixture.js';
import { ProjectMemory } from '../../src/memory/service.js';
import { databasePath } from '../../src/memory/database.js';
import { initializeProject } from '../../src/project-workflow/project.js';

test('ingestion persists after restart, preserves status and requires exact owner validation', () => {
  const f = fixture(); try {
    const first = f.memory.ingest(); assert.equal(first.documents, 4);
    assert.deepEqual(f.memory.ingest(), first); assert.equal(f.memory.list().length, 4);
    assert.deepEqual(f.memory.search('SQLite'), []);
    const item = f.memory.list().find(item => item.sources[0]!.path === f.path)!;
    assert.equal(item.sources[0]!.status, 'Accepted'); assert.equal(item.state, 'candidate');
    assert.throws(() => f.memory.validate(item.id, 'a'.repeat(64)));
    f.memory.validate(item.id, item.digest); f.reopen();
    assert.equal(f.memory.get(item.id)?.state, 'validated'); assert.equal(f.memory.search('SQLite')[0]?.id, item.id);
    assert.ok(f.memory.audit().some(event => event.action === 'validated-by-local-owner'));
    const draft = f.memory.list().find(item => item.sources[0]!.path === 'docs/PRD.md')!;
    assert.match(draft.sources[0]!.status, /Draft/); assert.equal(draft.state, 'candidate');
    f.memory.validate(draft.id, draft.digest);
    assert.match(f.memory.get(draft.id)!.sources[0]!.status, /Draft/, 'explicit evidence validation never rewrites source qualification');
  } finally { f.dispose(); }
});

test('different projects and cloned project IDs cannot select another workspace records', () => {
  const a = fixture(), b = fixture('project-b'); let clone: ProjectMemory | undefined;
  try {
    const id = a.memory.add(a.input()); a.memory.validate(id, id);
    assert.equal(b.memory.get(id), undefined); assert.throws(() => b.memory.validate(id, id)); assert.throws(() => b.memory.remove(id, id));
    const root = join(a.base, 'clone'); mkdirSync(root);
    initializeProject(root, { schemaVersion: 1, projectId: a.projectId, name: 'clone', documents: { prd: 'docs/PRD.md', srs: 'docs/SRS.md', adrs: 'docs/adr' }, preferences: { askAt: 'project' } }, true);
    clone = new ProjectMemory(a.directory, root);
    assert.deepEqual(clone.search('SQLite'), []); assert.equal(clone.inspect(id), undefined); clone.close();
    copyFileSync(databasePath(a.directory, a.root, a.projectId), databasePath(a.directory, root, a.projectId));
    assert.throws(() => new ProjectMemory(a.directory, root), /identity mismatch/);
  } finally { clone?.close(); a.dispose(); b.dispose(); }
});

test('changed/deleted sources and removed registrations invalidate recall without reingestion', () => {
  for (const mutation of ['change', 'delete', 'registration'] as const) {
    const f = fixture(); try {
      const id = f.memory.add(f.input()); f.memory.validate(id, id); assert.equal(f.memory.search('SQLite').length, 1);
      if (mutation === 'change') writeFileSync(join(f.root, f.path), '# Storage\nStatus: Accepted\nUse another database.\n');
      if (mutation === 'delete') rmSync(join(f.root, f.path));
      if (mutation === 'registration') {
        const path = join(f.root, 'config/forgemind-project.json'), profile = JSON.parse(readFileSync(path, 'utf8'));
        profile.documents.adrs = 'docs/new-adrs'; writeFileSync(path, JSON.stringify(profile));
      }
      assert.deepEqual(f.memory.search('SQLite'), []); assert.equal(f.memory.get(id), undefined); assert.equal(f.memory.inspect(id), undefined);
      assert.equal(f.memory.list().find(item => item.id === id)!.current, false);
      f.memory.ingest(); f.reopen(); assert.deepEqual(f.memory.search('SQLite'), []);
    } finally { f.dispose(); }
  }
});

test('validation checks current source bytes/status, candidates and project identity', () => {
  const f = fixture(); try {
    const input = f.input(), id = f.memory.add(input);
    assert.throws(() => f.memory.add({ ...input, sources: [{ ...input.sources[0]!, status: 'Forged accepted' }] }));
    writeFileSync(join(f.root, f.path), '# Changed\nStatus: Proposed\nSQLite is under consideration.');
    assert.throws(() => f.memory.validate(id, id)); assert.equal(f.memory.list()[0]?.state, 'candidate');
    const file = join(f.root, 'config/forgemind-project.json'), profile = JSON.parse(readFileSync(file, 'utf8'));
    profile.projectId = 'other'; writeFileSync(file, JSON.stringify(profile));
    assert.throws(() => f.memory.search('SQLite')); assert.throws(() => f.memory.remove(id, id)); assert.throws(() => f.memory.audit());
  } finally { f.dispose(); }
});

test('supersession is atomic and contradictory validated records remain visible', () => {
  const f = fixture(); try {
    const old = f.memory.add(f.input('SQLite use rollback journals.')); f.memory.validate(old, old);
    const fresh = f.memory.add({ ...f.input('SQLite use WAL journals.'), supersedes: old });
    const failed = new DatabaseSync(databasePath(f.directory, f.root, f.projectId));
    failed.exec("CREATE TRIGGER reject_validation BEFORE INSERT ON audit WHEN NEW.action = 'validated-by-local-owner' BEGIN SELECT RAISE(ABORT, 'fixture'); END;");
    assert.throws(() => f.memory.validate(fresh, fresh));
    assert.equal(f.memory.get(old)?.id, old); assert.equal(f.memory.inspect(fresh)?.state, 'candidate'); assert.equal(f.memory.search('SQLite').length, 1);
    failed.exec('DROP TRIGGER reject_validation'); failed.close();
    f.memory.validate(fresh, fresh); assert.equal(f.memory.get(old), undefined); assert.equal(f.memory.search('SQLite')[0]?.id, fresh);
    const opposing = f.memory.add(f.input('SQLite WAL is prohibited on this deployment.')); f.memory.validate(opposing, opposing);
    assert.equal(f.memory.search('SQLite').length, 2);
    assert.throws(() => f.memory.validate(fresh, fresh));
  } finally { f.dispose(); }
});

test('deleted documents redact derivatives and FTS and cannot reappear on import', () => {
  const f = fixture(); try {
    const token = 'confidentialuniquememoryterm';
    writeFileSync(join(f.root, f.path), `# Deletion fixture\nStatus: Accepted\n${token}\n`);
    f.memory.ingest(); const doc = f.memory.list().find(item => item.sources[0]!.path === f.path)!;
    f.memory.validate(doc.id, doc.digest);
    const child = f.memory.add(f.input(`Derived ${token}`)); f.memory.validate(child, child);
    assert.equal(f.memory.search(token).length, 2);
    f.memory.remove(doc.id, doc.digest); assert.deepEqual(f.memory.search(token), []); assert.equal(f.memory.inspect(child), undefined);
    f.memory.ingest(); f.memory.rebuildIndex(); f.reopen(); assert.deepEqual(f.memory.search(token), []);
    assert.throws(() => f.memory.add(f.input(`New derivative ${token}`)));
    const raw = new DatabaseSync(databasePath(f.directory, f.root, f.projectId));
    assert.equal(raw.prepare('SELECT count(*) AS n FROM records WHERE id IN (?, ?) AND body IS NULL').get(doc.id, child)?.n, 2);
    assert.equal(raw.prepare('SELECT count(*) AS n FROM memory_fts').get()?.n, 0); raw.close();
    assert.equal(readFileSync(databasePath(f.directory, f.root, f.projectId)).includes(Buffer.from(token)), false);
  } finally { f.dispose(); }
});

test('expiry purges content at access and prevents reuse after restart', () => {
  const f = fixture(); try {
    const id = f.memory.add({ ...f.input(), expiresAt: 1100 }); f.memory.validate(id, id);
    assert.equal(f.memory.search('SQLite').length, 1); f.setNow(1100);
    assert.deepEqual(f.memory.search('SQLite'), []); assert.equal(f.memory.inspect(id), undefined);
    f.reopen(); assert.equal(f.memory.get(id), undefined); assert.ok(f.memory.audit().some(row => row.action === 'expired'));
    assert.throws(() => f.memory.add({ ...f.input(), expiresAt: 1099 }));
  } finally { f.dispose(); }
});

test('source removal also redacts superseded historical derivatives', () => {
  const f = fixture(); try {
    const old = f.memory.add(f.input('historicaluniquederivative')); f.memory.validate(old, old);
    const next = f.memory.add({ ...f.input('new replacement decision'), supersedes: old }); f.memory.validate(next, next);
    rmSync(join(f.root, f.path)); f.memory.ingest();
    const raw = new DatabaseSync(databasePath(f.directory, f.root, f.projectId));
    assert.equal(raw.prepare('SELECT count(*) AS n FROM records WHERE id IN (?, ?) AND body IS NULL').get(old, next)?.n, 2); raw.close();
    assert.equal(readFileSync(databasePath(f.directory, f.root, f.projectId)).includes(Buffer.from('historicaluniquederivative')), false);
  } finally { f.dispose(); }
});

test('literal keyword search is deterministic, bounded and rebuildable', () => {
  const f = fixture(); try {
    for (let i = 0; i < 14; i++) { const id = f.memory.add({ ...f.input(`SQLite ${'文'.repeat(2000)} ${i}`), title: `Storage ${i}` }); f.memory.validate(id, id); }
    const packet = f.memory.packet('SQLite'); assert.ok(packet.entries.length > 0 && packet.entries.length <= 10);
    assert.ok(Buffer.byteLength(JSON.stringify(packet)) < 32768);
    f.memory.rebuildIndex(); assert.deepEqual(f.memory.packet('SQLite'), packet); f.memory.assertCurrent(packet);
    assert.deepEqual(f.memory.search('" OR impossibleword --'), []);
    assert.deepEqual(f.memory.search('***'), []); assert.throws(() => f.memory.search('SQLite', 100));
    f.memory.remove(packet.entries[0]!.id, packet.entries[0]!.digest);
    assert.throws(() => f.memory.assertCurrent(packet));
  } finally { f.dispose(); }
});

test('ingestion failures leave existing state intact and busy writes fail without partial candidates', () => {
  const f = fixture(); try {
    f.memory.ingest(); const before = f.memory.list();
    writeFileSync(join(f.root, 'docs/adr/oversize.md'), 'x'.repeat(262145)); assert.throws(() => f.memory.ingest());
    rmSync(join(f.root, 'docs/adr/oversize.md')); assert.deepEqual(f.memory.list(), before);
    const connection = new DatabaseSync(databasePath(f.directory, f.root, f.projectId)); connection.exec('BEGIN IMMEDIATE');
    try { assert.throws(() => f.memory.add(f.input()), /locked/); } finally { connection.exec('ROLLBACK'); connection.close(); }
    assert.deepEqual(f.memory.list(), before);
    const id = f.memory.add(f.input()); assert.ok(f.memory.inspect(id));
  } finally { f.dispose(); }
});

test('future schema versions fail closed', () => {
  const f = fixture(); try {
    f.memory.close(); const raw = new DatabaseSync(databasePath(f.directory, f.root, f.projectId)); raw.exec('PRAGMA user_version = 999'); raw.close();
    assert.throws(() => f.reopen(), /unsupported memory schema/);
  } finally { f.dispose(); }
});
