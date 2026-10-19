import test, { mock } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, chownSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createOwnerArtifactAttempt, inspectOwnerArtifactAttempt, readOwnerArtifactBundle } from '../../src/live-workflow/owner-artifact-io.js';
import { ownerArtifactDefaults, OwnerArtifactError, encodeOwnerJson, safeArtifactError } from '../../src/live-workflow/owner-artifact-contracts.js';
import type { OwnerArtifactOptions, OwnerArtifactLimits, OwnerArtifactFaultPoint, OwnerArtifactCode, OwnerJson } from '../../src/live-workflow/owner-artifact-contracts.js';

// Pure filesystem suite. Positive coverage belongs to the native macOS runner;
// neither Windows nor Linux is represented as providing equivalent guarantees.
const native = process.platform === 'darwin' && typeof process.getuid === 'function';
const nativeTest = (name: string, body: () => void): void => { test(name, { skip: !native }, body); };
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
function fixture(limits?: OwnerArtifactLimits, fault?: (point: OwnerArtifactFaultPoint) => void) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'owner-artifact-')));
  const root = join(base, 'capture'), project = join(base, 'project');
  mkdirSync(root, { mode: 0o700 }); mkdirSync(project, { mode: 0o700 });
  const options: OwnerArtifactOptions = { root, project,
    scope: { taskId: 'task', sourceSha256: 'a'.repeat(64), requestSha256: 'b'.repeat(64) },
    ...(limits ? { limits } : {}), ...(fault ? { fault } : {}) };
  return { base, root, project, options, directory: (id = 'one') => join(root, id),
    file: (name: string, id = 'one') => join(root, id, name),
    close: () => rmSync(base, { recursive: true, force: true }) };
}
function rejects(operation: () => unknown, code?: string): void {
  assert.throws(operation, error => {
    assert.ok(error instanceof OwnerArtifactError);
    assert.match(error.message, /^OWNER_ARTIFACT_[A-Z]+$/);
    if (code) assert.equal(error.code, code);
    return true;
  });
}
function tiny(changes: Partial<OwnerArtifactLimits> = {}): OwnerArtifactLimits {
  return { artifactBytes: 128, bundleBytes: 16384, files: 12, metadataBytes: 2048,
    progressEvents: 4, progressBytes: 1024, archiveAttempts: 3, archiveBytes: 49152, ...changes };
}

nativeTest('durable JSON preserves producer order, exact UTF-8 and hashes; recovery needs no writer', () => {
  const f = fixture();
  try {
    const writer = createOwnerArtifactAttempt(f.options, 'one');
    assert.equal(inspectOwnerArtifactAttempt(f.options, 'one').state, 'incomplete');
    const body = { z: 'évidence', a: [null, true, 1, { second: 2, first: 1 }] };
    const ref = writer.writeJson('result.json', body);
    const expected = Buffer.from(JSON.stringify(body));
    assert.deepEqual(readFileSync(f.file('result.json')), expected);
    assert.equal(ref.sha256, sha(expected)); assert.equal(ref.bytes, expected.length);
    writer.progress({ stage: 'persist', status: 'running', completed: 1, total: 1 });
    const accepted = writer.accept();
    assert.equal(accepted.trust, 'evidence-only');
    assert.equal(inspectOwnerArtifactAttempt(f.options, 'one').state, 'accepted');
    const recovered = readOwnerArtifactBundle(f.options, 'one');
    assert.deepEqual(recovered.manifest, accepted);
    assert.deepEqual(recovered.files.get('result.json'), expected);
    assert.equal(lstatSync(f.directory()).mode & 0o7777, 0o700);
    for (const name of [...recovered.files.keys(), 'accepted.json']) {
      const stat = lstatSync(f.file(name));
      assert.equal(stat.mode & 0o7777, 0o600); assert.equal(stat.uid, process.getuid!()); assert.equal(stat.nlink, 1);
    }
    rejects(() => writer.accept(), 'STATE');
    rejects(() => writer.writeJson('later.json', {}), 'STATE');
    assert.deepEqual(readOwnerArtifactBundle(f.options, 'one').manifest, accepted);
  } finally { f.close(); }
});

