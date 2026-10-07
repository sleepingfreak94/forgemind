import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, linkSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fixture } from './fixture.js';
import { ProjectMemory } from '../../src/memory/service.js';
import { databasePath } from '../../src/memory/database.js';

test('sources reject traversal, terminal controls, accessors and malformed records', () => {
  const f = fixture(); try {
    const input = f.input(); let called = false;
    const accessor = { ...input, get title() { called = true; return 'malicious'; } };
    assert.throws(() => f.memory.add(accessor)); assert.equal(called, false);
    assert.throws(() => f.memory.add({ ...input, title: '\x1b[2J' }));
    assert.throws(() => f.memory.add({ ...input, sources: [{ ...input.sources[0]!, path: '../outside.md' }] }));
    assert.throws(() => f.memory.add({ ...input, sources: [] }));
    assert.throws(() => f.memory.add({ ...input, kind: 'document' }));
    assert.throws(() => f.memory.add({ ...input, expiresAt: NaN }));
    assert.throws(() => f.memory.add({ ...input, sources: [input.sources[0]!, input.sources[0]!] }));
    assert.throws(() => f.memory.validate("' OR 1=1", 'a'.repeat(64)));
    assert.equal(f.memory.list().length, 0);
    writeFileSync(join(f.root, f.path), '# Title\nStatus: Accepted\nUnsafe \x1b[2J terminal input');
    f.memory.ingest(); const record = f.memory.list().find(item => item.sources[0]!.path === f.path)!;
    assert.equal(f.memory.inspect(record.id)!.text.includes('\x1b'), false);
  } finally { f.dispose(); }
});

test('database cannot live inside the project or use nonprivate POSIX permissions', () => {
  const f = fixture(); try {
    assert.throws(() => new ProjectMemory(join(f.root, 'memory'), f.root), /outside/);
    if (typeof process.getuid === 'function') {
      chmodSync(f.directory, 0o755); assert.throws(() => new ProjectMemory(f.directory, f.root), /private/); chmodSync(f.directory, 0o700);
      const path = databasePath(f.directory, f.root, f.projectId); chmodSync(path, 0o644);
      assert.throws(() => new ProjectMemory(f.directory, f.root), /private/); chmodSync(path, 0o600);
    }
  } finally { f.dispose(); }
});

test('linked documents, directory aliases, database links and sidecars fail closed', { skip: process.platform === 'win32' ? 'Windows symlink privileges are environment-dependent' : false }, () => {
  const f = fixture(); try {
    const target = join(f.root, f.path), old = join(f.base, 'outside.md'); renameSync(target, old); symlinkSync(old, target);
    assert.throws(() => f.memory.ingest(), /unsafe|linked/); rmSync(target); linkSync(old, target);
    assert.throws(() => f.memory.ingest(), /invalid document/); rmSync(target); renameSync(old, target);
    const alias = join(f.base, 'alias'); symlinkSync(f.root, alias); assert.throws(() => new ProjectMemory(f.directory, alias));
    f.memory.close(); const path = databasePath(f.directory, f.root, f.projectId), backup = join(f.base, 'database');
    renameSync(path, backup); symlinkSync(backup, path); assert.throws(() => f.reopen(), /unsafe/);
    rmSync(path); renameSync(backup, path); symlinkSync(target, path + '-journal'); assert.throws(() => f.reopen(), /unsafe/); rmSync(path + '-journal');
    f.reopen(); assert.equal(f.memory.ingest().documents, 4);
  } finally { f.dispose(); }
});

test('scanner rejects special files before reading and bounds all-directory traversal', () => {
  const f = fixture(); try {
    if (process.platform !== 'win32') {
      const path = join(f.root, 'docs/adr/pipe.md');
      const result = spawnSync('mkfifo', [path], { timeout: 1000 }); assert.equal(result.status, 0);
      assert.throws(() => f.memory.ingest(), /invalid document/); rmSync(path);
    }
    for (let i = 0; i < 4; i++) {
      const parent = join(f.root, 'docs/adr', `tree-${i}`); mkdirSync(parent);
      for (let j = 0; j < 300; j++) mkdirSync(join(parent, `empty-${j}`));
    }
    assert.throws(() => f.memory.ingest(), /traversal budget/);
  } finally { f.dispose(); }
});
