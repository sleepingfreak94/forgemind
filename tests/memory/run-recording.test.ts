import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from '../../src/context-engine/validation.js';
import { summaryMain } from '../../src/local-runtime/summary-cli.js';
import { OwnerRunRecorder, readOwnerJSON } from '../../src/memory/run-recording.js';
import type { OwnerArtifactManifest, OwnerReservation } from '../../src/memory/run-recording.js';
import type { Receipt } from '../../src/policy/contracts.js';
import { RunHistory } from '../../src/memory/run-history.js';
import { fixture } from './fixture.js';

test('CLI hides private malformed manifest bytes after genuine owner preparation', () => {
  const f = fixture(), common = ['--workspace', f.root, '--state-dir', f.directory];
  let stdout = '', stderr = '';
  const io = { stdout: (text: string) => { stdout += text; }, stderr: (text: string) => { stderr += text; } };
  try {
    assert.equal(summaryMain(['prepare', ...common, '--reservation', 'privacy', '--task', 'privacy', '--provenance', 'fixture'], io, () => 1000), 0);
    const reservation = JSON.parse(stdout) as OwnerReservation;
    assert.equal(reservation.reservationId, 'privacy'); assert.equal(reservation.startedAt, 1000);
    assert.equal(reservation.execution, 'fixture'); assert.equal(stderr, '');
    const marker = 'TOPSECRET_A10_PRIVATE_MANIFEST_7f3c', path = join(f.base, 'private-manifest.json');
    const text = `${marker} ${f.root}\n`;
    writeFileSync(path, text, { mode: 0o600 });
    assert.throws(() => readOwnerJSON(path, digest(text)), SyntaxError);
    stdout = ''; stderr = '';
    assert.equal(summaryMain(['record', ...common, '--reservation', 'privacy', '--manifest', path, '--manifest-sha256', digest(text)], io, () => 2000), 2);
    assert.equal(stdout, '');
    assert.equal(stderr, 'Weekly command failed: invalid owner input. Use --help.\n');
    for (const privateValue of [marker, f.root, f.base, path]) assert.equal(stderr.includes(privateValue), false);
    const history = new RunHistory(f.directory, f.root);
    try { assert.deepEqual(history.list({ afterSequence: 0, limit: 1 }), []); } finally { history.close(); }
  } finally { f.dispose(); }
});

test('CLI catch never reads a hostile Error message getter after stdout fails', () => {
  let reads = 0, stderr = '';
  const error = new Error();
  Object.defineProperty(error, 'message', { get: () => { reads++; throw new Error('message getter accessed'); } });
  const code = summaryMain(['--help'], {
    stdout: () => { throw error; }, stderr: text => { stderr += text; }
  });
  assert.equal(code, 2); assert.equal(reads, 0);
  assert.equal(stderr, 'Weekly command failed: invalid owner input. Use --help.\n');
});

