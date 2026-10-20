import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runTask } from '../../src/live-workflow/orchestrator.js';
import { AutomaticRunHistory, recoverAutomaticRunHistory } from '../../src/live-workflow/automatic-run-history.js';
import type { HistoryReviewEvidence } from '../../src/live-workflow/automatic-run-history.js';
import { sha256 } from '../../src/live-workflow/validation.js';
import { RunHistory } from '../../src/memory/run-history.js';
import type { LiveTask } from '../../src/live-workflow/contracts.js';
import { RunAuthority } from '../../src/live-workflow/authority.js';
import { OwnerRunRecorder } from '../../src/memory/run-recording.js';
import { sourceIdentity } from '../../src/live-workflow/repository.js';

function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'fm-auto-history-'))), root = join(directory, 'repo');
  mkdirSync(root, { mode: 0o700 }); mkdirSync(join(root, 'config')); mkdirSync(join(directory, 'trees'));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('remote', 'add', 'origin', 'https://github.com/fixture/project.git');
  writeFileSync(join(root, 'config/forgemind-project.json'), JSON.stringify({ schemaVersion: 1, projectId: 'history-fixture', name: 'History',
    documents: { prd: 'docs/PRD.md', srs: 'docs/SRS.md', adrs: 'docs/adr' },
    preferences: { askAt: 'project', draftPr: false, evidence: 'text', planReview: 'show' } }));
  writeFileSync(join(root, 'value.txt'), 'before'); git('add', '.'); git('commit', '-m', 'fixture');
  const task: LiveTask = { schemaVersion: 1, taskId: 'record-value', objective: 'Change value', readPaths: ['value.txt'], writePaths: ['value.txt'],
    checks: [{ id: 'value', executable: realpathSync(process.execPath), args: ['-e', "process.exit(require('fs').readFileSync('value.txt','utf8')==='after'?0:1)"], timeoutMs: 5000 }],
    model: 'fixture', effort: 'low', maxModelRequests: 3, maxPromptBytes: 65536, maxOutputBytes: 65536, maxRuntimeMs: 90000, draftPr: false };
  const historyDirectory = join(directory, 'history'), runDirectory = join(directory, 'run');
  const options = { workspace: root, task, stateDirectory: runDirectory, worktreeDirectory: join(directory, 'trees'), codexExecutable: '/missing', confirmPlan: async () => true };
  const outputs = [
    { objective: task.objective, paths: ['value.txt'], steps: ['Change value'], acceptanceCriteria: ['Value is after'], risks: [] },
    { summary: 'Change value', edits: [{ path: 'value.txt', beforeSha256: sha256('before'), content: 'after' }] },
    { verdict: 'pass', findings: [], acceptance: ['Value is after'] },
  ];
  const context = { workspace: root, runDirectory, taskId: task.taskId, execution: 'fixture' as const, maxRuntimeMs: task.maxRuntimeMs };
  function records() { const history = new RunHistory(historyDirectory, root); try { return history.list({ afterSequence: 0, limit: 10 }); } finally { history.close(); } }
  return { root, directory, options, outputs, historyDirectory, runDirectory, context, records,
    clean: () => rmSync(directory, { recursive: true, force: true }) };
}
const host = { skip: process.platform !== 'darwin', timeout: 90000 };
test('actual supervised completion records automatically and restart import is idempotent without execution', host, async () => {
  const f = fixture(); let calls = 0, verified = 0;
  const verifyIndependentReview = (e: Readonly<HistoryReviewEvidence>) => {
    verified++; assert.ok(Object.isFrozen(e)); assert.equal(e.taskId, f.options.task.taskId);
    assert.equal(sha256(readFileSync(e.path)), e.sha256); assert.equal(JSON.parse(readFileSync(e.path, 'utf8')).source, e.source); return true;
  };
  try {
    const result = await runTask({ ...f.options, history: { stateDirectory: f.historyDirectory, verifyIndependentReview },
      modelFactory: () => ({ complete: async () => f.outputs[calls++] }) });
    assert.equal(result.status, 'completed-local'); assert.equal(result.history?.status, 'recorded'); assert.equal(calls, 3);
    const records = f.records(); assert.equal(records.length, 1); assert.equal(records[0]!.outcome, 'completed');
    assert.equal(records[0]!.execution, 'fixture'); assert.equal(records[0]!.checks.length, 2);
    assert.equal(records[0]!.checks[0]!.outcome, 'failed'); assert.equal(records[0]!.checks[1]!.outcome, 'passed');
    assert.equal(records[0]!.review?.outcome, 'pass'); assert.equal(records[0]!.runId, result.history?.runId);
    assert.equal(readFileSync(join(f.root, 'value.txt'), 'utf8'), 'before');
    const recovered = recoverAutomaticRunHistory({ stateDirectory: f.historyDirectory, verifyIndependentReview }, f.context);
    assert.equal(recovered.status, 'recorded'); assert.equal(recovered.runId, result.history?.runId);
    assert.deepEqual(f.records(), records); assert.equal(calls, 3); assert.equal(verified, 2);
  } finally { f.clean(); }
});
test('owner plan rejection records blocked facts without checks, candidate or fabricated review', host, async () => {
  const f = fixture(); let calls = 0;
  const config = join(f.root, 'config/forgemind-project.json'), p = JSON.parse(readFileSync(config, 'utf8'));
  p.preferences.planReview = 'approve'; writeFileSync(config, JSON.stringify(p));
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'add', '.'], { cwd: f.root });
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'approval'], { cwd: f.root });
  try {
    const result = await runTask({ ...f.options, confirmPlan: async () => false, history: { stateDirectory: f.historyDirectory },
      modelFactory: () => ({ complete: async () => f.outputs[calls++] }) });
    assert.equal(result.status, 'needs-plan-approval'); assert.equal(result.history?.status, 'recorded');
    const records = f.records(); assert.equal(records.length, 1); assert.equal(records[0]!.outcome, 'blocked');
    assert.equal(records[0]!.lastPhase, 'approval'); assert.deepEqual(records[0]!.checks, []); assert.equal(records[0]!.review, undefined); assert.equal(calls, 1);
  } finally { f.clean(); }
});
test('coding failure preserves the original rejection and records the actual failed prefix', host, async () => {
  const f = fixture(), primary = new Error('fixture coding failure'); let calls = 0;
  try {
    let caught: unknown;
    try { await runTask({ ...f.options, history: { stateDirectory: f.historyDirectory }, modelFactory: () => ({ complete: async () => {
      if (calls++ === 0) return f.outputs[0]; throw primary;
    } }) }); } catch (error) { caught = error; }
    assert.equal(caught, primary); assert.equal(calls, 2);
    const records = f.records(); assert.equal(records.length, 1); assert.equal(records[0]!.outcome, 'failed');
    assert.equal(records[0]!.checks.length, 1); assert.equal(records[0]!.checks[0]!.phase, 'baseline');
    assert.equal(records[0]!.candidateSource, undefined); assert.equal(records[0]!.review, undefined);
  } finally { f.clean(); }
});
test('completed model output cannot attest independence; explicit recovery records without replaying the task', host, async () => {
  const f = fixture(); let calls = 0;
  try {
    const result = await runTask({ ...f.options, history: { stateDirectory: f.historyDirectory }, modelFactory: () => ({ complete: async () => f.outputs[calls++] }) });
    assert.equal(result.status, 'completed-local'); assert.equal(result.history?.status, 'incomplete');
    assert.equal(result.history?.code, 'review-attestation-needed'); assert.deepEqual(f.records(), []);
    assert.equal(existsSync(join(f.runDirectory, 'history-ended.json')), true);
    const recovered = recoverAutomaticRunHistory({ stateDirectory: f.historyDirectory, verifyIndependentReview: () => true }, f.context);
    assert.equal(recovered.status, 'recorded'); assert.equal(calls, 3); assert.equal(f.records().length, 1);
    assert.equal(JSON.parse(readFileSync(result.history!.evidencePath, 'utf8')).status, 'incomplete');
    assert.equal(JSON.parse(readFileSync(recovered.evidencePath, 'utf8')).status, 'recorded');
  } finally { f.clean(); }
});
test('post-execution history persistence failure is explicit and recovers the same immutable execution', host, async () => {
  const f = fixture(); let calls = 0;
  try {
    const result = await runTask({ ...f.options, history: { stateDirectory: f.historyDirectory, verifyIndependentReview: () => {
      chmodSync(f.historyDirectory, 0o755); return true;
    } }, modelFactory: () => ({ complete: async () => f.outputs[calls++] }) });
    assert.equal(result.status, 'completed-local'); assert.equal(result.history?.status, 'incomplete');
    chmodSync(f.historyDirectory, 0o700);
    const manifest = readFileSync(join(result.artifacts, 'history-manifest.json'));
    const recovered = recoverAutomaticRunHistory({ stateDirectory: f.historyDirectory, verifyIndependentReview: () => true }, f.context);
    assert.equal(recovered.status, 'recorded'); assert.equal(calls, 3);
    assert.deepEqual(readFileSync(join(result.artifacts, 'history-manifest.json')), manifest); assert.equal(f.records().length, 1);
  } finally { chmodSync(f.historyDirectory, 0o700); f.clean(); }
});