nativeTest('metadata-only ancestors allow content updates but ancestry and pinned target replacements fail closed', () => {
  for (const mode of ['content', 'ancestor', 'target']) {
    let mutate: (() => void) | undefined;
    const f = fixture(undefined, point => {
      if (point.operation === (mode === 'target' ? 'directory-sync' : 'file-sync') && mutate) {
        const operation = mutate; mutate = undefined; operation();
      }
    });
    const parked = f.base + '-moved';
    try {
      const writer = createOwnerArtifactAttempt(f.options, 'one');
      const ancestor = lstatSync(f.base), target = lstatSync(f.directory());
      mutate = () => {
        if (mode === 'content') mkdirSync(join(f.base, 'sibling'), { mode: 0o700 });
        if (mode === 'ancestor') {
          renameSync(f.base, parked); mkdirSync(f.base, { mode: 0o700 });
          renameSync(join(parked, 'capture'), f.root);
          renameSync(join(parked, 'project'), f.project);
        }
        if (mode === 'target') {
          renameSync(f.directory(), f.directory('held'));
          mkdirSync(f.directory(), { mode: 0o700 });
        }
      };
      if (mode === 'content') {
        writer.writeJson('body.json', { value: 1 }); writer.accept();
        assert.equal(existsSync(join(f.base, 'sibling')), true);
        assert.equal(readOwnerArtifactBundle(f.options, 'one').files.get('body.json')?.toString(), '{"value":1}');
      } else {
        rejects(() => writer.writeJson('body.json', { value: 1 }));
        rejects(() => writer.accept());
        assert.equal(existsSync(f.file('accepted.json')), false);
        if (mode === 'ancestor') {
          assert.notEqual(lstatSync(f.base).ino, ancestor.ino);
          assert.equal(lstatSync(f.directory()).ino, target.ino);
          assert.equal(readFileSync(f.file('body.json'), 'utf8'), '{"value":1}');
        } else {
          assert.notEqual(lstatSync(f.directory()).ino, target.ino);
          assert.equal(lstatSync(f.directory('held')).ino, target.ino);
        }
      }
      assert.equal(mutate, undefined);
    } finally { f.close(); rmSync(parked, { recursive: true, force: true }); }
  }
});

nativeTest('accepted bundle rejects manifest/body tampering, missing and extra files', () => {
  for (const change of ['manifest', 'body', 'missing', 'extra', 'scope']) {
    const f = fixture();
    try {
      const writer = createOwnerArtifactAttempt(f.options, 'one');
      writer.writeJson('result.json', { answer: 'original' }); writer.accept();
      if (change === 'manifest') writeFileSync(f.file('accepted.json'), '{"version":1}', { mode: 0o600 });
      if (change === 'body') writeFileSync(f.file('result.json'), '{"answer":"tampered"}', { mode: 0o600 });
      if (change === 'missing') unlinkSync(f.file('result.json'));
      if (change === 'extra') writeFileSync(f.file('extra.json'), '{}', { mode: 0o600 });
      const options = change === 'scope' ? { ...f.options, scope: { ...f.options.scope, sourceSha256: 'c'.repeat(64) } } : f.options;
      rejects(() => readOwnerArtifactBundle(options, 'one'));
      rejects(() => inspectOwnerArtifactAttempt(options, 'one'));
    } finally { f.close(); }
  }
});