const initial = digest('actual fixture initial'), baseline = digest('actual fixture baseline'), candidate = digest('actual fixture candidate');
function artifacts(base: string, r: OwnerReservation, options: {
  status?: string; candidate?: boolean; checks?: boolean; review?: boolean; passed?: boolean;
  before?: boolean; worktree?: boolean; failedPhase?: boolean; exitCode?: number | null; sameSource?: boolean;
} = {}) {
  const directory = join(base, `artifacts-${r.reservationId}`); mkdirSync(directory, { mode: 0o700 });
  const write = (name: string, value: unknown) => {
    const text = JSON.stringify(value, null, 2) + '\n';
    writeFileSync(join(directory, name), text, { mode: 0o600 }); return digest(text);
  };
  const hasWorktree = options.worktree ?? true, hasCandidate = options.candidate ?? hasWorktree, hasReview = options.review ?? hasCandidate;
  const afterSource = options.sameSource ? baseline : candidate;
  const phases = hasWorktree ? [{ seq: 1, name: 'worktree', source: baseline, data: JSON.stringify({ root: join(base, 'fixture-worktree'), branch: 'task', base: 'fixture-head' }) }] : [];
  if (hasCandidate) phases.push({ seq: 2, name: 'candidate', source: afterSource, data: JSON.stringify({ summary: 'fixture edit', paths: ['src/example.ts'] }) });
  if (hasReview) phases.push({ seq: 3, name: 'reviewed', source: afterSource, data: JSON.stringify({ verdict: 'pass' }) });
  if (options.failedPhase) phases.push({ seq: 4, name: 'failed', source: hasWorktree ? baseline : initial, data: JSON.stringify({ message: 'actual fixture failure' }) });
  const exitCode = options.exitCode === undefined ? options.passed === false ? 1 : 0 : options.exitCode;
  const check = { id: 'types', passed: exitCode === 0, exitCode, stdout: 'actual fixture output', stderr: '' };
  const session: Receipt = { id: 'session-receipt', event: 'session.started', outcome: 'allow', reason: 'trusted-local-launch',
    timestamp: r.startedAt + 50, principalId: 'fixture-owner', sessionId: 'fixture-session', policyVersion: 'local-v1', sourceSnapshot: initial };
  const finish = (id: string, source: string, timestamp: number, outputDigest?: string): Receipt => {
    const viewDigest = digest(`actual fixture envelope ${id}`);
    return { ...session, id, event: 'external.finished', outcome: outputDigest ? check.passed ? 'completed' : 'failed' : 'completed',
      reason: 'executor-terminal', timestamp, sourceSnapshot: source, grantId: `grant-${id}`, invocationId: `invocation-${id}`,
      taskId: r.taskId, requestId: `request-${id}`, action: 'command.run', resource: `host:${viewDigest}`, requestDigest: digest(`request ${id}`),
      terminalEvidence: { viewDigest, ...(outputDigest ? { outputDigest } : {}) } };
  };
  // Worktree/provider finishes have no check output; retain them unchanged.
  const receipts = [session, finish('unrelated', initial, r.startedAt + 100)];
  if (options.before) receipts.push(finish('before', baseline, r.startedAt + 200, digest(JSON.stringify(check))));
  if (hasCandidate && options.checks !== false) receipts.push(finish('after', afterSource, r.startedAt + 300, digest(JSON.stringify(check))));
  const receipt = { taskId: r.taskId, run: { id: r.taskId, status: options.status ?? 'completed', requests: 3, input_bytes: 400 }, phases, receipts };
  const receiptSha = write('receipt.json', receipt);
  const manifest: OwnerArtifactManifest = { schemaVersion: 1, projectId: r.projectId, originalRoot: r.originalRoot,
    runId: r.runId, taskId: r.taskId, endedAt: r.startedAt + 500,
    artifacts: { 'receipt.json': { sha256: receiptSha },
      'before-checks.json': options.before ? { sha256: write('before-checks.json', [check]), source: baseline, phaseSeq: 1 } : null,
      'after-checks.json': hasCandidate && options.checks !== false ? { sha256: write('after-checks.json', [check]), source: afterSource, phaseSeq: 2 } : null,
      'review.json': hasReview ? { sha256: write('review.json', { verdict: 'pass', findings: [], acceptance: ['fixture criterion'], source: afterSource }), source: afterSource, phaseSeq: 3, independent: true } : null } };
  const save = (value: unknown = manifest) => ({ path: join(directory, 'manifest.json'), sha256: write('manifest.json', value) });
  const refresh = () => {
    const bindings = { ...structuredClone(manifest.artifacts), 'receipt.json': { sha256: write('receipt.json', receipt) } };
    for (const name of ['before-checks.json', 'after-checks.json', 'review.json'] as const) {
      const binding = bindings[name];
      if (binding) Object.assign(binding, { sha256: digest(readFileSync(join(directory, name), 'utf8')) });
    }
    return save({ ...manifest, artifacts: bindings });
  };
  return { manifest, receipt, check, save, refresh, write, directory };
}

