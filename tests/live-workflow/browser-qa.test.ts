import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runTask } from '../../src/live-workflow/orchestrator.js';
import { BrowserQaHandoff, BROWSER_QA_MAX_AGE_MS, validateBrowserQaReport } from '../../src/live-workflow/browser-qa.js';
import { loadBrowserQaConfiguration } from '../../src/live-workflow/browser-qa-command.js';
import type { BrowserQaReport, BrowserQaRequest } from '../../src/live-workflow/browser-qa.js';
import { sha256, task } from '../../src/live-workflow/validation.js';
import { browserQaFixture, report } from './browser-qa-fixture.js';

const request: BrowserQaRequest = { phase: 'candidate', workspace: '/fixture', task: { taskId: 'fixture' } as BrowserQaRequest['task'],
  scenarioId: 'fixture', baselineSource: 'a'.repeat(64), currentSource: 'b'.repeat(64), requestId: 'fixture-request',
  requestedAt: Date.now(), signal: new AbortController().signal };
const invalid: [string, (value: BrowserQaReport) => unknown][] = [
  ['missing', () => undefined], ['empty', () => ({})], ['empty checks', v => ({ ...v, checks: [] })],
  ['invalid schema', v => ({ ...v, executable: '/untrusted' })], ['invalid version', v => ({ ...v, version: 2 })],
  ['stale source', v => ({ ...v, currentSource: 'c'.repeat(64) })], ['stale baseline', v => ({ ...v, baselineSource: 'd'.repeat(64) })],
  ['stale request', v => ({ ...v, requestId: 'old-request' })], ['wrong task', v => ({ ...v, taskId: 'other' })],
  ['wrong scenario', v => ({ ...v, scenarioId: 'other' })], ['wrong workspace', v => ({ ...v, workspace: '/other' })],
  ['wrong phase', v => ({ ...v, phase: 'baseline' })], ['old time', v => ({ ...v, startedAt: 1 })],
  ['future time', v => ({ ...v, completedAt: Date.now() + 10000 })],
  ['string width', v => ({ ...v, checks: [{ ...v.checks[0], viewportWidth: '375' }] })],
  ['zero width', v => ({ ...v, checks: [{ ...v.checks[0], viewportWidth: 0 }] })],
  ['fractional width', v => ({ ...v, checks: [{ ...v.checks[0], viewportWidth: 1.5 }] })],
  ['duplicate check', v => ({ ...v, checks: [v.checks[0], v.checks[0]] })],
  ['nonpass candidate', v => ({ ...v, checks: [{ ...v.checks[0], passed: false }] })],
  ['nonboolean pass', v => ({ ...v, checks: [{ ...v.checks[0], passed: 'true' }] })],
  ['extra check property', v => ({ ...v, checks: [{ ...v.checks[0], override: true }] })],
  ['oversized detail', v => ({ ...v, checks: [{ ...v.checks[0], detail: 'a'.repeat(2049) }] })],
  ['oversized report', v => ({ ...v, checks: Array.from({ length: 128 }, (_, i) => ({ ...v.checks[0], id: String(i), detail: 'a'.repeat(2048) })) })],
];
for (const [name, mutate] of invalid) test('report schema rejects ' + name + ' (synthetic fixture)', () => {
  assert.throws(() => validateBrowserQaReport(mutate(report(request)), request));
});
test('baseline failure is a valid reproducer; candidate must pass; reports are immutable and expire', () => {
  const baseline = { ...request, phase: 'baseline' as const, currentSource: request.baselineSource };
  assert.equal(validateBrowserQaReport(report(baseline), baseline).checks[0]!.passed, false);
  const candidate = validateBrowserQaReport(report(request), request);
  assert.equal(Object.isFrozen(candidate.checks), true);
  assert.throws(() => validateBrowserQaReport(candidate, request, request.requestedAt + BROWSER_QA_MAX_AGE_MS + 1), /stale/);
  const getter = { ...candidate }; Object.defineProperty(getter, 'checks', { get() { throw new Error('must not execute'); } });
  assert.throws(() => validateBrowserQaReport(getter, request), error => !String(error).includes('must not execute'));
  assert.throws(() => task({ browserQa: { executable: '/untrusted' } }), /Unexpected object fields/);
});