nativeTest('canonical external roots, safe ancestors and finite names are mandatory', () => {
  for (const change of ['inside', 'equal', 'ancestor', 'relative', 'dot', 'symlink-root', 'unsafe-ancestor', 'unsafe-root']) {
    const f = fixture();
    try {
      let root = f.root;
      if (change === 'inside') { root = join(f.project, 'capture'); mkdirSync(root, { mode: 0o700 }); }
      if (change === 'equal') root = f.project;
      if (change === 'ancestor') root = f.base;
      if (change === 'relative') root = 'capture';
      if (change === 'dot') root = f.root + '/.';
      if (change === 'symlink-root') { root = join(f.base, 'alias'); symlinkSync(f.root, root); }
      if (change === 'unsafe-ancestor') chmodSync(f.base, 0o777);
      if (change === 'unsafe-root') chmodSync(f.root, 0o750);
      rejects(() => createOwnerArtifactAttempt({ ...f.options, root }, 'one'));
    } finally { chmodSync(f.base, 0o700); f.close(); }
  }
  for (const name of ['../escape.json', 'a/b.json', '..', 'a\\b.json', 'nul\0.json', 'accepted.json', 'progress-000.json', 'A.json', 'a'.repeat(80) + '.json']) {
    const f = fixture();
    try {
      const writer = createOwnerArtifactAttempt(f.options, 'one');
      rejects(() => writer.writeJson(name, {}), 'PATH');
      rejects(() => writer.accept(), 'STATE');
    } finally { f.close(); }
  }
  for (const id of ['..', '../one', '', '.admission', 'a/b', 'a'.repeat(65)]) {
    const f = fixture();
    try { rejects(() => createOwnerArtifactAttempt(f.options, id), 'PATH'); }
    finally { f.close(); }
  }
});

nativeTest('symlinks, hard links, file modes, directory modes and changed identity fail closed', () => {
  for (const change of ['symlink', 'hardlink', 'mode', 'directory', 'ancestor-link', 'uid']) {
    const f = fixture();
    try {
      const writer = createOwnerArtifactAttempt(f.options, 'one');
      writer.writeJson('body.json', { value: 1 }); writer.accept();
      if (change === 'symlink') {
        const other = join(f.base, 'other'); writeFileSync(other, '{}', { mode: 0o600 });
        unlinkSync(f.file('body.json')); symlinkSync(other, f.file('body.json'));
      }
      if (change === 'hardlink') linkSync(f.file('body.json'), join(f.base, 'other'));
      if (change === 'mode') chmodSync(f.file('body.json'), 0o640);
      if (change === 'directory') chmodSync(f.directory(), 0o750);
      if (change === 'ancestor-link') {
        // A replaced project is still forbidden, even if a symlink resolves to it.
        const other = join(f.base, 'other'); mkdirSync(other, { mode: 0o700 });
        rmSync(f.project, { recursive: true }); symlinkSync(other, f.project);
      }
      if (change === 'uid') {
        const descriptor = Object.getOwnPropertyDescriptor(process, 'getuid')!;
        Object.defineProperty(process, 'getuid', { ...descriptor, value: () => descriptor.value() + 1 });
        try { rejects(() => readOwnerArtifactBundle(f.options, 'one')); }
        finally { Object.defineProperty(process, 'getuid', descriptor); }
      } else rejects(() => readOwnerArtifactBundle(f.options, 'one'));
    } finally { f.close(); }
  }
});

nativeTest('exclusive attempts and immutable names retain collisions without overwrite', () => {
  for (const collision of ['attempt', 'name', 'acceptance', 'lock']) {
    const f = fixture();
    try {
      if (collision === 'lock') {
        writeFileSync(join(f.root, '.admission'), '', { mode: 0o600 });
        rejects(() => createOwnerArtifactAttempt(f.options, 'one'));
        assert.equal(existsSync(f.directory()), false); continue;
      }
      const writer = createOwnerArtifactAttempt(f.options, 'one');
      writer.writeJson('body.json', { first: 1 });
      if (collision === 'attempt') rejects(() => createOwnerArtifactAttempt(f.options, 'one'));
      if (collision === 'name') rejects(() => writer.writeJson('body.json', { second: 2 }));
      if (collision === 'acceptance') {
        writeFileSync(f.file('accepted.json'), '{"existing":true}', { mode: 0o600 });
        rejects(() => writer.accept());
        assert.equal(readFileSync(f.file('accepted.json'), 'utf8'), '{"existing":true}');
      }
      assert.equal(readFileSync(f.file('body.json'), 'utf8'), '{"first":1}');
      rejects(() => readOwnerArtifactBundle(f.options, 'one'));
    } finally { f.close(); }
  }
});