test('reservation survives restart; exact orchestrator bytes replay without rerunning execution', () => {
  const f = fixture(); let recorder = new OwnerRunRecorder(f.directory, f.root, () => 1000);
  try {
    const request = { reservationId: 'owner-1', taskId: 'task-1', execution: 'fixture' as const };
    const r = recorder.prepare(request);
    recorder.close(); recorder = new OwnerRunRecorder(f.directory, f.root, () => 2000);
    assert.deepEqual(recorder.prepare(request), r);
    assert.throws(() => recorder.prepare({ ...request, taskId: 'other' }), /conflict/);
    assert.throws(() => recorder.prepare({ ...request, execution: 'authenticated' }), /conflict/);
    const a = artifacts(f.base, r), pin = a.save(), record = recorder.record(r.reservationId, pin.path, pin.sha256);
    assert.equal(record.runId, r.runId); assert.equal(record.execution, 'fixture');
    assert.equal(record.startedAt, 1000); assert.equal(record.endedAt, 1500); assert.equal(record.outcome, 'completed');
    assert.equal(record.baselineSource, baseline); assert.equal(record.candidateSource, candidate);
    assert.deepEqual(record.changedPaths, ['src/example.ts']);
    assert.equal(record.terminalReceiptSha256, a.manifest.artifacts['receipt.json'].sha256);
    assert.equal(record.checks[0]?.evidenceSha256, a.manifest.artifacts['after-checks.json']?.sha256);
    recorder.close(); recorder = new OwnerRunRecorder(f.directory, f.root, () => 3000);
    assert.deepEqual(recorder.record(r.reservationId, pin.path, pin.sha256), record);
    const changed = a.save({ ...a.manifest, endedAt: 1600 });
    assert.throws(() => recorder.record(r.reservationId, changed.path, changed.sha256), /conflict/);
    a.save();
    const history = new RunHistory(f.directory, f.root);
    try { history.revoke(record.id, record.digest); } finally { history.close(); }
    assert.throws(() => recorder.record(r.reservationId, pin.path, pin.sha256), /revoked/);
  } finally { recorder.close(); f.dispose(); }
});

for (const status of ['failed', 'blocked', 'running']) {
  test(`${status} retains honest partial facts and actual absent optional artifacts`, () => {
    const f = fixture(); let now = 1000; const recorder = new OwnerRunRecorder(f.directory, f.root, () => now);
    try {
      const r = recorder.prepare({ reservationId: 'partial', taskId: 'partial', execution: 'fixture' }); now = 2000;
      const a = artifacts(f.base, r, { status, candidate: false }), pin = a.save();
      const record = recorder.record(r.reservationId, pin.path, pin.sha256);
      assert.equal(record.outcome, status === 'running' ? 'indeterminate' : status);
      assert.equal(record.lastPhase, 'setup'); assert.equal(record.candidateSource, undefined);
      assert.deepEqual(record.checks, []); assert.deepEqual(record.changedPaths, []); assert.equal(record.review, undefined);
      a.write('after-checks.json', { malformed: true });
      assert.throws(() => recorder.record(r.reservationId, pin.path, pin.sha256), /absent existing/);
    } finally { recorder.close(); f.dispose(); }
  });
}

for (const options of [{ checks: false }, { review: false }, { passed: false }, { candidate: false }]) {
  test(`completion gate rejects insufficient evidence ${JSON.stringify(options)}`, () => {
    const f = fixture(); let now = 1000; const recorder = new OwnerRunRecorder(f.directory, f.root, () => now);
    try {
      const r = recorder.prepare({ reservationId: 'gate', taskId: 'gate', execution: 'fixture' }); now = 2000;
      const pin = artifacts(f.base, r, options).save();
      assert.throws(() => recorder.record(r.reservationId, pin.path, pin.sha256), /incomplete completed/);
    } finally { recorder.close(); f.dispose(); }
  });
}

test('native completion, tampered bytes, malformed evidence and wrong source bindings fail closed', () => {
  const f = fixture(); let now = 1000; const recorder = new OwnerRunRecorder(f.directory, f.root, () => now);
  try {
    const r = recorder.prepare({ reservationId: 'reject', taskId: 'reject', execution: 'fixture' }); now = 2000;
    const a = artifacts(f.base, r), original = a.save();
    a.write('after-checks.json', [{ id: 'types', passed: true, exitCode: 1, stdout: '', stderr: '' }]);
    assert.throws(() => recorder.record(r.reservationId, original.path, original.sha256), /digest mismatch/);
    const badSha = a.write('after-checks.json', { checks: 'not an array' });
    let pin = a.save({ ...a.manifest, artifacts: { ...a.manifest.artifacts, 'after-checks.json': { sha256: badSha, source: candidate, phaseSeq: 2 } } });
    assert.throws(() => recorder.record(r.reservationId, pin.path, pin.sha256), /invalid check/);
    pin = a.save({ ...a.manifest, artifacts: { ...a.manifest.artifacts, 'after-checks.json': { sha256: badSha, source: baseline, phaseSeq: 2 } } });
    assert.throws(() => recorder.record(r.reservationId, pin.path, pin.sha256), /source mismatch/);
    const nativeSha = a.write('receipt.json', { schemaVersion: 1, taskId: r.taskId, status: 'completed', execution: 'native', actions: [] });
    pin = a.save({ ...a.manifest, artifacts: { ...a.manifest.artifacts, 'receipt.json': { sha256: nativeSha } } });
    assert.throws(() => recorder.record(r.reservationId, pin.path, pin.sha256));
  } finally { recorder.close(); f.dispose(); }
});

