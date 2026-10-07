import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAvfoundationCommand, ffprobeArgs, parseVideoProbe, recordEvidence, validateEvidencePair } from '../../src/live-workflow/evidence.js';
import type { AuthorizationEnvelope, EvidenceManifest, EvidenceOptions, RecordingRequest } from '../../src/live-workflow/evidence.js';

// All bytes/probe JSON in this suite are synthetic fixtures, never screen recordings.
const probeJson = { streams: [{ codec_type: 'video', width: 640, height: 480, nb_read_frames: '15' }], format: { duration: '1.0' } };
function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'forgemind-evidence-fixture-'))), artifacts = join(root, 'task-artifacts');
  mkdirSync(artifacts, { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const probe = join(root, 'fixture-probe');
  writeFileSync(probe, `#!${realpathSync(process.execPath)}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(probeJson))});\n`, { mode: 0o700 });
  const requests: AuthorizationEnvelope[] = [];
  const options: EvidenceOptions = { probe: { kind: 'fixture-only', executable: probe, sha256: createHash('sha256').update(readFileSync(probe)).digest('hex') },
    authorize: async envelope => { requests.push(envelope); return { allowed: true, receiptId: `fixture-approval-${requests.length}` }; } };
  const request: RecordingRequest = { explicitlyRequested: true, taskId: 'fixture-task', scenarioId: 'fixture-scenario', phase: 'before',
    baselineIdentity: 'snapshot:baseline', sourceIdentity: 'snapshot:baseline', artifactsDirectory: artifacts, outputPath: join(artifacts, 'before.mp4'),
    captureTarget: 'fixture-only; no screen capture', command: { executable: realpathSync(process.execPath), argv: [] },
    limits: { maxDurationSeconds: 2, maxRuntimeMs: 1500, maxOutputBytes: 4096, maxArtifactBytes: 4096, terminateGraceMs: 30 } };
  const command = (script: string) => { request.command = { executable: realpathSync(process.execPath), argv: ['-e', script, request.outputPath] }; };
  command("require('node:fs').writeFileSync(process.argv[1], 'FIXTURE ONLY: not a video')");
  return { root, artifacts, request, options, requests, command, probe };
}

test('exact approved fixture subprocess yields digest-bound local-only fixture manifest', async t => {
  const f = fixture(t), manifest = await recordEvidence(f.request, f.options);
  assert.equal(manifest.provenance, 'fixture-only'); assert.equal(manifest.delivery, 'local-only');
  assert.equal(manifest.label, 'Before'); assert.equal(manifest.video.frames, 15);
  assert.equal(manifest.artifactSha256, createHash('sha256').update(readFileSync(f.request.outputPath)).digest('hex'));
  assert.equal(manifest.authorizations.length, 2); assert.equal(f.requests[0]!.action, 'record');
  assert.deepEqual(f.requests[0]!.environment, { LANG: 'C', LC_ALL: 'C' });
  assert.deepEqual(f.requests[1]!.command.argv, ffprobeArgs(f.request.outputPath));
  assert.equal(Object.isFrozen(f.requests[0]!.request.command.argv), true);
  assert.equal(Object.isFrozen(manifest), true);
  const { manifestSha256, ...body } = manifest;
  assert.equal(manifestSha256, createHash('sha256').update(JSON.stringify(body)).digest('hex'));
});

test('approval denial and omitted explicit request never start process', async t => {
  const f = fixture(t);
  await assert.rejects(recordEvidence(f.request, { ...f.options, authorize: async () => ({ allowed: false, receiptId: 'deny' }) }), /denied/);
  assert.equal(existsSync(f.request.outputPath), false);
  await assert.rejects(recordEvidence({ ...f.request, explicitlyRequested: false } as unknown as RecordingRequest, f.options), /explicit/);
  assert.equal(existsSync(f.request.outputPath), false);
});

test('no parent secrets or shell expansion are inherited', async t => {
  const f = fixture(t);
  process.env.FORGEMIND_SYNTHETIC_SECRET = 'fixture-secret';
  t.after(() => { delete process.env.FORGEMIND_SYNTHETIC_SECRET; });
  f.command("require('node:fs').writeFileSync(process.argv[1], JSON.stringify({secret:process.env.FORGEMIND_SYNTHETIC_SECRET,argv:process.argv.slice(2)}))");
  f.request.command = { ...f.request.command, argv: [...f.request.command.argv, '$(touch SHOULD_NOT_EXIST); literal'] };
  await recordEvidence(f.request, f.options);
  assert.deepEqual(JSON.parse(readFileSync(f.request.outputPath, 'utf8')), { argv: ['$(touch SHOULD_NOT_EXIST); literal'] });
  assert.equal(existsSync(join(f.artifacts, 'SHOULD_NOT_EXIST')), false);
});

test('missing, empty, oversized, wrong output and nonzero exit fail without probe', async t => {
  for (const script of ['void 0', "require('node:fs').writeFileSync(process.argv[1], '')",
    "require('node:fs').writeFileSync(process.argv[1], Buffer.alloc(5000))",
    "require('node:fs').writeFileSync(process.argv[1]+'.wrong', 'fixture')",
    "require('node:fs').writeFileSync(process.argv[1], 'fixture'); process.exit(2)"]) {
    const f = fixture(t); f.command(script);
    await assert.rejects(recordEvidence(f.request, f.options));
    assert.equal(f.requests.length, 1);
  }
});

test('escaped paths, preexisting outputs, symlink components and hardlinks are rejected', async t => {
  for (const kind of ['escape', 'traversal', 'existing', 'directory-link', 'artifact-link', 'hardlink']) {
    const f = fixture(t), other = join(f.root, 'other'); writeFileSync(other, 'fixture');
    if (kind === 'escape') f.request.outputPath = join(f.root, 'outside.mp4');
    if (kind === 'traversal') f.request.outputPath = `${f.artifacts}/../outside.mp4`;
    if (kind === 'existing') writeFileSync(f.request.outputPath, 'existing');
    if (kind === 'directory-link') { symlinkSync(f.artifacts, join(f.root, 'link')); f.request.artifactsDirectory = join(f.root, 'link'); f.request.outputPath = join(f.root, 'link', 'before.mp4'); }
    if (kind === 'artifact-link') f.command(`require('node:fs').symlinkSync(${JSON.stringify(other)}, process.argv[1])`);
    if (kind === 'hardlink') f.command(`require('node:fs').linkSync(${JSON.stringify(other)}, process.argv[1])`);
    await assert.rejects(recordEvidence(f.request, f.options));
    assert.equal(readFileSync(other, 'utf8'), 'fixture');
  }
});

test('timeout and cancel terminate and reap a process ignoring SIGTERM', async t => {
  for (const mode of ['timeout', 'cancel']) {
    const f = fixture(t), controller = new AbortController();
    f.request.limits.maxRuntimeMs = mode === 'timeout' ? 150 : 1000;
    f.command("require('node:fs').writeFileSync(process.argv[1], String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},100)");
    const pending = recordEvidence(f.request, { ...f.options, signal: controller.signal });
    const timer = mode === 'cancel' ? setTimeout(() => controller.abort(), 150) : undefined;
    try { await assert.rejects(pending, mode === 'cancel' ? /cancelled/ : /timeout/); }
    finally { if (timer) clearTimeout(timer); }
    assert.equal(f.requests.length, 1);
    if (existsSync(f.request.outputPath)) assert.throws(() => process.kill(Number(readFileSync(f.request.outputPath, 'utf8')), 0), /ESRCH/);
  }
});

test('cancellation during authorization prevents spawn', async t => {
  const f = fixture(t), controller = new AbortController();
  await assert.rejects(recordEvidence(f.request, { ...f.options, signal: controller.signal,
    authorize: async () => { controller.abort(); return { allowed: true, receiptId: 'fixture' }; } }), /cancelled/);
  assert.equal(existsSync(f.request.outputPath), false);
});

test('stdout and artifact growth enforce explicit limits', async t => {
  for (const script of ["process.stdout.write('x'.repeat(10000)); setInterval(()=>{},100)",
    "require('node:fs').writeFileSync(process.argv[1], Buffer.alloc(5000)); setInterval(()=>{},100)"]) {
    const f = fixture(t); f.command(script);
    await assert.rejects(recordEvidence(f.request, f.options), /limit/);
    assert.equal(f.requests.length, 1);
  }
});

test('missing, mismatched and mutated probe binaries fail closed', async t => {
  const f = fixture(t);
  await assert.rejects(recordEvidence(f.request, { ...f.options, probe: { ...f.options.probe, sha256: '0'.repeat(64) } }), /pin/);
  await assert.rejects(recordEvidence(f.request, { ...f.options, probe: { ...f.options.probe, executable: join(f.root, 'absent') } }));
  assert.equal(existsSync(f.request.outputPath), false);
  await assert.rejects(recordEvidence(f.request, { ...f.options, authorize: async envelope => {
    if (envelope.action === 'probe') writeFileSync(f.probe, '#!/bin/false\n');
    return { allowed: true, receiptId: 'fixture' };
  } }), /changed/);
});

test('wrong probe output, decoding errors, and artifact mutation cannot produce manifest', async t => {
  for (const script of ["process.stdout.write('{}')", "process.stderr.write('decode error'); process.stdout.write('{}')",
    `require('node:fs').writeFileSync(process.argv.at(-1),'changed'); process.stdout.write(${JSON.stringify(JSON.stringify(probeJson))})`]) {
    const f = fixture(t);
    writeFileSync(f.probe, `#!${realpathSync(process.execPath)}\n${script}\n`);
    f.options.probe.sha256 = createHash('sha256').update(readFileSync(f.probe)).digest('hex');
    await assert.rejects(recordEvidence(f.request, f.options));
  }
});

test('video validation rejects invalid duration, dimensions, frames, stream type and JSON', () => {
  for (const raw of ['invalid', '{}', JSON.stringify({ streams: [] }),
    ...[0, -1, 'NaN', 'Infinity', 'N/A', null, true, 3].map(duration => JSON.stringify({ ...probeJson, format: { duration } })),
    ...[{ width: 0 }, { height: 0 }, { nb_read_frames: '0' }, { nb_read_frames: 'N/A' }, { codec_type: 'audio' }].map(change =>
      JSON.stringify({ ...probeJson, streams: [{ ...probeJson.streams[0], ...change }] }))]) assert.throws(() => parseVideoProbe(raw, 2));
});

// Pure validation fixtures; never used as an actual capture receipt.
function pairFixture(phase: 'before' | 'after'): EvidenceManifest {
  const body = { version: 1 as const, taskId: 'task', scenarioId: 'scenario', phase, label: phase === 'before' ? 'Before' as const : 'After' as const,
    baselineIdentity: 'baseline', sourceIdentity: phase === 'before' ? 'baseline' : 'candidate', captureTarget: 'target',
    provenance: 'host-recording' as const, delivery: 'local-only' as const, artifactPath: `/fixture-only/${phase}.mp4`, artifactSha256: 'a'.repeat(64),
    artifactBytes: 100, video: { durationSeconds: 1, width: 640, height: 480, frames: 15 }, startedAt: 'fixture-only', completedAt: 'fixture-only',
    authorizations: [] };
  return { ...body, manifestSha256: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
}
function resign(value: EvidenceManifest): EvidenceManifest {
  const { manifestSha256: _, ...body } = value;
  return { ...body, manifestSha256: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
}
test('before/after pair rejects baseline/source/scenario/framing mismatch and fixture receipts', () => {
  const before = pairFixture('before'), after = pairFixture('after');
  const expected = { taskId: 'task', scenarioId: 'scenario', baselineIdentity: 'baseline', sourceIdentity: 'candidate' };
  assert.doesNotThrow(() => validateEvidencePair(before, after, expected));
  for (const change of [{ sourceIdentity: 'wrong' }, { baselineIdentity: 'wrong' }, { scenarioId: 'other' },
    { provenance: 'fixture-only' as const }, { captureTarget: 'other' }, { video: { ...after.video, width: 800 } }]) {
    assert.throws(() => validateEvidencePair(before, resign({ ...after, ...change }), expected));
  }
  assert.throws(() => validateEvidencePair(resign({ ...before, sourceIdentity: 'wrong' }), after, expected));
  assert.throws(() => validateEvidencePair(before, { ...after, artifactSha256: '0'.repeat(64) }, expected));
});

test('ffmpeg builder accepts numeric device only and fixes duration, size, audio and output format', () => {
  const options = { executable: '/usr/local/bin/ffmpeg', deviceIndex: 2, outputPath: '/private/task/before.mp4', durationSeconds: 10, maxArtifactBytes: 1_000_000 };
  const command = buildAvfoundationCommand(options);
  assert.ok(command.argv.includes('2:none')); assert.ok(command.argv.includes('-nostdin')); assert.ok(command.argv.includes('-fs'));
  assert.equal(command.argv.at(-1), options.outputPath); assert.equal(command.argv.includes('-y'), false);
  for (const deviceIndex of [-1, NaN, 1.5, 'https://media.example/file' as unknown as number]) {
    assert.throws(() => buildAvfoundationCommand({ ...options, deviceIndex }));
  }
});


test('process group cleanup terminates descendants even when the recorder exits normally', async t => {
  const f = fixture(t), marker = join(f.artifacts, 'descendant-survived');
  const descendant = `process.on('SIGTERM',()=>{});setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'survived'),600)`;
  f.command(`const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});c.unref();require('node:fs').writeFileSync(process.argv[1],'fixture');`);
  await recordEvidence(f.request, f.options);
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.equal(existsSync(marker), false);
});

test('invalid limits and baseline identity fail before approval; probe denial cannot yield evidence', async t => {
  const f = fixture(t);
  for (const change of [{ maxRuntimeMs: 0 }, { maxOutputBytes: Infinity }, { maxArtifactBytes: 0.5 }, { maxDurationSeconds: NaN }]) {
    await assert.rejects(recordEvidence({ ...f.request, limits: { ...f.request.limits, ...change } }, f.options), /limit/);
  }
  await assert.rejects(recordEvidence({ ...f.request, sourceIdentity: 'candidate' }, f.options), /source mismatch/);
  assert.equal(f.requests.length, 0);
  await assert.rejects(recordEvidence(f.request, { ...f.options, authorize: async e => ({ allowed: e.action === 'record', receiptId: 'fixture' }) }), /denied/);
});