nativeTest('partial write, file/directory fsync and manifest publication faults cannot accept', () => {
  for (const mode of ['partial', 'file-sync', 'directory-sync', 'manifest-write', 'publish', 'published', 'final-directory-sync']) {
    let armed = false, writes = 0;
    const f = fixture(undefined, point => {
      if (!armed) return;
      const trigger = mode === 'partial' ? point.name === 'body.json' && point.operation === 'write' && ++writes === 2
        : mode === 'manifest-write' ? point.name === 'accept-temp.json' && point.operation === 'write'
          : point.operation === mode;
      if (trigger) throw Object.create(null); // Must never be stringified or inspected.
    });
    try {
      const writer = createOwnerArtifactAttempt(f.options, 'one');
      const writing = ['partial', 'file-sync', 'directory-sync'].includes(mode);
      if (writing) {
        armed = true;
        rejects(() => writer.writeJson('body.json', { text: 'x'.repeat(9000) }), 'IO');
      } else {
        writer.writeJson('body.json', { value: 1 }); armed = true;
        rejects(() => writer.accept(), 'IO');
      }
      armed = false;
      rejects(() => writer.accept(), 'STATE');
      rejects(() => readOwnerArtifactBundle(f.options, 'one'));
      // A two-link partially published manifest is itself unsafe and rejects inspection.
      if (mode === 'published' || mode === 'final-directory-sync') rejects(() => inspectOwnerArtifactAttempt(f.options, 'one'));
      else assert.equal(inspectOwnerArtifactAttempt(f.options, 'one').state, 'incomplete');
      if (mode === 'partial') assert.equal(lstatSync(f.file('body.json')).size, 4096);
    } finally { f.close(); }
  }
});

nativeTest('hostile JSON never invokes getters, toJSON or caught-error coercions', () => {
  let calls = 0;
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  const accessor = Object.defineProperty({}, 'secret', { enumerable: true, get() { calls++; throw new Error('SECRET'); } });
  const hook = { toJSON() { calls++; return 'SECRET'; } };
  const hostileError = Object.defineProperty({}, 'message', { get() { calls++; return 'SECRET'; } });
  const proxy = new Proxy({}, { ownKeys() { throw hostileError; } });
  const bodies: unknown[] = [accessor, hook, cycle, proxy, { value: undefined }, { value: 1n }, { value: NaN },
    { [Symbol('secret')]: 1 }, new Date(), [undefined], Object.assign([1], { extra: 2 })];
  for (const body of bodies) {
    const f = fixture();
    try {
      const writer = createOwnerArtifactAttempt(f.options, 'one');
      rejects(() => writer.writeJson('body.json', body as OwnerJson), 'JSON');
      assert.equal(existsSync(f.file('body.json')), false);
      rejects(() => writer.accept(), 'STATE');
      assert.equal(inspectOwnerArtifactAttempt(f.options, 'one').state, 'incomplete');
    } finally { f.close(); }
  }
  assert.equal(calls, 0);
});

nativeTest('artifact, bundle, file, archive and profile reservations are independently bounded', () => {
  for (const mode of ['artifact', 'bundle', 'files', 'archive-count', 'archive-bytes', 'profile']) {
    const limits = tiny(mode === 'bundle' ? { artifactBytes: 10000, bundleBytes: 7000 }
      : mode === 'files' ? { files: 9 } : mode === 'archive-count' ? { archiveAttempts: 1 }
        : mode === 'archive-bytes' ? { archiveBytes: 16384 } : {});
    const f = fixture(limits);
    try {
      const writer = createOwnerArtifactAttempt(f.options, 'one');
      if (mode === 'artifact') rejects(() => writer.writeJson('large.json', 'x'.repeat(129)), 'LIMIT');
      if (mode === 'bundle') rejects(() => writer.writeJson('large.json', 'x'.repeat(3000)), 'LIMIT');
      if (mode === 'files') {
        writer.writeJson('a.json', {});
        rejects(() => writer.writeJson('b.json', {}), 'LIMIT');
      }
      if (mode.startsWith('archive')) rejects(() => createOwnerArtifactAttempt(f.options, 'two'), 'LIMIT');
      if (mode === 'profile') rejects(() => createOwnerArtifactAttempt({ ...f.options, limits: tiny({ bundleBytes: 15000 }) }, 'two'), 'LIMIT');
      rejects(() => readOwnerArtifactBundle(f.options, 'one'));
    } finally { f.close(); }
  }
});