test('owner-selected authenticated label is structural; conflicting preexisting history rejects import', () => {
  const f = fixture(); let now = 1000; const recorder = new OwnerRunRecorder(f.directory, f.root, () => now);
  try {
    const r = recorder.prepare({ reservationId: 'label', taskId: 'label', execution: 'authenticated' }); now = 2000;
    const a = artifacts(f.base, r, { status: 'blocked', candidate: false }), pin = a.save();
    const history = new RunHistory(f.directory, f.root);
    try {
      history.record({ schemaVersion: 1, runId: r.runId, taskId: r.taskId, execution: r.execution, startedAt: r.startedAt,
        endedAt: 1400, outcome: 'blocked', lastPhase: 'setup', baselineSource: baseline, changedPaths: [], checks: [], terminalReceiptSha256: digest('other receipt') });
      assert.throws(() => recorder.record(r.reservationId, pin.path, pin.sha256), /facts conflict/);
    } finally { history.close(); }
  } finally { recorder.close(); f.dispose(); }
});

test('cross-project imports, public files, hardlinks and symlinks are rejected', () => {
  const f = fixture(), other = fixture('project-b'); let now = 1000;
  const recorder = new OwnerRunRecorder(f.directory, f.root, () => now), second = new OwnerRunRecorder(other.directory, other.root, () => now);
  try {
    const r = recorder.prepare({ reservationId: 'scope', taskId: 'scope', execution: 'fixture' });
    second.prepare({ reservationId: 'scope', taskId: 'scope', execution: 'fixture' }); now = 2000;
    const a = artifacts(f.base, r), pin = a.save();
    assert.throws(() => second.record('scope', pin.path, pin.sha256), /scope mismatch/);
    if (typeof process.getuid === 'function') {
      chmodSync(pin.path, 0o644); assert.throws(() => recorder.record('scope', pin.path, pin.sha256), /private/); chmodSync(pin.path, 0o600);
    }
    const link = join(a.directory, 'linked.json'); linkSync(pin.path, link);
    assert.throws(() => recorder.record('scope', pin.path, pin.sha256), /private/); rmSync(link);
    if (process.platform !== 'win32') {
      symlinkSync(pin.path, link); assert.throws(() => recorder.record('scope', link, pin.sha256), /private/);
    }
  } finally { second.close(); recorder.close(); other.dispose(); f.dispose(); }
});

test('both phases bind identical check JSON to distinct source receipts and preserve exact artifact bytes', () => {
  const f = fixture(); let now = 1000; const recorder = new OwnerRunRecorder(f.directory, f.root, () => now);
  try {
    const r = recorder.prepare({ reservationId: 'bound', taskId: 'bound', execution: 'fixture' }); now = 2000;
    const a = artifacts(f.base, r, { before: true }), pin = a.save();
    const names = ['manifest.json', 'receipt.json', 'before-checks.json', 'after-checks.json', 'review.json'];
    const bytes = names.map(name => readFileSync(join(a.directory, name)));
    const record = recorder.record(r.reservationId, pin.path, pin.sha256);
    assert.deepEqual(record.checks.map(c => [c.phase, c.source, c.outcome]), [['baseline', baseline, 'passed'], ['candidate', candidate, 'passed']]);
    assert.notEqual(a.receipt.receipts[0]!.sourceSnapshot, record.baselineSource);
    names.forEach((name, i) => assert.deepEqual(readFileSync(join(a.directory, name)), bytes[i]));
  } finally { recorder.close(); f.dispose(); }
});