test('automatic baseline/candidate handoff follows checks and supplies both hashed reports to fresh reviewer (fixtures)', {
  skip: process.platform !== 'darwin', timeout: 60000,
}, async () => {
  const f = browserQaFixture(), phases: string[] = []; let calls = 0;
  try {
    const result = await runTask({ ...f.options, browserQa: { scenarioId: 'value-fixture', adapter: async r => {
      phases.push(r.phase);
      const checks = JSON.parse(readFileSync(join(f.options.stateDirectory, 'artifacts', r.phase === 'baseline' ? 'before-checks.json' : 'after-checks.json'), 'utf8'));
      assert.equal(checks[0].passed, r.phase === 'candidate');
      assert.equal(readFileSync(join(r.workspace, 'value.txt'), 'utf8'), r.phase === 'baseline' ? 'before' : 'after');
      assert.ok(r.signal instanceof AbortSignal); assert.equal(r.task.taskId, f.options.task.taskId);
      return report(r);
    } }, modelFactory: () => ({ complete: async (_instructions, input) => {
      if (calls === 2) {
        const packet = input as { browserQa: { baseline: { report: BrowserQaReport; reportSha256: string; artifactPath: string }; candidate: { report: BrowserQaReport; reportSha256: string; artifactPath: string } } };
        for (const evidence of Object.values(packet.browserQa)) {
          assert.equal(sha256(readFileSync(evidence.artifactPath)), evidence.reportSha256);
        }
        assert.equal(packet.browserQa.baseline.report.checks[0]!.passed, false);
        assert.equal(packet.browserQa.candidate.report.checks[0]!.passed, true);
      }
      return f.outputs[calls++];
    } }) });
    assert.equal(result.status, 'completed-local'); assert.equal(calls, 3); assert.deepEqual(phases, ['baseline', 'candidate']);
    const db = new DatabaseSync(join(f.options.stateDirectory, 'execution/policy/policy.sqlite'), { readOnly: true });
    try {
      const attempts = db.prepare('SELECT body FROM external_attempts').all().map(row => JSON.parse(row.body as string));
      const artifacts = attempts.filter(a => JSON.parse(a.envelopeJson).kind === 'artifact');
      assert.equal(artifacts.length, 2);
      const commands = attempts.filter(a => JSON.parse(a.envelopeJson).detail.action === 'browser-qa-handoff');
      assert.equal(commands.length, 2);
      for (const a of [...commands, ...artifacts]) {
        assert.equal(a.status, 'completed');
        assert.match(a.terminalEvidence.outputDigest, /^[a-f0-9]{64}$/);
      }
      for (const a of artifacts) assert.equal(JSON.parse(a.envelopeJson).detail.reportSha256, a.terminalEvidence.outputDigest);
    } finally { db.close(); }
  } finally { f.cleanup(); }
});