nativeTest('progress reserves terminal capacity, rejects arbitrary text and never claims completion', () => {
  for (const mode of ['count', 'bytes', 'text', 'terminal', 'explicit']) {
    const f = fixture(tiny(mode === 'bytes' ? { progressBytes: 300 } : {}));
    try {
      const writer = createOwnerArtifactAttempt(f.options, 'one');
      writer.writeJson('body.json', {});
      const running = { stage: 'execute', status: 'running', completed: 0, total: 1 } as const;
      if (mode === 'count') {
        for (let i = 0; i < 3; i++) writer.progress(running);
        rejects(() => writer.progress(running), 'LIMIT');
      }
      if (mode === 'bytes') rejects(() => writer.progress(running), 'LIMIT');
      if (mode === 'text') rejects(() => writer.progress({ ...running, text: 'SECRET' } as unknown as Parameters<typeof writer.progress>[0]), 'JSON');
      if (mode === 'terminal') {
        for (let i = 0; i < 3; i++) writer.progress(running);
        writer.progress({ ...running, status: 'incomplete' });
        assert.equal(existsSync(f.file('progress-003.json')), true);
      }
      if (mode === 'explicit') writer.incomplete();
      rejects(() => writer.accept(), 'STATE');
      rejects(() => readOwnerArtifactBundle(f.options, 'one'));
      assert.equal(inspectOwnerArtifactAttempt(f.options, 'one').state, 'incomplete');
    } finally { f.close(); }
  }
});

function watchFs(commit: string, rejectUnlink = false, denyRecovery = false) {
  const events: string[] = [], handles: { mock: { restore(): void } }[] = [];
  const marker = join(dirname(commit), 'failure.json');
  for (const name of ['openSync', 'closeSync', 'fstatSync', 'lstatSync', 'realpathSync', 'mkdirSync',
    'writeSync', 'readSync', 'fsyncSync', 'opendirSync', 'linkSync', 'unlinkSync'] as const) {
    const original = fs[name];
    handles.push(mock.method(fs, name, (...args: unknown[]) => {
      events.push(name);
      if (denyRecovery && ((name === 'linkSync' && args[1] === commit) ||
          (name === 'openSync' && args[0] === marker))) throw new Error('blocked recovery');
      if (rejectUnlink && name === 'unlinkSync' && args[0] === commit) throw new Error('unlink unchanged');
      return Reflect.apply(original, fs, args);
    }));
  }
  syncBuiltinESMExports();
  return { events, restore() { for (const handle of handles) handle.mock.restore(); syncBuiltinESMExports(); } };
}