type Artifacts = ReturnType<typeof artifacts>;
const bindingLies: [string, (a: Artifacts) => void][] = [
  ['missing all receipts', a => { a.receipt.receipts = []; }],
  ['missing check receipt', a => { a.receipt.receipts.pop(); }],
  ['output hash', a => { a.receipt.receipts.at(-1)!.terminalEvidence!.outputDigest = digest('lie'); }],
  ['source', a => { a.receipt.receipts.at(-1)!.sourceSnapshot = baseline; }],
  ['task', a => { a.receipt.receipts.at(-1)!.taskId = 'other'; }],
  ['outcome', a => { a.receipt.receipts.at(-1)!.outcome = 'failed'; }],
  ['action', a => { a.receipt.receipts.at(-1)!.action = 'file.read'; }],
  ['duplicate receipt ID', a => { a.receipt.receipts.at(-1)!.id = a.receipt.receipts[0]!.id; }],
  ['ambiguous receipts', a => { a.receipt.receipts.push({ ...a.receipt.receipts.at(-1)!, id: 'ambiguous', requestId: 'ambiguous-request' }); }],
  ['duplicate terminal request', a => { a.receipt.receipts.push({ ...a.receipt.receipts.at(-1)!, id: 'duplicate-request' }); }],
  ['contradictory second terminal', a => { a.receipt.receipts.push({ ...a.receipt.receipts.at(-1)!, id: 'contradictory', requestId: 'contradictory-request', outcome: 'failed' }); }],
  ['missing terminal evidence', a => { delete a.receipt.receipts.at(-1)!.terminalEvidence; }],
  ['missing output digest', a => { delete a.receipt.receipts.at(-1)!.terminalEvidence!.outputDigest; }],
  ['missing view digest', a => { Reflect.deleteProperty(a.receipt.receipts.at(-1)!.terminalEvidence!, 'viewDigest'); }],
  ['malformed view digest', a => { a.receipt.receipts.at(-1)!.terminalEvidence!.viewDigest = 'bad'; }],
  ['extra evidence field', a => { Object.assign(a.receipt.receipts.at(-1)!.terminalEvidence!, { extra: true }); }],
  ['missing request digest', a => { delete a.receipt.receipts.at(-1)!.requestDigest; }],
  ['malformed terminal evidence', a => { Object.assign(a.receipt.receipts.at(-1)!, { terminalEvidence: null }); }],
  ['changed check with recomputed artifact hash', a => { a.write('after-checks.json', [{ ...a.check, stdout: 'invented output' }]); }],
  ['duplicate check reuses terminal', a => { a.write('after-checks.json', [a.check, a.check]); }],
];
for (const [label, mutate] of bindingLies) {
  test(`rejects ${label} after all outer hashes are recomputed`, () => {
    const f = fixture(); let now = 1000; const recorder = new OwnerRunRecorder(f.directory, f.root, () => now);
    try {
      const r = recorder.prepare({ reservationId: 'lie', taskId: 'lie', execution: 'fixture' }); now = 2000;
      const a = artifacts(f.base, r); mutate(a); const pin = a.refresh();
      assert.throws(() => recorder.record(r.reservationId, pin.path, pin.sha256));
      assert.equal(recorder.store.get(`import:${r.runId}`), undefined);
      const history = new RunHistory(f.directory, f.root);
      try { assert.deepEqual(history.list({ afterSequence: 0, limit: 1 }), []); } finally { history.close(); }
    } finally { recorder.close(); f.dispose(); }
  });
}

test('synthetic same-source before and after claims consume two distinct terminals and replay exactly', () => {
  const f = fixture(); let now = 1000; let recorder = new OwnerRunRecorder(f.directory, f.root, () => now);
  try {
    const r = recorder.prepare({ reservationId: 'same-source', taskId: 'same-source', execution: 'fixture' }); now = 2000;
    const a = artifacts(f.base, r, { before: true, sameSource: true }), pin = a.save();
    const terminals = a.receipt.receipts.filter(t => t.terminalEvidence?.outputDigest !== undefined);
    assert.equal(terminals.length, 2);
    assert.notEqual(terminals[0]!.id, terminals[1]!.id);
    assert.notEqual(terminals[0]!.requestId, terminals[1]!.requestId);
    for (const terminal of terminals) {
      assert.equal(terminal.terminalEvidence!.outputDigest, digest(JSON.stringify(a.check)));
      assert.equal(terminal.sourceSnapshot, baseline); assert.equal(terminal.taskId, r.taskId);
      assert.equal(terminal.outcome, 'completed');
    }
    const names = ['manifest.json', 'receipt.json', 'before-checks.json', 'after-checks.json', 'review.json'];
    const bytes = names.map(name => readFileSync(join(a.directory, name)));
    const record = recorder.record(r.reservationId, pin.path, pin.sha256);
    assert.equal(record.execution, 'fixture'); assert.equal(record.outcome, 'completed');
    assert.equal(record.baselineSource, baseline); assert.equal(record.candidateSource, baseline);
    assert.deepEqual(record.checks, [
      { phase: 'baseline', id: 'types', outcome: 'passed', exitCode: 0, source: baseline, evidenceSha256: a.manifest.artifacts['before-checks.json']!.sha256 },
      { phase: 'candidate', id: 'types', outcome: 'passed', exitCode: 0, source: baseline, evidenceSha256: a.manifest.artifacts['after-checks.json']!.sha256 },
    ]);
    assert.equal(record.terminalReceiptSha256, digest(bytes[1]!.toString('utf8')));
    assert.equal(record.checks[0]!.evidenceSha256, digest(bytes[2]!.toString('utf8')));
    assert.equal(record.checks[1]!.evidenceSha256, digest(bytes[3]!.toString('utf8')));
    assert.equal(a.manifest.artifacts['review.json']!.independent, true);
    assert.deepEqual(record.review, { outcome: 'pass', source: baseline, evidenceSha256: digest(bytes[4]!.toString('utf8')) });
    recorder.close(); recorder = new OwnerRunRecorder(f.directory, f.root, () => 2000);
    assert.deepEqual(recorder.record(r.reservationId, pin.path, pin.sha256), record);
    names.forEach((name, i) => assert.deepEqual(readFileSync(join(a.directory, name)), bytes[i]));
  } finally { recorder.close(); f.dispose(); }
});

