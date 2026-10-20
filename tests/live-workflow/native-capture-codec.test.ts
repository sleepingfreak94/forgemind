import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeNativeCapture, writeNativeCapture } from '../../src/live-workflow/native-capture-codec.js';
import { captureJson, NativeCaptureError } from '../../src/live-workflow/native-run-capture.js';
import { createOwnerArtifactAttempt, inspectOwnerArtifactAttempt, readOwnerArtifactBundle } from '../../src/live-workflow/owner-artifact-io.js';
import { encodeOwnerJson, ownerArtifactDefaults, OwnerArtifactError } from '../../src/live-workflow/owner-artifact-contracts.js';
import type { OwnerArtifactBundle, OwnerArtifactOptions, OwnerArtifactFaultPoint, OwnerJson } from '../../src/live-workflow/owner-artifact-contracts.js';

const native = { skip: process.platform !== 'darwin' };
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const large = () => ({ status: 'completed', checks: [{ stdout: 'é'.repeat(600000), stderr: '界'.repeat(400000) }], native: { result: 'selected' } });
function fixture(fault?: (point: OwnerArtifactFaultPoint) => void, bundleBytes = ownerArtifactDefaults.bundleBytes) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'native-capture-codec-')));
  const root = join(base, 'capture'), project = join(base, 'project');
  mkdirSync(root, { mode: 0o700 }); mkdirSync(project, { mode: 0o700 });
  const options: OwnerArtifactOptions = { root, project,
    scope: { taskId: 'capture', sourceSha256: 'a'.repeat(64), requestSha256: 'b'.repeat(64) },
    limits: { ...ownerArtifactDefaults, bundleBytes }, ...(fault ? { fault } : {}) };
  return { options, file: (name: string) => join(root, 'one', name),
    writer: () => createOwnerArtifactAttempt(options, 'one'),
    close: () => rmSync(base, { recursive: true, force: true }) };
}
function accepted(f: ReturnType<typeof fixture>, value: OwnerJson): OwnerArtifactBundle {
  const writer = f.writer();
  writer.writeJson('start.json', { schema: 'native-owner-capture-v1' });
  writer.progress({ stage: 'prepare', status: 'running', completed: 0, total: 1 });
  writeNativeCapture(writer, value); writer.accept();
  return readOwnerArtifactBundle(f.options, 'one');
}
function clone(bundle: OwnerArtifactBundle): OwnerArtifactBundle {
  return { manifest: structuredClone(bundle.manifest), files: new Map([...bundle.files].map(([name, body]) => [name, Buffer.from(body)])) };
}
// Rebind public structural references deliberately. These hashes are not auth;
// codec semantic checks must still reject inconsistent accepted evidence.
function replace(bundle: OwnerArtifactBundle, name: string, body: Buffer): void {
  (bundle.files as Map<string, Buffer>).set(name, body);
  const ref = bundle.manifest.files.find(ref => ref.name === name)!;
  ref.bytes = body.length; ref.sha256 = sha(body);
}

test('real writer accepts >2MiB selected check stdout/stderr and decoder returns original ordered UTF-8 bytes', native, () => {
  const f = fixture();
  try {
    const value = large(), expected = Buffer.from(JSON.stringify(value)), bundle = accepted(f, captureJson(value));
    assert(expected.length > ownerArtifactDefaults.artifactBytes);
    assert.equal(expected.length, 2400090);
    assert.deepEqual(decodeNativeCapture(bundle), expected);
    assert.deepEqual(JSON.parse(decodeNativeCapture(bundle).toString()), value);
    assert(!bundle.files.has('terminal.json'));
    const index = JSON.parse(bundle.files.get('terminal-index.json')!.toString());
    assert.equal(index.version, 1); assert.equal(index.bytes, expected.length); assert.equal(index.sha256, sha(expected));
    const stored = readFileSync(f.file('accepted.json')).length + [...bundle.files.values()].reduce((n, body) => n + body.length, 0);
    assert(stored <= ownerArtifactDefaults.bundleBytes);
    for (const ref of bundle.manifest.files) assert.equal(readFileSync(f.file(ref.name)).length, ref.bytes);
    for (const chunk of index.chunks) {
      assert.match(chunk.name, /^terminal-chunk-[0-9]{3}\.json$/);
      assert(chunk.storedBytes <= ownerArtifactDefaults.artifactBytes);
      assert.equal(chunk.storedSha256, sha(bundle.files.get(chunk.name)!));
      assert.equal(Buffer.from(JSON.parse(bundle.files.get(chunk.name)!.toString()), 'base64').length, chunk.bytes);
    }
    assert.equal(inspectOwnerArtifactAttempt(f.options, 'one').state, 'accepted');
  } finally { f.close(); }
});