test('pinned host command integrates through automatic handoff into reviewer and durable receipts (synthetic, no browser)', {
  skip: process.platform !== 'darwin', timeout: 60000,
}, async () => {
  const f = browserQaFixture(); let calls = 0;
  try {
    const configPath = join(f.root, 'qa.json');
    const script = `const a=process.argv.slice(1), get=k=>a[a.indexOf(k)+1];
      process.stdout.write(JSON.stringify({version:1,phase:get('--phase'),workspace:get('--workspace'),
      taskId:get('--task-id'),scenarioId:get('--scenario-id'),baselineSource:get('--baseline-source'),
      currentSource:get('--source'),requestId:get('--request-id'),startedAt:Number(get('--requested-at')),
      completedAt:Date.now(),checks:[375,1280].map(viewportWidth=>({id:'fixture',viewportWidth,
      passed:get('--phase')==='candidate',detail:'Synthetic command fixture'}))}));`;
    writeFileSync(configPath, JSON.stringify({ version: 1, scenarioId: 'value-fixture', executable: process.execPath,
      args: ['-e', script.replace(/\n/g, ' '), '--'], timeoutMs: 2000, maxOutputBytes: 8192 }), { mode: 0o600 });
    const setup = loadBrowserQaConfiguration(configPath, f.workspace);
    const result = await runTask({ ...f.options, browserQa: setup, modelFactory: () => ({ complete: async (_instructions, input) => {
      if (calls === 2) {
        const packet = input as { browserQa: { candidate: { report: BrowserQaReport } } };
        assert.equal(packet.browserQa.candidate.report.checks.length, 2);
        assert.ok(packet.browserQa.candidate.report.checks.every(check => check.passed));
      }
      return f.outputs[calls++];
    } }) });
    assert.equal(result.status, 'completed-local'); assert.equal(calls, 3);
    const db = new DatabaseSync(join(f.options.stateDirectory, 'execution/policy/policy.sqlite'), { readOnly: true });
    try {
      const commands = db.prepare('SELECT body FROM external_attempts').all().map(row => JSON.parse(row.body as string))
        .filter(a => JSON.parse(a.envelopeJson).detail.action === 'browser-qa-handoff');
      assert.equal(commands.length, 2);
      for (const command of commands) {
        assert.deepEqual(JSON.parse(command.envelopeJson).detail.command, setup.command);
        assert.equal(command.status, 'completed');
        assert.equal(JSON.parse(command.envelopeJson).detail.command.configSha256, sha256(readFileSync(configPath)));
      }
    } finally { db.close(); }
  } finally { f.cleanup(); }
});

test('handoff itself detects a source callback that returns changed identity without throwing', async () => {
  const f = browserQaFixture(); let source = request.baselineSource;
  const finishes: string[] = [];
  try {
    const handoff = new BrowserQaHandoff({ setup: { scenarioId: 'fixture', adapter: async r => {
      source = request.currentSource; return report(r);
    } }, workspace: f.workspace, task: f.options.task, baselineSource: source, artifacts: f.root,
    source: () => source, signal: new AbortController().signal,
    authority: { reserve: () => ({ check: () => {}, finish: status => { finishes.push(status); } }) } });
    await assert.rejects(handoff.capture('baseline'), /source changed/);
    assert.deepEqual(finishes, ['failed']);
    assert.equal(existsSync(join(f.root, 'baseline-browser-qa.json')), false);
  } finally { f.cleanup(); }
});

for (const mode of ['throws', 'missing', 'empty', 'stale', 'schema', 'candidate-fail', 'source-drift', 'coverage', 'viewport', 'tamper-baseline'] as const) {
  test('configured handoff blocks before reviewer/publication: ' + mode + ' (fixtures)', { skip: process.platform !== 'darwin', timeout: 60000 }, async () => {
    const f = browserQaFixture(); f.options.task.draftPr = true; let calls = 0;
    try {
      await assert.rejects(runTask({ ...f.options, browserQa: { scenarioId: 'value-fixture', adapter: async r => {
        if (r.phase === 'baseline') return report(r);
        if (mode === 'throws') throw new Error('callback fixture failure');
        if (mode === 'missing') return;
        if (mode === 'empty') return { ...report(r), checks: [] };
        if (mode === 'stale') return { ...report(r), currentSource: r.baselineSource };
        if (mode === 'schema') return { ...report(r), executable: '/untrusted' };
        if (mode === 'candidate-fail') return { ...report(r), checks: [{ ...report(r).checks[0], passed: false }] };
        if (mode === 'source-drift') writeFileSync(join(r.workspace, 'value.txt'), 'drift');
        if (mode === 'tamper-baseline') writeFileSync(join(f.options.stateDirectory, 'artifacts/baseline-browser-qa.json'), '{}');
        if (mode === 'coverage') return { ...report(r), checks: [report(r).checks[0]] };
        if (mode === 'viewport') return { ...report(r), checks: report(r).checks.map(c => ({ ...c, viewportWidth: c.viewportWidth + 1 })) };
        return report(r);
      } }, modelFactory: () => ({ complete: async () => f.outputs[calls++] }) }));
      assert.equal(calls, 2); assert.equal(existsSync(join(f.options.stateDirectory, 'artifacts/review.json')), false);
      assert.equal(f.git('log', '-1', '--format=%s', 'task/browser-fixture'), 'synthetic fixture baseline');
    } finally { f.cleanup(); }
  });
}

