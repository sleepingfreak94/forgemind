import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { repositoryProcess } from '../../src/live-workflow/repository-process.js';
import type { EvidenceManifest } from '../../src/live-workflow/evidence.js';
import { sourceIdentity } from '../../src/live-workflow/repository.js';
import { MAX_VIDEO_BYTES, deliverReviewedVideo, prepareVideoDelivery } from '../../src/live-workflow/video-delivery.js';
import type { VideoDeliveryInput, VideoDeliveryOptions } from '../../src/live-workflow/video-delivery.js';

const hash = (v: string) => createHash('sha256').update(v).digest('hex');
function git(root: string, ...args: string[]): string {
  return repositoryProcess('git', ['-c', 'core.hooksPath=/dev/null', ...args], root,
    { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }).toString().trim();
}
function manifest(root: string, phase: 'before' | 'after', source: string): EvidenceManifest {
  const data = `${phase} synthetic unit-test bytes`, path = join(root, `${phase}.mp4`); writeFileSync(path, data);
  // Synthetic test data exercises the host trust contract; it is never visual evidence.
  const body = { version: 1 as const, taskId: 'ticket', scenarioId: 'scenario', phase, label: phase === 'before' ? 'Before' as const : 'After' as const,
    baselineIdentity: 'a'.repeat(40), sourceIdentity: phase === 'before' ? 'a'.repeat(40) : source,
    captureTarget: 'private capture', provenance: 'host-recording' as const, delivery: 'local-only' as const,
    artifactPath: path, artifactSha256: hash(data), artifactBytes: Buffer.byteLength(data),
    video: { durationSeconds: 1, width: 320, height: 240, frames: 15 },
    startedAt: '2026-10-08T00:00:00Z', completedAt: '2026-10-08T00:00:01Z', authorizations:
    [{ action: 'record' as const, receiptId: 'fixture-record', envelopeSha256: hash('record') },
      { action: 'probe' as const, receiptId: 'fixture-probe', envelopeSha256: hash('probe') }] };
  return { ...body, manifestSha256: hash(JSON.stringify(body)) };
}
function resign(item: EvidenceManifest): void {
  const { manifestSha256: _, ...body } = item; item.manifestSha256 = hash(JSON.stringify(body));
}
function fixture(t: TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'video-delivery-test-'))), root = join(base, 'source');
  t.after(() => rmSync(base, { recursive: true, force: true })); mkdirSync(root);
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'Test Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(root, 'code.txt'), 'baseline'); git(root, 'add', 'code.txt'); git(root, 'commit', '-m', 'fixture');
  git(root, 'remote', 'add', 'origin', 'https://github.com/fixture/project.git');
  const identity = sourceIdentity(root), before = manifest(base, 'before', identity), after = manifest(base, 'after', identity);
  const input: VideoDeliveryInput = { projectRoot: root, before, after,
    expected: { taskId: 'ticket', scenarioId: 'scenario', baselineIdentity: before.sourceIdentity, sourceIdentity: identity } };
  let calls = 0;
  const options: VideoDeliveryOptions = { author: { name: 'Test Fixture', email: 'fixture@example.invalid' }, evidenceParent: base,
    budget: { deadline: Date.now() + 120000 },
    verifyReview: async binding => ({ ...binding, codeReviewReceiptId: 'code', visualReviewReceiptId: 'visual',
      independentCodeReview: true, codeVerdict: 'pass', visualPlaybackApproved: true, privacyApproved: true }),
    authorize: async () => { calls++; throw new Error('No writes allowed by validation tests'); } };
  return { base, root, input, options, calls: () => calls };
}
test('prepare is immutable and branded; missing options/directly cloned bundle block', async t => {
  const f = fixture(t), bundle = prepareVideoDelivery(f.input);
  assert.ok(Object.isFrozen(bundle)); assert.match(bundle.branch, /^evidence\/ticket\/[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(bundle).includes(f.base), false);
  assert.equal((await deliverReviewedVideo(bundle)).status, 'local-only-blocked');
  assert.deepEqual(await deliverReviewedVideo({ ...bundle }, f.options), { status: 'local-only-blocked', reason: 'unrecognized-prepared-bundle' });
  assert.equal(f.calls(), 0);
});
test('rejects fixture-only, forged hashes, mismatched source/scenario/framing and missing provenance', t => {
  const f = fixture(t);
  const changes: ((input: VideoDeliveryInput) => void)[] = [
    i => { i.before.provenance = 'fixture-only'; resign(i.before); },
    i => { i.before.video.width++; },
    i => { i.after.scenarioId = 'another'; resign(i.after); },
    i => { i.after.sourceIdentity = 'b'.repeat(64); resign(i.after); },
    i => { i.after.video.width++; resign(i.after); },
    i => { i.before.authorizations = []; resign(i.before); },
    i => { i.after.video.frames = 0; resign(i.after); },
    i => { i.after.captureTarget = 'different'; resign(i.after); },
    i => { i.expected.taskId = '../escape'; },
  ];
  for (const change of changes) { const copy = structuredClone(f.input); change(copy); assert.throws(() => prepareVideoDelivery(copy)); }
});
test('validates bytes, size cap, symlinks, parent symlinks and hardlinks', t => {
  const f = fixture(t), path = f.input.before.artifactPath;
  writeFileSync(path, 'tampered'); assert.throws(() => prepareVideoDelivery(f.input), /size|bytes/);
  f.input.before = manifest(f.base, 'before', f.input.expected.sourceIdentity);
  truncateSync(path, MAX_VIDEO_BYTES + 1); f.input.before.artifactBytes = MAX_VIDEO_BYTES + 1; resign(f.input.before);
  assert.throws(() => prepareVideoDelivery(f.input), /size/);
  f.input.before = manifest(f.base, 'before', f.input.expected.sourceIdentity);
  linkSync(path, join(f.base, 'linked')); assert.throws(() => prepareVideoDelivery(f.input), /hardlink/); rmSync(join(f.base, 'linked'));
  renameSync(path, join(f.base, 'original')); symlinkSync(join(f.base, 'original'), path);
  assert.throws(() => prepareVideoDelivery(f.input), /Symlink/); rmSync(path); renameSync(join(f.base, 'original'), path);
  symlinkSync(f.base, join(f.base, 'sym')); f.input.before.artifactPath = join(f.base, 'sym', 'before.mp4'); resign(f.input.before);
  assert.throws(() => prepareVideoDelivery(f.input), /Symlink/);
});
test('identical-byte inode replacement and post-prepare edits invalidate the bundle before authorization', async t => {
  const f = fixture(t), bundle = prepareVideoDelivery(f.input), path = f.input.before.artifactPath;
  renameSync(path, `${path}.old`); manifest(f.base, 'before', f.input.expected.sourceIdentity);
  assert.equal((await deliverReviewedVideo(bundle, f.options)).status, 'local-only-blocked'); assert.equal(f.calls(), 0);
  const second = prepareVideoDelivery(f.input); writeFileSync(f.input.after.artifactPath, 'changed');
  assert.equal((await deliverReviewedVideo(second, f.options)).status, 'local-only-blocked'); assert.equal(f.calls(), 0);
});
test('requires exact independently verified code and visual/privacy approval', async t => {
  const f = fixture(t);
  for (const patch of [{ destination: 'https://github.com/other/repo.git' }, { pairSha256: '0'.repeat(64) },
    { beforeSha256: '0'.repeat(64) }, { sourceIdentity: '0'.repeat(64) }, { visualPlaybackApproved: false },
    { privacyApproved: false }, { independentCodeReview: false }, { visualReviewReceiptId: '' }]) {
    const verify = f.options.verifyReview;
    const result = await deliverReviewedVideo(prepareVideoDelivery(f.input), { ...f.options,
      verifyReview: async binding => ({ ...await verify(binding), ...patch }) as Awaited<ReturnType<typeof verify>> });
    assert.equal(result.status, 'local-only-blocked');
  }
  assert.equal(f.calls(), 0);
});
test('host review callback cannot mutate source, destination or video and still authorize publication', async t => {
  const f = fixture(t), bundle = prepareVideoDelivery(f.input), verify = f.options.verifyReview;
  const result = await deliverReviewedVideo(bundle, { ...f.options, verifyReview: async binding => {
    writeFileSync(join(f.root, 'code.txt'), 'post-review change'); return verify(binding);
  } });
  assert.equal(result.status, 'local-only-blocked'); assert.equal(f.calls(), 0);
});
test('malicious destinations and changed origin are rejected before any host mutation grant', async t => {
  const f = fixture(t);
  for (const url of ['https://token@github.com/fixture/project.git', 'https://github.com/fixture/../other',
    'file:///tmp/other', 'https://evil.example/fixture/project.git', 'https://github.com/fixture/project.git?redirect=evil']) {
    git(f.root, 'remote', 'set-url', 'origin', url); assert.throws(() => prepareVideoDelivery(f.input));
  }
  git(f.root, 'remote', 'set-url', 'origin', 'https://github.com/fixture/project.git');
  const bundle = prepareVideoDelivery(f.input); git(f.root, 'remote', 'set-url', 'origin', 'https://github.com/other/project.git');
  assert.equal((await deliverReviewedVideo(bundle, f.options)).status, 'local-only-blocked'); assert.equal(f.calls(), 0);
});
test('same-project binding rejects an unexpected candidate source and expired budget', async t => {
  const f = fixture(t); writeFileSync(join(f.root, 'code.txt'), 'changed');
  assert.throws(() => prepareVideoDelivery(f.input), /source identity/);
  writeFileSync(join(f.root, 'code.txt'), 'baseline');
  assert.throws(() => prepareVideoDelivery(f.input, { deadline: Date.now() - 1 }), /deadline/);
  assert.equal((await deliverReviewedVideo(prepareVideoDelivery(f.input), { ...f.options, budget: { deadline: Date.now() - 1 } })).status, 'local-only-blocked');
  assert.equal(f.calls(), 0);
});