test('legacy small and exact 2MiB terminal bytes remain unchanged; one byte over uses chunks', native, () => {
  for (const length of [12, ownerArtifactDefaults.artifactBytes - 11, ownerArtifactDefaults.artifactBytes - 10]) {
    const f = fixture();
    try {
      const value = { body: 'x'.repeat(length) }, expected = Buffer.from(JSON.stringify(value)), bundle = accepted(f, value);
      assert.deepEqual(decodeNativeCapture(bundle), expected);
      if (expected.length <= ownerArtifactDefaults.artifactBytes) {
        assert.deepEqual(bundle.files.get('terminal.json'), expected);
        assert(!bundle.files.has('terminal-index.json'));
      } else assert(bundle.files.has('terminal-index.json'));
    } finally { f.close(); }
  }
});

test('escaped strings, integer key order, astral characters and lone surrogates are lossless across chunks', native, () => {
  const f = fixture();
  try {
    const value = { z: '\u0000\n"\\\ud800🙂界'.repeat(180000), '10': 'ten', '2': 'two', a: { second: 2, first: 1 } };
    assert.deepEqual(decodeNativeCapture(accepted(f, value)), Buffer.from(JSON.stringify(value)));
  } finally { f.close(); }
});

test('actual stored base64 bytes overflow bundle although raw JSON fits; partial chunks cannot be accepted', native, () => {
  const f = fixture();
  try {
    const writer = f.writer(), value = { stdout: 'x'.repeat(13 * 1024 * 1024) };
    assert(Buffer.byteLength(JSON.stringify(value)) < ownerArtifactDefaults.bundleBytes);
    assert.throws(() => writeNativeCapture(writer, value), OwnerArtifactError);
    assert(existsSync(f.file('terminal-chunk-000.json')));
    assert(existsSync(f.file('failure.json')));
    assert(!existsSync(f.file('accepted.json')));
    assert.throws(() => writer.accept(), OwnerArtifactError);
    assert.throws(() => readOwnerArtifactBundle(f.options, 'one'), OwnerArtifactError);
    assert.equal(inspectOwnerArtifactAttempt(f.options, 'one').state, 'incomplete');
  } finally { f.close(); }
});

test('descriptor, index, progress and manifest reserves count even when encoded chunks themselves fit', native, () => {
  const value = large(), bytes = encodeOwnerJson(value, ownerArtifactDefaults.bundleBytes);
  const rawChunk = 3 * Math.floor((ownerArtifactDefaults.artifactBytes - 2) / 4);
  let chunkStored = 0;
  for (let offset = 0; offset < bytes.length; offset += rawChunk) chunkStored += encodeOwnerJson(bytes.subarray(offset, offset + rawChunk).toString('base64'), ownerArtifactDefaults.artifactBytes).length;
  const f = fixture(undefined, chunkStored);
  try {
    const writer = f.writer();
    writer.progress({ stage: 'prepare', status: 'running', completed: 0, total: 1 });
    assert.throws(() => writeNativeCapture(writer, value), OwnerArtifactError);
    assert(!existsSync(f.file('accepted.json'))); assert(existsSync(f.file('failure.json')));
    assert.throws(() => writer.accept(), OwnerArtifactError);
  } finally { f.close(); }
});

test('encoding limit and chunk-write/index-write/accept failures leave explicit incomplete veto', native, () => {
  for (const failure of ['encode', 'chunk', 'index', 'accept']) {
    let armed = false;
    const f = fixture(point => {
      if (!armed) return;
      if ((failure === 'chunk' && point.operation === 'write' && point.name === 'terminal-chunk-001.json') ||
          (failure === 'index' && point.operation === 'write' && point.name === 'terminal-index.json') ||
          (failure === 'accept' && point.operation === 'publish')) throw new Error('fixture-only fault');
    });
    try {
      const writer = f.writer(); armed = true;
      if (failure === 'accept') {
        writeNativeCapture(writer, large()); assert.throws(() => writer.accept(), OwnerArtifactError);
      } else assert.throws(() => writeNativeCapture(writer, failure === 'encode' ? { body: 'x'.repeat(ownerArtifactDefaults.bundleBytes) } : large()), OwnerArtifactError);
      assert(existsSync(f.file('failure.json')));
      assert.throws(() => readOwnerArtifactBundle(f.options, 'one'), OwnerArtifactError);
      assert.throws(() => writer.accept(), OwnerArtifactError);
    } finally { f.close(); }
  }
});