test('invalid baseline stops implementation; failed candidate checks stop candidate QA (synthetic)', {
  skip: process.platform !== 'darwin', timeout: 60000,
}, async () => {
  for (const mode of ['baseline-invalid', 'candidate-check-fails'] as const) {
    const f = browserQaFixture(); let calls = 0; const phases: string[] = [];
    try {
      if (mode === 'candidate-check-fails') f.outputs[1]!.edits![0]!.content = 'still broken';
      await assert.rejects(runTask({ ...f.options, browserQa: { scenarioId: 'value-fixture', adapter: async r => {
        phases.push(r.phase);
        return mode === 'baseline-invalid' ? undefined : report(r);
      } }, modelFactory: () => ({ complete: async () => f.outputs[calls++] }) }));
      assert.deepEqual(phases, ['baseline']);
      assert.equal(calls, mode === 'baseline-invalid' ? 1 : 2);
      assert.equal(existsSync(join(f.options.stateDirectory, 'artifacts/review.json')), false);
      assert.equal(existsSync(join(f.options.stateDirectory, 'artifacts/candidate-browser-qa.json')), false);
    } finally { f.cleanup(); }
  }
});

test('non-UI execution without host QA remains compatible (synthetic)', {
  skip: process.platform !== 'darwin', timeout: 60000,
}, async () => {
  const f = browserQaFixture(); let calls = 0;
  try {
    const result = await runTask({ ...f.options, modelFactory: () => ({ complete: async (_instructions, input) => {
      if (calls === 2) assert.equal((input as { browserQa: unknown }).browserQa, null);
      return f.outputs[calls++];
    } }) });
    assert.equal(result.status, 'completed-local'); assert.equal(calls, 3);
    assert.equal(existsSync(join(result.artifacts, 'baseline-browser-qa.json')), false);
  } finally { f.cleanup(); }
});
for (const mode of ['missing', 'tamper', 'source-drift', 'stale'] as const) test('post-review evidence gate denies commit/publication: ' + mode + ' (fixtures)', {
  skip: process.platform !== 'darwin', timeout: 60000,
}, async t => {
  const f = browserQaFixture(); f.options.task.draftPr = true; let calls = 0;
  try {
    await assert.rejects(runTask({ ...f.options, browserQa: { scenarioId: 'value-fixture', adapter: async r => report(r) },
      modelFactory: () => ({ complete: async (_instructions, input) => {
        if (calls === 2) {
          const packet = input as { browserQa: { candidate: { artifactPath: string; report: BrowserQaReport } } };
          const candidate = packet.browserQa.candidate;
          if (mode === 'missing') rmSync(candidate.artifactPath);
          if (mode === 'tamper') writeFileSync(candidate.artifactPath, '{}');
          if (mode === 'source-drift') writeFileSync(join(candidate.report.workspace, 'value.txt'), 'drift');
          if (mode === 'stale') { const now = Date.now(); t.mock.method(Date, 'now', () => now + BROWSER_QA_MAX_AGE_MS + 1); }
        }
        return f.outputs[calls++];
      } }) }));
    assert.equal(calls, 3); assert.equal(existsSync(join(f.options.stateDirectory, 'artifacts/pr-body.md')), false);
    assert.equal(f.git('log', '-1', '--format=%s', 'task/browser-fixture'), 'synthetic fixture baseline');
  } finally { t.mock.restoreAll(); f.cleanup(); }
});

test('missing required pair is denied and uncooperative callback cancellation returns promptly (fixture)', async () => {
  const f = browserQaFixture(), controller = new AbortController();
  const handoff = new BrowserQaHandoff({ setup: { scenarioId: 'fixture', adapter: async () => new Promise(() => {}) },
    workspace: f.workspace, task: f.options.task, baselineSource: request.baselineSource,
    artifacts: f.root, source: () => request.baselineSource, signal: controller.signal,
    authority: { reserve: () => ({ check: () => {}, finish: () => {} }) } });
  try {
    assert.throws(() => handoff.assertCurrent(), /missing/);
    const running = handoff.capture('baseline'); controller.abort();
    await assert.rejects(running, /cancelled/);
  } finally { f.cleanup(); }
});