const sameSourceLies: [string, (a: Artifacts) => void, RegExp][] = [
  ['third matching terminal for two claims', a => {
    a.receipt.receipts.push({ ...a.receipt.receipts.at(-1)!, id: 'third', requestId: 'third-request' });
  }, /check action binding/],
  ['contradictory second terminal for two claims', a => { a.receipt.receipts.at(-1)!.outcome = 'failed'; }, /check action binding/],
  ['two duplicate IDs within baseline with two matching terminals', a => {
    a.write('before-checks.json', [a.check, a.check]); a.write('after-checks.json', []);
  }, /duplicate check ID within phase/],
  ['two duplicate IDs within candidate with two matching terminals', a => {
    a.write('before-checks.json', []); a.write('after-checks.json', [a.check, a.check]);
  }, /duplicate check ID within phase/],
  ['second terminal source mismatch leaves insufficient group', a => { a.receipt.receipts.at(-1)!.sourceSnapshot = candidate; }, /check action binding/],
  ['second terminal task mismatch leaves insufficient group', a => { a.receipt.receipts.at(-1)!.taskId = 'other'; }, /check action binding/],
  ['malformed second terminal source', a => { a.receipt.receipts.at(-1)!.sourceSnapshot = 'invalid'; }, /digest/],
  ['missing second terminal task', a => { delete a.receipt.receipts.at(-1)!.taskId; }, /invalid-input/],
];
for (const [label, mutate, diagnostic] of sameSourceLies) {
  test(`synthetic same-source group rejects ${label} with recomputed hashes`, () => {
    const f = fixture(); let now = 1000; const recorder = new OwnerRunRecorder(f.directory, f.root, () => now);
    try {
      const r = recorder.prepare({ reservationId: 'same-source-lie', taskId: 'same-source-lie', execution: 'fixture' }); now = 2000;
      const a = artifacts(f.base, r, { before: true, sameSource: true }); mutate(a); const pin = a.refresh();
      assert.throws(() => recorder.record(r.reservationId, pin.path, pin.sha256), diagnostic);
      assert.equal(recorder.store.get(`import:${r.runId}`), undefined);
      const history = new RunHistory(f.directory, f.root);
      try { assert.deepEqual(history.list({ afterSequence: 0, limit: 1 }), []); } finally { history.close(); }
    } finally { recorder.close(); f.dispose(); }
  });
}

test('one terminal cannot be reused across baseline and candidate at the same source', () => {
  const f = fixture(); let now = 1000; const recorder = new OwnerRunRecorder(f.directory, f.root, () => now);
  try {
    const r = recorder.prepare({ reservationId: 'reuse', taskId: 'reuse', execution: 'fixture' }); now = 2000;
    const a = artifacts(f.base, r, { before: true, sameSource: true }); a.receipt.receipts.pop(); const pin = a.refresh();
    assert.throws(() => recorder.record(r.reservationId, pin.path, pin.sha256), /check action binding/);
  } finally { recorder.close(); f.dispose(); }
});