test('capture and encoder reject getters, proxies, revoked proxies and serialization hooks without executing traps', () => {
  let traps = 0;
  const getter = Object.defineProperty({}, 'body', { enumerable: true, get() { traps++; return 'SECRET'; } });
  const proxy = new Proxy({}, { ownKeys() { traps++; return []; }, getPrototypeOf() { traps++; return null; }, get() { traps++; return ''; } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const value of [getter, proxy, revoked.proxy, { toJSON() { traps++; return 'SECRET'; } }]) {
    assert.throws(() => captureJson(value), NativeCaptureError);
    assert.throws(() => encodeOwnerJson(value, ownerArtifactDefaults.bundleBytes), OwnerArtifactError);
  }
  const out: string[] = [];
  const writer = { writeJson() { traps++; throw new Error(); }, progress() { throw new Error(); },
    incomplete() { out.push('incomplete'); }, accept() { throw new Error(); } };
  assert.throws(() => writeNativeCapture(writer, proxy), OwnerArtifactError);
  assert.deepEqual(out, ['incomplete']); assert.equal(traps, 0);
});

test('decoder rejects missing, duplicate, reordered, altered, extra and inconsistent chunks even with rebound structural hashes', native, () => {
  const f = fixture();
  try {
    const original = accepted(f, large());
    for (const mode of ['missing', 'duplicate', 'order', 'manifest-order', 'altered', 'extra', 'length', 'whole-hash', 'version', 'name', 'stored-hash', 'stored-bytes', 'encoding', 'mixed', 'noncanonical']) {
      const bundle = clone(original), index = JSON.parse(bundle.files.get('terminal-index.json')!.toString());
      const first = index.chunks[0].name, second = index.chunks[1].name;
      if (mode === 'missing') (bundle.files as Map<string, Buffer>).delete(first);
      if (mode === 'duplicate') index.chunks[1] = index.chunks[0];
      if (mode === 'order') index.chunks.reverse();
      if (mode === 'manifest-order') {
        const i = bundle.manifest.files.findIndex(ref => ref.name === first), j = bundle.manifest.files.findIndex(ref => ref.name === second);
        [bundle.manifest.files[i], bundle.manifest.files[j]] = [bundle.manifest.files[j]!, bundle.manifest.files[i]!];
      }
      if (mode === 'altered') replace(bundle, first, Buffer.from('"AAAA"'));
      if (mode === 'extra' || mode === 'mixed') {
        const name = mode === 'mixed' ? 'terminal.json' : 'terminal-chunk-002.json', body = Buffer.from('{}');
        (bundle.files as Map<string, Buffer>).set(name, body);
        bundle.manifest.files.push({ name, kind: 'artifact', bytes: body.length, sha256: sha(body) });
      }
      if (mode === 'length') index.chunks[0].bytes--;
      if (mode === 'whole-hash') index.sha256 = '0'.repeat(64);
      if (mode === 'version') index.version = 2;
      if (mode === 'name') index.chunks[0].name = '../escape.json';
      if (mode === 'stored-hash') index.chunks[0].storedSha256 = '0'.repeat(64);
      if (mode === 'stored-bytes') index.chunks[0].storedBytes--;
      if (mode === 'encoding') index.encoding = 'utf8';
      if (mode === 'noncanonical') {
        const body = Buffer.from(' ' + bundle.files.get(first)!.toString());
        replace(bundle, first, body); index.chunks[0].storedBytes = body.length; index.chunks[0].storedSha256 = sha(body);
      }
      replace(bundle, 'terminal-index.json', Buffer.from(JSON.stringify(index)));
      assert.throws(() => decodeNativeCapture(bundle), OwnerArtifactError, mode);
    }
    const duplicateRef = clone(original); duplicateRef.manifest.files.push(duplicateRef.manifest.files[1]!);
    assert.throws(() => decodeNativeCapture(duplicateRef), OwnerArtifactError);
  } finally { f.close(); }
});

test('filesystem accepted-bundle reader rejects chunk alteration, removal, addition and manifest reference duplication', native, () => {
  for (const mode of ['alter', 'remove', 'add', 'duplicate']) {
    const f = fixture();
    try {
      const bundle = accepted(f, large()), chunk = 'terminal-chunk-000.json';
      if (mode === 'alter') writeFileSync(f.file(chunk), '"changed"', { mode: 0o600 });
      if (mode === 'remove') unlinkSync(f.file(chunk));
      if (mode === 'add') writeFileSync(f.file('terminal-chunk-002.json'), '"extra"', { mode: 0o600 });
      if (mode === 'duplicate') {
        bundle.manifest.files.push(bundle.manifest.files.find(ref => ref.name === chunk)!);
        writeFileSync(f.file('accepted.json'), JSON.stringify(bundle.manifest), { mode: 0o600 });
      }
      assert.throws(() => readOwnerArtifactBundle(f.options, 'one'), OwnerArtifactError);
    } finally { f.close(); }
  }
});