test('[B005] transparent, stateful, nested and revoked proxies reject without traps', () => {
  let traps = 0;
  const transparent = new Proxy({}, { getPrototypeOf() { traps++; return Object.prototype; }, ownKeys() { traps++; return []; } });
  let stateful: object;
  stateful = new Proxy({}, { getPrototypeOf() { return ++traps === 1 ? Object.prototype : stateful; } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const value of [new Proxy({}, {}), transparent, stateful, revoked.proxy,
    { nested: transparent }, [stateful], { nested: revoked.proxy }]) {
    rejects(() => encodeOwnerJson(value, 1024), 'JSON');
  }
  assert.equal(traps, 0);
});

test('[B007] private error codes normalize freshly without public properties or coercion', () => {
  let calls = 0;
  for (const accessors of [false, true]) {
    const error = new OwnerArtifactError('LIMIT');
    const hostile = () => { calls++; throw new Error('PRIVATE'); };
    Object.defineProperties(error, {
      message: accessors ? { get: hostile } : { value: 'PRIVATE' },
      code: accessors ? { get: hostile } : { value: 'PRIVATE' },
    });
    Object.setPrototypeOf(error, null);
    const normalized = safeArtifactError(error, 'JSON');
    assert.notEqual(normalized, error); assert.equal(normalized.code, 'LIMIT');
    assert.equal(normalized.message, 'OWNER_ARTIFACT_LIMIT');
  }
  const invalid = { toString() { calls++; return 'PRIVATE'; } } as unknown as OwnerArtifactCode;
  for (const code of [invalid, 'NOT_A_CODE' as OwnerArtifactCode]) {
    assert.equal(new OwnerArtifactError(code).message, 'OWNER_ARTIFACT_IO');
    assert.equal(safeArtifactError(Object.create(null), code).message, 'OWNER_ARTIFACT_IO');
  }
  assert.equal(new OwnerArtifactError('PRIVATE').message, 'OWNER_ARTIFACT_PRIVATE');
  assert.equal(safeArtifactError(Object.create(null), 'PRIVATE').message, 'OWNER_ARTIFACT_PRIVATE');
  assert.equal(calls, 0);
});

nativeTest('[B008] full nonprogress capacity retains reserved running and incomplete events', () => {
  const limits = tiny({ artifactBytes: 10000, bundleBytes: 12000 }), f = fixture(limits);
  try {
    const writer = createOwnerArtifactAttempt(f.options, 'one'), descriptor = readFileSync(f.file('attempt.json'));
    const capacity = limits.bundleBytes - descriptor.length - 2 * limits.metadataBytes - 1024 - limits.progressBytes;
    assert.equal(writer.writeJson('body.json', 'x'.repeat(capacity - 2)).bytes, capacity);
    const running = { stage: 'persist', status: 'running', completed: 0, total: 1 } as const;
    const terminal = { ...running, status: 'incomplete' } as const;
    writer.progress(running); writer.progress(terminal);
    assert.equal(readFileSync(f.file('body.json')).length, capacity);
    let retained = descriptor.length + capacity;
    for (const [index, event] of [running, terminal].entries()) {
      const bytes = readFileSync(f.file(`progress-00${index}.json`));
      assert.equal(bytes.toString(), JSON.stringify(event)); retained += bytes.length;
    }
    retained += readFileSync(f.file('failure.json')).length;
    assert.ok(retained <= limits.bundleBytes);
    rejects(() => writer.accept(), 'STATE'); rejects(() => readOwnerArtifactBundle(f.options, 'one'));
    assert.equal(inspectOwnerArtifactAttempt(f.options, 'one').state, 'incomplete');
  } finally { f.close(); }
});

nativeTest('[B006] original publication guard survives sync/unlink failure and commits without a fallible tail', () => {
  for (const mode of ['sync', 'unlink', 'success']) {
    let trace: ReturnType<typeof watchFs> | undefined;
    const f = fixture(undefined, point => {
      trace?.events.push(point.operation);
      if (point.operation === 'final-directory-sync' && point.name === f.directory()) {
        assert.equal(lstatSync(f.file('accept-temp.json')).nlink, 2);
        if (mode === 'sync') throw new Error('sync failed');
      }
    });
    try {
      const writer = createOwnerArtifactAttempt(f.options, 'one'); writer.writeJson('body.json', {});
      trace = watchFs(f.file('accept-temp.json'), mode === 'unlink', mode === 'sync');
      let accepted;
      try { if (mode === 'success') accepted = writer.accept(); else rejects(() => writer.accept(), 'IO'); }
      finally { trace.restore(); }
      if (mode === 'success') {
        assert.equal(trace.events.at(-1), 'unlinkSync');
        assert.deepEqual(readOwnerArtifactBundle(f.options, 'one').manifest, accepted);
        // Simulation only: a crash-resurrected guard conservatively vetoes recovery.
        linkSync(f.file('accepted.json'), f.file('accept-temp.json'));
      }
      assert.equal(lstatSync(f.file('accept-temp.json')).nlink, 2);
      assert.equal(lstatSync(f.file('accepted.json')).ino, lstatSync(f.file('accept-temp.json')).ino);
      if (mode === 'sync') assert.equal(existsSync(f.file('failure.json')), false);
      rejects(() => readOwnerArtifactBundle(f.options, 'one')); rejects(() => inspectOwnerArtifactAttempt(f.options, 'one'));
      rejects(() => writer.accept(), 'STATE');
    } finally { f.close(); }
  }
  for (const bad of ['extra', 'pair', 'bytes', 'mode', 'third-link']) {
    const f = fixture(undefined, point => {
      if (point.operation !== 'published') return;
      if (bad === 'extra') writeFileSync(f.file('extra.json'), '{}', { mode: 0o600 });
      if (bad === 'pair') { const bytes = readFileSync(f.file('accept-temp.json')); unlinkSync(f.file('accept-temp.json')); writeFileSync(f.file('accept-temp.json'), bytes, { mode: 0o600 }); }
      if (bad === 'bytes') writeFileSync(f.file('accepted.json'), readFileSync(f.file('accepted.json'), 'utf8') + '\n');
      if (bad === 'mode') chmodSync(f.file('accepted.json'), 0o640);
      if (bad === 'third-link') linkSync(f.file('accepted.json'), join(f.base, 'third'));
    });
    try {
      const writer = createOwnerArtifactAttempt(f.options, 'one'); writer.writeJson('body.json', {});
      rejects(() => writer.accept()); rejects(() => readOwnerArtifactBundle(f.options, 'one'));
      try { assert.equal(inspectOwnerArtifactAttempt(f.options, 'one').state, 'incomplete'); }
      catch (error) { assert.ok(error instanceof OwnerArtifactError); }
    } finally { f.close(); }
  }
});

nativeTest('[B009] admission retains its lock through sync, writer preparation, closes and final unlink', () => {
  for (const mode of ['sync', 'prepare', 'unlink', 'success', 'charged']) {
    let trace: ReturnType<typeof watchFs> | undefined;
    const f = fixture(tiny({ archiveAttempts: 1 }), point => {
      trace?.events.push(point.operation);
      if ((point.operation === 'final-directory-sync' && point.name === f.root) || point.operation === 'writer-prepare') {
        assert.equal(existsSync(join(f.root, '.admission')), true);
        assert.equal(existsSync(f.file('attempt.json')), true);
        if ((mode === 'sync' && point.operation === 'final-directory-sync') ||
            (mode === 'prepare' && point.operation === 'writer-prepare')) throw new Error('preunlock failure');
      }
    });
    try {
      trace = watchFs(join(f.root, '.admission'), mode === 'unlink');
      const success = mode === 'success' || mode === 'charged';
      let writer;
      try { if (success) writer = createOwnerArtifactAttempt(f.options, 'one'); else rejects(() => createOwnerArtifactAttempt(f.options, 'one'), 'IO'); }
      finally { trace.restore(); }
      assert.equal(existsSync(f.file('attempt.json')), true);
      if (success) {
        assert.ok(writer); assert.equal(trace.events.at(-1), 'unlinkSync');
        assert.equal(inspectOwnerArtifactAttempt(f.options, 'one').state, 'incomplete');
        if (mode === 'charged') rejects(() => createOwnerArtifactAttempt(f.options, 'two'), 'LIMIT');
        // Simulation only: a resurrected lock blocks automatic admission.
        else writeFileSync(join(f.root, '.admission'), '', { mode: 0o600 });
      }
      assert.equal(existsSync(join(f.root, '.admission')), true);
      rejects(() => createOwnerArtifactAttempt(f.options, 'two'));
      assert.equal(existsSync(f.directory('two')), false);
    } finally { f.close(); }
  }
});

test('unsupported host or missing uid identity rejects before storage effects', () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'getuid');
  try {
    Object.defineProperty(process, 'getuid', { configurable: true, value: undefined });
    rejects(() => createOwnerArtifactAttempt({ root: '/unopened', project: '/unopened-project',
      scope: { taskId: 'task', sourceSha256: 'a'.repeat(64), requestSha256: 'b'.repeat(64) } }, 'one'), 'IDENTITY');
  } finally {
    if (descriptor) Object.defineProperty(process, 'getuid', descriptor);
    else Reflect.deleteProperty(process, 'getuid');
  }
  if (!native) rejects(() => createOwnerArtifactAttempt({ root: '/unopened', project: '/unopened-project',
    scope: { taskId: 'task', sourceSha256: 'a'.repeat(64), requestSha256: 'b'.repeat(64) } }, 'one'), 'IDENTITY');
});