function historyCleanupFaults(t: import('node:test').TestContext, stages: readonly string[]) {
  const closeRecorder = OwnerRunRecorder.prototype.close, finishAuthority = RunAuthority.prototype.finish, closeAuthority = RunAuthority.prototype.close;
  const counts: Record<string, number> = {};
  const fail = (stage: string) => { counts[stage] = (counts[stage] ?? 0) + 1; throw new Error('injected ' + stage); };
  t.mock.method(OwnerRunRecorder.prototype, 'close', function(this: OwnerRunRecorder) {
    closeRecorder.call(this); if (stages.includes('recorder-close')) fail('recorder-close');
  });
  const primaryHistory = (a: RunAuthority) => a.directory.includes('/history-authority/') && !a.directory.endsWith('/cleanup-authority');
  t.mock.method(RunAuthority.prototype, 'finish', function(this: RunAuthority, status: 'completed' | 'failed' | 'blocked') {
    if (primaryHistory(this) && stages.includes('authority-finish')) fail('authority-finish');
    return finishAuthority.call(this, status);
  });
  t.mock.method(RunAuthority.prototype, 'close', function(this: RunAuthority) {
    const fault = primaryHistory(this) && stages.includes('authority-close'); closeAuthority.call(this);
    if (fault) fail('authority-close');
  });
  return counts;
}
function cleanupNotes(runDirectory: string) {
  return readdirSync(join(runDirectory, 'history-authority')).flatMap(id => {
    const path = join(runDirectory, 'history-authority', id, 'history-cleanup.json');
    return existsSync(path) ? [JSON.parse(readFileSync(path, 'utf8'))] : [];
  });
}
test('all history cleanup stages are independently attempted and remain separate from committed failed-run facts', host, t => {
  const f = fixture();
  try {
    const history = new AutomaticRunHistory({ stateDirectory: f.historyDirectory }, f.context);
    const artifacts = join(f.runDirectory, 'artifacts'); mkdirSync(artifacts, { mode: 0o700 });
    const source = sourceIdentity(f.root), authority = new RunAuthority(join(f.runDirectory, 'workflow'), f.root, 'fixture/project', f.options.task, source);
    authority.phase('failed', source, { message: 'actual setup failure fixture' }); authority.finish('failed');
    writeFileSync(join(artifacts, 'receipt.json'), JSON.stringify(authority.export()) + '\n', { mode: 0o600 }); authority.close();
    const counts = historyCleanupFaults(t, ['recorder-close', 'authority-finish', 'authority-close']);
    const result = history.finish(); assert.equal(result.status, 'incomplete');
    assert.equal(f.records().length, 1); assert.equal(f.records()[0]!.outcome, 'failed');
    assert.deepEqual(counts, { 'recorder-close': 1, 'authority-finish': 1, 'authority-close': 1 });
    const note = JSON.parse(readFileSync(result.evidencePath, 'utf8'));
    assert.deepEqual(note.failures, ['recorder-close', 'authority-finish', 'authority-close']);
    assert.equal(note.disposition.status, 'incomplete'); assert.equal(note.evidence, 'incomplete-no-execution-replay');
    assert.equal(history.finish(), result); assert.deepEqual(counts, { 'recorder-close': 1, 'authority-finish': 1, 'authority-close': 1 });
  } finally { t.mock.restoreAll(); f.clean(); }
});
test('history constructor preserves first preparation error when every cleanup also throws', host, t => {
  const f = fixture(), primary = new Error('original preparation failure');
  try {
    t.mock.method(OwnerRunRecorder.prototype, 'prepare', () => { throw primary; });
    const counts = historyCleanupFaults(t, ['recorder-close', 'authority-finish', 'authority-close']);
    let caught: unknown; try { new AutomaticRunHistory({ stateDirectory: f.historyDirectory }, f.context); } catch (error) { caught = error; }
    assert.equal(caught, primary); assert.deepEqual(counts, { 'recorder-close': 1, 'authority-finish': 1, 'authority-close': 1 });
    assert.equal(cleanupNotes(f.runDirectory).length, 1);
    assert.equal(cleanupNotes(f.runDirectory)[0].disposition, null);
  } finally { t.mock.restoreAll(); f.clean(); }
});
test('successful supervised execution remains successful when history policy finalization throws', host, async t => {
  const f = fixture(); let calls = 0;
  try {
    const counts = historyCleanupFaults(t, ['authority-finish']);
    const result = await runTask({ ...f.options, history: { stateDirectory: f.historyDirectory, verifyIndependentReview: () => true },
      modelFactory: () => ({ complete: async () => f.outputs[calls++] }) });
    assert.equal(result.status, 'completed-local'); assert.equal(result.history?.status, 'incomplete');
    assert.equal(calls, 3); assert.equal(counts['authority-finish'], 1); assert.equal(f.records()[0]!.outcome, 'completed');
    assert.deepEqual(JSON.parse(readFileSync(result.history!.evidencePath, 'utf8')).failures, ['authority-finish']);
  } finally { t.mock.restoreAll(); f.clean(); }
});
test('supervised primary rejection survives recorder cleanup failure', host, async t => {
  const f = fixture(), primary = new Error('original coding rejection'); let calls = 0;
  try {
    const counts = historyCleanupFaults(t, ['recorder-close']); let caught: unknown;
    try { await runTask({ ...f.options, history: { stateDirectory: f.historyDirectory }, modelFactory: () => ({ complete: async () => {
      if (calls++ === 0) return f.outputs[0]; throw primary;
    } }) }); } catch (error) { caught = error; }
    assert.equal(caught, primary); assert.equal(calls, 2); assert.equal(counts['recorder-close'], 1);
    assert.equal(f.records()[0]!.outcome, 'failed'); assert.equal(cleanupNotes(f.runDirectory).length, 1);
  } finally { t.mock.restoreAll(); f.clean(); }
});
test('reopened recovery without original terminal time stays incomplete instead of inventing recovery time', host, async () => {
  const f = fixture(); let calls = 0;
  try {
    const result = await runTask({ ...f.options, history: { stateDirectory: f.historyDirectory, verifyIndependentReview: () => true },
      modelFactory: () => ({ complete: async () => {
        const output = f.outputs[calls++];
        if (calls === 3) writeFileSync(join(f.root, 'concurrent-owner-change.txt'), 'original workspace changed');
        return output;
      } }) });
    assert.equal(result.status, 'completed-local'); assert.equal(result.history?.status, 'incomplete');
    assert.equal(existsSync(join(f.runDirectory, 'history-ended.json')), false); assert.deepEqual(f.records(), []);
    const recovered = recoverAutomaticRunHistory({ stateDirectory: f.historyDirectory, verifyIndependentReview: () => true }, f.context);
    assert.equal(recovered.status, 'incomplete'); assert.equal(existsSync(join(f.runDirectory, 'history-ended.json')), false);
    assert.deepEqual(f.records(), []); assert.equal(calls, 3);
  } finally { f.clean(); }
});