for (const status of ['failed', 'blocked', 'running']) {
  test(`${status} imports null candidate exit with failed terminal and rejects completed terminal`, () => {
    const f = fixture(); let now = 1000; const recorder = new OwnerRunRecorder(f.directory, f.root, () => now);
    try {
      const r = recorder.prepare({ reservationId: 'null-exit', taskId: 'null-exit', execution: 'fixture' }); now = 2000;
      const a = artifacts(f.base, r, { status, review: false, exitCode: null }), pin = a.save();
      const terminal = a.receipt.receipts.at(-1)!;
      assert.equal(terminal.outcome, 'failed');
      assert.equal(terminal.terminalEvidence!.outputDigest, digest(JSON.stringify(a.check)));
      const record = recorder.record(r.reservationId, pin.path, pin.sha256);
      assert.equal(record.outcome, status === 'running' ? 'indeterminate' : status);
      assert.equal(record.checks[0]!.phase, 'candidate');
      assert.equal(record.checks[0]!.exitCode, null); assert.equal(record.checks[0]!.outcome, 'indeterminate');
      terminal.outcome = 'completed'; const lie = a.refresh();
      assert.throws(() => recorder.record(r.reservationId, lie.path, lie.sha256), /check action binding/);
    } finally { recorder.close(); f.dispose(); }
  });
}

test('completed run with independent passing review rejects null candidate exit and failed terminal', () => {
  const f = fixture(); let now = 1000; const recorder = new OwnerRunRecorder(f.directory, f.root, () => now);
  try {
    const r = recorder.prepare({ reservationId: 'null-gate', taskId: 'null-gate', execution: 'fixture' }); now = 2000;
    const a = artifacts(f.base, r, { status: 'completed', review: true, exitCode: null }), pin = a.save();
    assert.equal(a.manifest.artifacts['review.json']!.independent, true);
    assert.equal(JSON.parse(readFileSync(join(a.directory, 'review.json'), 'utf8')).verdict, 'pass');
    assert.equal(a.receipt.receipts.at(-1)!.outcome, 'failed');
    assert.throws(() => recorder.record(r.reservationId, pin.path, pin.sha256), /incomplete completed/);
  } finally { recorder.close(); f.dispose(); }
});

for (const exitCode of [1, null]) {
  test(`honest nonpassing check ${exitCode} binds its actual terminal outcome`, () => {
    const f = fixture(); let now = 1000; const recorder = new OwnerRunRecorder(f.directory, f.root, () => now);
    try {
      const r = recorder.prepare({ reservationId: 'nonpassing', taskId: 'nonpassing', execution: 'fixture' }); now = 2000;
      const a = artifacts(f.base, r, { status: 'failed', review: false, exitCode }), pin = a.save();
      const record = recorder.record(r.reservationId, pin.path, pin.sha256);
      assert.equal(record.checks[0]!.outcome, exitCode === null ? 'indeterminate' : 'failed');
      a.receipt.receipts.at(-1)!.outcome = 'completed'; const lie = a.refresh();
      assert.throws(() => recorder.record(r.reservationId, lie.path, lie.sha256), /check action binding/);
    } finally { recorder.close(); f.dispose(); }
  });
}

for (const status of ['failed', 'blocked', 'running']) {
  for (const failedPhase of [false, true]) {
    test(`${status} before worktree retains session baseline and ${failedPhase ? 'failed' : 'no'} actual phase`, () => {
      const f = fixture(); let now = 1000; const recorder = new OwnerRunRecorder(f.directory, f.root, () => now);
      try {
        const r = recorder.prepare({ reservationId: 'early', taskId: 'early', execution: 'fixture' }); now = 2000;
        const a = artifacts(f.base, r, { status, worktree: false, failedPhase }), pin = a.save();
        const record = recorder.record(r.reservationId, pin.path, pin.sha256);
        assert.equal(record.baselineSource, initial); assert.equal(record.candidateSource, undefined);
        assert.equal(record.lastPhase, failedPhase ? 'terminal' : 'setup');
        assert.equal(record.outcome, status === 'running' ? 'indeterminate' : status);
        assert.deepEqual(record.checks, []); assert.deepEqual(record.changedPaths, []); assert.equal(record.review, undefined);
        assert.deepEqual(recorder.record(r.reservationId, pin.path, pin.sha256), record);
      } finally { recorder.close(); f.dispose(); }
    });
  }
}

const earlyLies: [string, (a: Artifacts) => void][] = [
  ['completed', a => { a.receipt.run.status = 'completed'; }],
  ['missing session', a => { a.receipt.receipts.shift(); }],
  ['ambiguous session', a => { a.receipt.receipts.splice(1, 0, { ...a.receipt.receipts[0]!, id: 'extra-session' }); }],
  ['malformed session source', a => { a.receipt.receipts[0]!.sourceSnapshot = 'invalid'; }],
  ['session with taskId', a => { a.receipt.receipts[0]!.taskId = a.receipt.taskId; }],
  ['session reason', a => { a.receipt.receipts[0]!.reason = 'untrusted'; }],
  ['session outcome', a => { a.receipt.receipts[0]!.outcome = 'deny'; }],
  ['pre-reservation timestamp', a => { a.receipt.receipts[0]!.timestamp = 999; }],
  ['post-terminal timestamp', a => { a.receipt.receipts.at(-1)!.timestamp = 1501; }],
  ['fractional timestamp', a => { a.receipt.receipts[0]!.timestamp = 1050.5; }],
  ['negative timestamp', a => { a.receipt.receipts[0]!.timestamp = -1; }],
  ['reversed timestamps', a => { a.receipt.receipts.at(-1)!.timestamp = 1000; }],
  ['mismatched session', a => { a.receipt.receipts.at(-1)!.sessionId = 'other'; }],
  ['candidate without worktree', a => { a.receipt.phases.push({ seq: 1, name: 'candidate', source: candidate, data: JSON.stringify({ paths: ['src/example.ts'] }) }); }],
  ['review without worktree', a => { a.receipt.phases.push({ seq: 1, name: 'reviewed', source: initial, data: JSON.stringify({ verdict: 'pass' }) }); }],
  ['failed phase source lie', a => { a.receipt.phases.push({ seq: 1, name: 'failed', source: candidate, data: '{}' }); }],
  ['check artifact without worktree', a => { Object.assign(a.manifest.artifacts, { 'before-checks.json': { sha256: a.write('before-checks.json', [a.check]), source: initial, phaseSeq: 1 } }); }],
  ['review artifact without worktree', a => { Object.assign(a.manifest.artifacts, { 'review.json': { sha256: a.write('review.json', {}), source: initial, phaseSeq: 1, independent: true } }); }],
];
for (const [label, mutate] of earlyLies) {
  test(`early setup rejects ${label} with recomputed hashes`, () => {
    const f = fixture(); let now = 1000; const recorder = new OwnerRunRecorder(f.directory, f.root, () => now);
    try {
      const r = recorder.prepare({ reservationId: 'early-lie', taskId: 'early-lie', execution: 'fixture' }); now = 2000;
      const a = artifacts(f.base, r, { status: 'failed', worktree: false }); mutate(a); const pin = a.refresh();
      assert.throws(() => recorder.record(r.reservationId, pin.path, pin.sha256));
    } finally { recorder.close(); f.dispose(); }
  });
}

test('artifact reader scopes POSIX mode checks to available getuid and restores its descriptor', () => {
  const f = fixture(), directory = join(f.base, 'reader'); mkdirSync(directory, { mode: 0o700 });
  const path = join(directory, 'artifact.json'), text = '{"fixture":true}\n';
  writeFileSync(path, text, { mode: 0o600 }); chmodSync(path, 0o644);
  const descriptor = Object.getOwnPropertyDescriptor(process, 'getuid');
  try {
    let value: unknown;
    try {
      Object.defineProperty(process, 'getuid', { configurable: true, writable: true, value: undefined });
      value = readOwnerJSON(path, digest(text));
    } finally {
      if (descriptor) Object.defineProperty(process, 'getuid', descriptor);
      else Reflect.deleteProperty(process, 'getuid');
    }
    assert.deepEqual(value, { fixture: true });
    assert.deepEqual(Object.getOwnPropertyDescriptor(process, 'getuid'), descriptor);
    if (typeof process.getuid === 'function') assert.throws(() => readOwnerJSON(path, digest(text)), /private/);
    chmodSync(path, 0o600);
    assert.throws(() => readOwnerJSON(path, digest('wrong')), /digest mismatch/);
    const invalid = Buffer.from([0x22, 0xff, 0x22]); writeFileSync(path, invalid);
    assert.throws(() => readOwnerJSON(path, createHash('sha256').update(invalid).digest('hex')), /encoded data|encoding/i);
    writeFileSync(path, ' '.repeat(1048577));
    assert.throws(() => readOwnerJSON(path, digest(' '.repeat(1048577))), /unsafe artifact/);
  } finally { f.dispose(); }
});
