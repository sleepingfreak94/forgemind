import test from 'node:test';
import assert from 'node:assert/strict';
import { createQualificationReport, verifyQualificationReport, qualificationHash } from '../../src/live-workflow/qualification.js';
import { textHash, canonical, assertJson, parseQualificationJson } from '../../src/live-workflow/qualification-validation.js';
import type { QualificationOptions, QualificationArtifact, QualificationReport } from '../../src/live-workflow/qualification-contracts.js';
import type { NativeExecutor } from '../../src/live-workflow/native-executor.js';
import { NativeProviderError } from '../../src/live-workflow/native-executor.js';
import { nativeFailureCode } from '../../src/live-workflow/native-executor-run.js';
import { runtimeReceiptFixture, ownerTransitionFixture } from './qualification-native-fixtures.js';

const source = textHash('candidate'), baseline = textHash('baseline'), parent = textHash('parent'), runtime = textHash('runtime');
const marker = 'PRIVATE_PROVIDER_TRANSCRIPT_CREDENTIAL';
const now = 1000;
const build = { schema: 'qualification-build-v1', source, artifacts: [{ id: 'library', path: '/build/library.js', sha256: textHash('library') }] } as const;
const check = { id: 'strict', passed: true, exitCode: 0, stdout: marker, stderr: marker } as const;
function terminal(output: unknown, at = source, taskId = 'task', id = 'check-terminal', passed = true) {
  return { id, event: 'external.finished', timestamp: 900, principalId: 'owner', sessionId: 'session', policyVersion: 'v1',
    sourceSnapshot: at, taskId, invocationId: id + '-invocation', outcome: passed ? 'completed' : 'failed', reason: marker,
    terminalEvidence: { viewDigest: textHash('envelope'), outputDigest: textHash(JSON.stringify(output)) } } as const;
}
function artifact(name: QualificationArtifact['name'], value: unknown, at = source): QualificationArtifact {
  const json = JSON.stringify(value, null, 2) + '\n';
  return { name, source: at, sha256: textHash(json), json };
}
const reviewArtifact = artifact('review.json', { verdict: 'pass', findings: [], acceptance: ['bounded consistency'], source });
const review = { schema: 'qualification-review-v1', taskId: 'task', source, reviewer: 'reviewer', implementer: 'coder', createdAt: 900, expiresAt: 1800, artifact: reviewArtifact } as const;
function nativeFixture() {
  const task = { project: 'project', task: 'task', source, root: '/workspace', model: 'gpt-6.1-sol', effort: 'medium',
    readPaths: ['file.ts'], writePaths: ['file.ts'], checks: [{ id: 'strict', executable: '/node', args: [], timeoutMs: 100 }],
    budget: { runtimeMs: 5000, turns: null, toolCalls: null, inputBytes: 10000, resultBytes: 10000, wireBytes: 10000, outputBytes: 10000, retries: 0 } } as const;
  const checkpoint = { schema: 'native-session-v2', binding: textHash(JSON.stringify({ ...task, source: undefined, authorityBinding: parent })), source,
    thread: marker, stage: 'host_check', pending: null, seen: ['call-1'],
    counters: { runtimeMs: 10, turns: 1, toolCalls: 1, inputBytes: 1, resultBytes: 1, wireBytes: 1, outputBytes: 1, retries: 0 }, status: 'stopped' } as const;
  const receiptAdditions:Pick<NativeExecutor['receipt'],'checkpointUncertain'|'finalResult'>={checkpointUncertain:false,finalResult:null};
  const result = { taskId: 'task', status: 'completed', source,
    readiness: { ready: true, qualification: 'native-seatbelt', acceptedBudget: true, evidence: { runtimeBinding: runtime, executableDigest: textHash('executable'), profileDigest: textHash('profile') }, reasons: [], observed: ['tokenUsage'], unavailable: [] },
    checks: [check], executionLease: { id: 'execution', deadline: 1500, runtime, status: 'completed' },
    native: { ...receiptAdditions, checkpoint, qualification: 'native-seatbelt', observedTokenUsage: { total: { inputTokens: 12, outputTokens: 4, totalTokens: 16, prompt: marker }, transcript: marker }, nativeDiagnostic: null, unavailable: [] },
    owner: { source, phases: [], receipts: [terminal(check)] },
    runtime: { fencingEpoch: 1, leaseId: 'lease', runtimes: [{ id: 'runtime-receipt', binding: runtime, status: 'completed' }], receipts: runtimeReceiptFixture(runtime) } } as const;
  return { schema: 'qualification-input-v1', taskId: 'task', projectId: 'project', source, fixture: false, requiredChecks: ['strict'], nativeTask: task, parentBinding: parent, result } as const;
}
function supervisedFixture() {
  const phases = [
    { seq: 1, name: 'worktree', source: baseline, data: JSON.stringify({ root: '/workspace', branch: 'ticket', base: 'head' }) },
    { seq: 2, name: 'candidate', source, data: JSON.stringify({ summary: marker, paths: ['file.ts'] }) },
    { seq: 3, name: 'reviewed', source, data: JSON.stringify({ verdict: 'pass' }) },
  ];
  return { schema: 'qualification-input-v1', taskId: 'task', projectId: 'project', source, fixture: false, requiredChecks: ['strict'],
    receipt: { taskId: 'task', run: { id: 'task', status: 'completed', requests: 3, input_bytes: 500 }, phases,
      receipts: [terminal(check), terminal(check, baseline, 'task', 'baseline-terminal')] },
    artifacts: [artifact('before-checks.json', [check], baseline), artifact('after-checks.json', [check]), reviewArtifact] } as const;
}
function options(input: unknown = nativeFixture(), mode: 'native' | 'supervised' = 'native'): QualificationOptions {
  return { mode, input, build, review, expectedSource: source, createdAt: now, expiresAt: 1700, now };
}
function rehash(report: QualificationReport, changes: Record<string, unknown>): unknown {
  const { digest: _digest, ...body } = report;
  const changed = { ...body, ...changes };
  return { ...changed, digest: qualificationHash(changed) };
}
function invalid(action: () => unknown) { assert.throws(action, { message: 'Invalid historical qualification evidence' }); }

test('native completed history accepts stopped cleanup checkpoint and stays historical, immutable and sanitized', () => {
  const report = createQualificationReport(options());
  assert.equal(report.outcome, 'completed-scoped'); assert.equal(report.executionConsistent, true);
  assert.equal(report.authority, 'none'); assert.equal(report.scope, 'historical-evidence-consistency');
  assert.equal(report.build.classification, 'reported'); assert.equal(report.limitations.deployment, 'unqualified');
  assert.ok(Object.isFrozen(report)); assert.ok(Object.isFrozen(report.checks)); assert.ok(Object.isFrozen(report.build.artifacts[0]));
  assert.equal(JSON.stringify(report).includes(marker), false);
  assert.deepEqual(verifyQualificationReport(JSON.stringify(report), source, now), { integrity: 'consistent', classification: 'imported', authority: 'none', source, digest: report.digest, outcome: 'completed-scoped' });
  assert.notEqual(report.digest, textHash(JSON.stringify(report)));
});
test('native completion alone never implies independent review', () => {
  const { review: _review, ...o } = options();
  const report = createQualificationReport(o);
  assert.equal(report.executionConsistent, true); assert.equal(report.outcome, 'partial'); assert.equal(report.review.classification, 'unavailable');
});
test('native cleanup requires completed execution lease and runtime at exact readiness binding', () => {
  const f = nativeFixture();
  const variants = [
    { ...f.result, executionLease: { ...f.result.executionLease, status: 'failed' } },
    { ...f.result, executionLease: { ...f.result.executionLease, runtime: baseline } },
    { ...f.result, runtime: { ...f.result.runtime, runtimes: [] } },
    { ...f.result, runtime: { ...f.result.runtime, runtimes: [{ ...f.result.runtime.runtimes[0], id: 'row', binding: baseline, status: 'completed' }] } },
    { ...f.result, runtime: { ...f.result.runtime, receipts: [] } },
    { ...f.result, native: { ...f.result.native, checkpoint: { ...f.result.native.checkpoint, status: 'indeterminate' } } },
    { ...f.result, native: { ...f.result.native, checkpoint: { ...f.result.native.checkpoint, pending: 'effect' } } },
  ];
  for (const result of variants) assert.equal(createQualificationReport(options({ ...f, result })).outcome, 'partial');
});
test('missing readiness pins and boolean flags alone stay partial', () => {
  const f = nativeFixture();
  for (const readiness of [{ ready: true, qualification: 'native-seatbelt', acceptedBudget: true }, { ...f.result.readiness, evidence: null }, { ...f.result.readiness, ready: false }]) {
    assert.equal(createQualificationReport(options({ ...f, result: { ...f.result, readiness } })).outcome, 'partial');
  }
});
test('required checks are unique and complete; all candidate failures prevent completion', () => {
  const f = nativeFixture();
  assert.equal(createQualificationReport(options({ ...f, requiredChecks: ['strict', 'missing'] })).outcome, 'partial');
  invalid(() => createQualificationReport(options({ ...f, requiredChecks: [] })));
  invalid(() => createQualificationReport(options({ ...f, requiredChecks: ['strict', 'strict'] })));
  invalid(() => createQualificationReport(options({ ...f, result: { ...f.result, checks: [check, check] } })));
  const failed = { ...check, passed: false, exitCode: 1 };
  const report = createQualificationReport(options({ ...f, result: { ...f.result, checks: [failed], owner: { ...f.result.owner, receipts: [terminal(failed, source, 'task', 'failed', false)] } } }));
  assert.equal(report.outcome, 'partial'); assert.equal(report.checks[0]?.receiptBound, true);
});
test('checks bind exact full CheckResult bytes and source/task terminal evidence', () => {
  const f = nativeFixture();
  for (const rows of [[], [terminal(check, baseline)], [terminal(check, source, 'other')], [terminal({ ...check, stdout: 'different' })]]) {
    const report = createQualificationReport(options({ ...f, result: { ...f.result, owner: { ...f.result.owner, receipts: rows } } }));
    assert.equal(report.checks[0]?.receiptBound, false); assert.equal(report.outcome, 'partial');
  }
  const compiled = { ...check, stages: [{ id: 'compile', elapsedMs: 1.25, passed: true }], artifactManifest: { sha256: textHash('compiled') } };
  const report = createQualificationReport(options({ ...f, result: { ...f.result, checks: [compiled], owner: { ...f.result.owner, receipts: [terminal(compiled)] } } }));
  assert.equal(report.outcome, 'completed-scoped'); assert.equal(report.checks[0]?.digest, textHash(JSON.stringify(compiled)));
  assert.equal(JSON.stringify(report).includes('elapsedMs'), false);
});
test('caller receiptBound boolean cannot substitute for terminal binding', () => {
  const f = nativeFixture();
  invalid(() => createQualificationReport(options({ ...f, result: { ...f.result, checks: [{ ...check, receiptBound: true }] } })));
});
test('actual NativeOwner transition exports parse honestly partial without UUID-to-policy association', () => {
  const f = nativeFixture(), { task, exported } = ownerTransitionFixture(baseline, source);
  const checkpoint = { ...f.result.native.checkpoint, binding: textHash(JSON.stringify({ ...task, source: undefined, authorityBinding: parent })) };
  const body = { schema: 'native-final-text-v1', trust: 'evidence-only', source, turnId: marker, messages: [{ id: marker, text: marker }] };
  const native = { ...f.result.native, checkpoint, finalResult: { ...body, digest: textHash(JSON.stringify(body)) } };
  const owner = { ...exported, receipts: [...exported.receipts, terminal(check)] };
  const changed = { ...f, fixture: true, nativeTask: task, result: { ...f.result, native, owner } };
  assert.ok(exported.phases.every(p => !exported.receipts.some(r => r.id === p.id)));
  const report = createQualificationReport(options(changed));
  assert.equal(report.outcome, 'partial'); assert.equal(report.execution.sourceBound, false);
  assert.equal(report.executionConsistent, false); assert.equal(report.authority, 'none');
  assert.equal(report.checks[0]?.receiptBound, true); assert.equal(JSON.stringify(report).includes(marker), false);
  assert.equal(verifyQualificationReport(report, source, now).integrity, 'consistent');
  for (const phases of [[], exported.phases.slice(1)]) {
    const input = { ...changed, result: { ...changed.result, owner: { ...owner, phases } } };
    if (!phases.length) assert.equal(createQualificationReport(options(input)).outcome, 'partial');
    else invalid(() => createQualificationReport(options(input)));
  }
  const first = exported.phases[0]!;
  for (const phases of [
    [...exported.phases].reverse(), [first, first], exported.phases.slice(0, 1),
    [{ ...first, before_source: source }, exported.phases[1]],
    [{ ...first, after_source: 'not-a-digest' }, exported.phases[1]],
    [{ ...first, data: JSON.stringify({ transitionReceiptId: 'detached', before: baseline, source: first.after_source }) }, exported.phases[1]],
    [{ ...first, data: JSON.stringify({ transitionReceiptId: first.id, before: source, source: first.after_source }) }, exported.phases[1]],
    [{ ...first, data: JSON.stringify({ transitionReceiptId: first.id, before: baseline, source }) }, exported.phases[1]],
    [{ seq: 1, name: 'source-transition', source, data: '{}' }],
  ]) invalid(() => createQualificationReport(options({ ...changed, result: { ...changed.result, owner: { ...owner, phases } } })));
});
test('all original native checks are mandatory even when requiredChecks selects only A', () => {
  const f = nativeFixture(), second = { ...check, id: 'second' };
  const task = { ...f.nativeTask, checks: [...f.nativeTask.checks, { ...f.nativeTask.checks[0], id: 'second' }] };
  const checkpoint = { ...f.result.native.checkpoint, binding: textHash(JSON.stringify({ ...task, source: undefined, authorityBinding: parent })) };
  const result = { ...f.result, native: { ...f.result.native, checkpoint } };
  const input = { ...f, nativeTask: task, result };
  const missing = createQualificationReport(options(input));
  assert.equal(missing.outcome, 'partial'); assert.equal(missing.executionConsistent, false);
  assert.ok(missing.native.classification !== 'unavailable' && !missing.native.completed);
  const full = { ...input, result: { ...result, checks: [check, second], owner: { ...result.owner, receipts: [terminal(check), terminal(second, source, 'task', 'second-terminal')] } } };
  assert.equal(createQualificationReport(options(full)).outcome, 'completed-scoped');
  const failed = { ...second, passed: false, exitCode: 1 };
  for (const changed of [
    { ...full.result, owner: { ...full.result.owner, receipts: [terminal(check)] } },
    { ...full.result, checks: [check, failed], owner: { ...full.result.owner, receipts: [terminal(check), terminal(failed, source, 'task', 'second-terminal', false)] } },
  ]) {
    const report = createQualificationReport(options({ ...input, result: changed }));
    assert.equal(report.outcome, 'partial'); assert.equal(report.executionConsistent, false);
    assert.ok(report.native.classification !== 'unavailable' && !report.native.completed);
  }
});
test('runtime cleanup binds the exact allowing decision and terminal to the lifecycle lease', () => {
  const f = nativeFixture(), r = f.result.runtime;
  const [decision, terminalRow] = runtimeReceiptFixture(runtime);
  assert.ok(decision && terminalRow);
  assert.notEqual(f.result.executionLease.id, r.leaseId);
  assert.notEqual(terminalRow.terminalEvidence?.viewDigest, decision.resource.slice(5));
  const partial = (runtimeExport: unknown) => {
    const report = createQualificationReport(options({ ...f, result: { ...f.result, runtime: runtimeExport } }));
    assert.equal(report.outcome, 'partial'); assert.equal(report.execution.cleanup, 'unavailable');
    assert.equal(report.executionConsistent, false);
    assert.ok(report.native.classification !== 'unavailable' && !report.native.completed);
  };
  partial({ ...r, leaseId: 'detached' });
  partial({ ...r, runtimes: [{ ...r.runtimes[0], id: 'detached' }] });
  partial({ ...r, runtimes: [{ ...r.runtimes[0], status: 'failed' }] });
  for (const receipts of [
    [terminalRow], [decision], [{ ...decision, outcome: 'deny' }, terminalRow],
    [decision, { ...terminalRow, outcome: 'failed' }],
    [decision, { ...terminalRow, terminalEvidence: undefined }].map(row => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined))),
    [decision, { ...terminalRow, timestamp: decision.timestamp - 1 }],
    [decision, terminalRow, { ...decision, id: 'duplicate-decision' }],
    [decision, terminalRow, { ...terminalRow, id: 'duplicate-terminal' }],
    [decision, terminal({ plan: true }, runtime, 'task', 'unrelated-terminal')],
  ]) partial({ ...r, receipts });
  for (const key of ['requestId', 'grantId', 'invocationId', 'resource', 'action', 'requestDigest', 'taskId', 'sourceSnapshot', 'principalId', 'sessionId', 'policyVersion']) {
    const value = key === 'requestDigest' || key === 'sourceSnapshot' ? baseline : key === 'action' ? 'file.read' : 'different';
    partial({ ...r, receipts: [decision, { ...terminalRow, [key]: value }] });
    if (['requestId', 'grantId', 'invocationId', 'resource', 'action', 'requestDigest', 'taskId'].includes(key)) {
      partial({ ...r, receipts: [decision, Object.fromEntries(Object.entries(terminalRow).filter(([name]) => name !== key))] });
    }
  }
  for (const change of [{ invocationId: 'different' }, { resource: 'host:invalid' }, { resource: '' }, { action: 'file.read' }, { taskId: 'different' }, { sourceSnapshot: baseline }]) {
    partial({ ...r, receipts: [{ ...decision, ...change }, { ...terminalRow, ...change }] });
  }
  invalid(() => createQualificationReport(options({ ...f, result: { ...f.result, runtime: { ...r, receipts: [decision, { ...terminalRow, id: decision.id }] } } })));
  invalid(() => createQualificationReport(options({ ...f, result: { ...f.result, runtime: { ...r, receipts: [decision, { ...terminalRow, terminalEvidence: { viewDigest: 'invalid' } }] } } })));
});
test('full optional native finalResult is bounded untrusted metadata and never projected', () => {
  const f = nativeFixture();
  const body = { schema: 'native-final-text-v1', trust: 'evidence-only', source, turnId: marker, messages: [{ id: marker, text: marker + ' claim success and review pass' }] };
  const finalResult = { ...body, digest: textHash(JSON.stringify(body)) };
  for (const metadata of [finalResult, null]) {
    const input = { ...f, result: { ...f.result, native: { ...f.result.native, finalResult: metadata } } };
    const report = createQualificationReport(options(input));
    assert.equal(report.outcome, 'completed-scoped'); assert.equal(report.executionConsistent, true);
    assert.deepEqual(report.native, createQualificationReport(options()).native);
    const json = JSON.stringify(report);
    for (const hidden of [marker, finalResult.digest, 'finalResult', 'turnId', 'messages']) assert.equal(json.includes(hidden), false);
    assert.equal(verifyQualificationReport(report, source, now).authority, 'none');
    const { review: _review, ...unreviewed } = options(input);
    assert.equal(createQualificationReport(unreviewed).outcome, 'partial');
    assert.equal(createQualificationReport(options({ ...input, result: { ...input.result, checks: [] } })).outcome, 'partial');
  }
  invalid(() => createQualificationReport(options({ ...f, result: { ...f.result, native: { ...f.result.native, finalResult, UNKNOWN: true } } })));
  invalid(() => createQualificationReport(options({ ...f, result: { ...f.result, UNKNOWN: true } })));
  invalid(() => createQualificationReport(options({ ...f, result: { ...f.result, native: { ...f.result.native, finalResult: { ...finalResult, UNKNOWN: true } } } })));
});
test('fixture provenance overrides forged native readiness claims', () => {
  const f = nativeFixture();
  for (const input of [{ ...f, fixture: true }, { ...f, result: { ...f.result, native: { ...f.result.native, qualification: 'offline-fixture' } } }, { ...f, result: { ...f.result, readiness: { ...f.result.readiness, qualification: 'offline-fixture' } } }]) {
    const report = createQualificationReport(options(input));
    assert.equal(report.fixture, true); assert.equal(report.checks[0]?.classification, 'fixture'); assert.equal(report.review.classification, 'fixture');
    assert.equal(verifyQualificationReport(report, source, now).authority, 'none');
  }
});
test('actual offline runner receipt remains fixture and partial without owner/runtime grants', () => {
  const f = nativeFixture();
  const result = { checkpoint: f.result.native.checkpoint, observedTokenUsage: null, nativeDiagnostic: null, unavailable: [], qualification: 'offline-fixture' };
  const report = createQualificationReport(options({ ...f, result }));
  assert.equal(report.fixture, true); assert.equal(report.outcome, 'partial');
});
test('same actor, unknown implementer, expired, future and nonpass review stay incomplete', () => {
  for (const r of [{ ...review, implementer: 'reviewer' }, { ...review, implementer: null }, { ...review, expiresAt: now }, { ...review, createdAt: now + 1 },
    { ...review, artifact: artifact('review.json', { verdict: 'blocked', findings: [marker], source }) }]) {
    assert.equal(createQualificationReport({ ...options(), review: r }).outcome, 'partial');
  }
});
test('source, task, parent/checkpoint and build mismatches are rejected safely', () => {
  const f = nativeFixture();
  for (const input of [{ ...f, source: baseline }, { ...f, taskId: 'wrong' }, { ...f, projectId: 'wrong' }, { ...f, parentBinding: baseline },
    { ...f, result: { ...f.result, taskId: 'wrong' } }, { ...f, result: { ...f.result, source: baseline } },
    { ...f, result: { ...f.result, native: { ...f.result.native, checkpoint: { ...f.result.native.checkpoint, source: baseline } } } }]) invalid(() => createQualificationReport(options(input)));
  invalid(() => createQualificationReport({ ...options(), build: { ...build, source: baseline } }));
  invalid(() => createQualificationReport({ ...options(), review: { ...review, taskId: 'wrong' } }));
  invalid(() => createQualificationReport({ ...options(), review: { ...review, source: baseline } }));
});
test('build requires nonempty unique exact pins with safe paths and nonzero digests', () => {
  const pin = build.artifacts[0];
  for (const artifacts of [[], [pin, pin], [{ ...pin, path: '/build/../escape' }], [{ ...pin, path: 'relative' }], [{ ...pin, sha256: '0'.repeat(64) }], [{ ...pin, path: '/build//bad' }]]) {
    invalid(() => createQualificationReport({ ...options(), build: { ...build, artifacts } }));
  }
});
test('supervised imports actual run shape and exact before/candidate/review byte pins', () => {
  const f = supervisedFixture(), report = createQualificationReport(options(f, 'supervised'));
  assert.equal(report.outcome, 'completed-scoped'); assert.equal(report.baselineChecks[0]?.source, baseline); assert.equal(report.checks[0]?.source, source);
  assert.equal(report.artifacts.find(a => a.name === 'review.json')?.digest, reviewArtifact.sha256);
  assert.equal(JSON.stringify(report).includes(marker), false); assert.equal(verifyQualificationReport(report, source, now).classification, 'imported');
});
test('supervised failed/blocked/running status retains checks but never completion', () => {
  const f = supervisedFixture();
  for (const status of ['failed', 'blocked', 'running']) {
    const report = createQualificationReport(options({ ...f, receipt: { ...f.receipt, run: { ...f.receipt.run, status } } }, 'supervised'));
    assert.equal(report.outcome, 'partial'); assert.equal(report.checks[0]?.passed, true);
  }
});
test('supervised setup failure uses session.started source without inventing candidate or review', () => {
  const f = supervisedFixture();
  const input = { ...f, receipt: { ...f.receipt, run: { ...f.receipt.run, status: 'failed' }, phases: [], receipts: [{ ...terminal(check), event: 'session.started' }] }, artifacts: [] };
  const report = createQualificationReport(options(input, 'supervised'));
  assert.equal(report.outcome, 'partial'); assert.equal(report.execution.sourceBound, true); assert.equal(report.review.classification, 'unavailable'); assert.deepEqual(report.checks, []);
});
test('supervised missing candidate artifact/terminal/review evidence stays partial', () => {
  const f = supervisedFixture();
  for (const input of [{ ...f, artifacts: f.artifacts.filter(a => a.name !== 'after-checks.json') }, { ...f, artifacts: f.artifacts.filter(a => a.name !== 'review.json') },
    { ...f, receipt: { ...f.receipt, receipts: [] } }]) assert.equal(createQualificationReport(options(input, 'supervised')).outcome, 'partial');
});
test('supervised source/phase/artifact/review mismatch and duplicate phases deny', () => {
  const f = supervisedFixture();
  for (const input of [
    { ...f, artifacts: f.artifacts.map(a => a.name === 'after-checks.json' ? { ...a, source: baseline } : a) },
    { ...f, artifacts: f.artifacts.map(a => a.name === 'review.json' ? { ...a, json: a.json + ' ' } : a) },
    { ...f, artifacts: [...f.artifacts, reviewArtifact] },
    { ...f, receipt: { ...f.receipt, phases: [...f.receipt.phases].reverse() } },
    { ...f, receipt: { ...f.receipt, phases: [...f.receipt.phases, { seq: 4, name: 'candidate', source, data: '{}' }] } },
    { ...f, receipt: { ...f.receipt, phases: f.receipt.phases.map(p => p.name === 'candidate' ? { ...p, source: baseline } : p) } },
    { ...f, artifacts: f.artifacts.map(a => a.name === 'review.json' ? artifact('review.json', { verdict: 'revise', findings: [], source }) : a) },
  ]) invalid(() => createQualificationReport(options(input, 'supervised')));
});
test('review accepts bounded optional acceptance only and pins exact bytes', () => {
  invalid(() => createQualificationReport({ ...options(), review: { ...review, artifact: artifact('review.json', { verdict: 'pass', findings: [], source, unrelated: true }) } }));
  invalid(() => createQualificationReport({ ...options(), review: { ...review, artifact: artifact('review.json', { verdict: 'pass', findings: [], source, acceptance: Array(129).fill('x') }) } }));
  invalid(() => createQualificationReport({ ...options(), review: { ...review, artifact: { ...reviewArtifact, sha256: baseline } } }));
});
test('rawInput must parse exactly input and original byte formatting determines digest', () => {
  const f = nativeFixture(), rawInput = JSON.stringify(f, null, 2) + '\n';
  const report = createQualificationReport({ ...options(f), rawInput });
  assert.equal(report.input.digest, textHash(rawInput)); assert.equal(report.input.encoding, 'utf8-json');
  assert.equal(createQualificationReport(options(f)).input.digest, qualificationHash(f));
  invalid(() => createQualificationReport({ ...options(f), rawInput: JSON.stringify({ ...f, fixture: true }) }));
  invalid(() => createQualificationReport({ ...options(f), rawInput: '{}' }));
});
test('general bounded decimal metadata is accepted but timestamps, counters and budgets stay integral', () => {
  assert.doesNotThrow(() => assertJson({ elapsedMs: 1.125 }));
  invalid(() => createQualificationReport({ ...options(), createdAt: 999.5 }));
  const f = nativeFixture();
  invalid(() => createQualificationReport(options({ ...f, nativeTask: { ...f.nativeTask, budget: { ...f.nativeTask.budget, runtimeMs: 1.5 } } })));
  invalid(() => createQualificationReport(options({ ...f, result: { ...f.result, native: { ...f.result.native, checkpoint: { ...f.result.native.checkpoint, counters: { ...f.result.native.checkpoint.counters, turns: 1.5 } } } } })));
});
test('accessors, toJSON, unsafe prototypes, symbols, extra fields and oversized input never execute code', () => {
  let calls = 0;
  const getter = Object.defineProperty({}, 'source', { enumerable: true, get() { calls++; return source; } });
  const toJSON = { toJSON() { calls++; return {}; } };
  for (const input of [getter, toJSON, Object.create({ source }), { ...nativeFixture(), [Symbol('secret')]: true }, { ...nativeFixture(), extra: true }]) invalid(() => createQualificationReport(options(input)));
  assert.equal(calls, 0);
  for (const value of [Infinity, NaN, -0, new Date(), new Array(2), Array(4097).fill(null), 'x'.repeat(2 * 1024 * 1024 + 1)]) invalid(() => assertJson(value));
  invalid(() => parseQualificationJson('{bad json'));
});
test('productionReady true is rejected at any nested imported location', () => {
  const f = nativeFixture();
  invalid(() => createQualificationReport(options({ ...f, result: { ...f.result, native: { ...f.result.native, observedTokenUsage: { metadata: { productionReady: true } } } } })));
});
test('report digest tampering, lifetime and expected source mismatches deny', () => {
  const report = createQualificationReport(options());
  invalid(() => verifyQualificationReport({ ...report, taskId: 'tampered' }, source, now));
  invalid(() => verifyQualificationReport(report, baseline, now));
  invalid(() => verifyQualificationReport(report, source, report.expiresAt));
  invalid(() => verifyQualificationReport(report, source, report.createdAt - 1));
});
test('rehashed semantic contradictions cannot invent authority, completion, review or unavailable limits', () => {
  const report = createQualificationReport(options());
  const n = report.native;
  assert.notEqual(n.classification, 'unavailable');
  for (const changes of [{ authority: 'host' }, { outcome: 'partial' }, { executionConsistent: false }, { fixture: true },
    { checks: report.checks.map(c => ({ ...c, receiptBound: false })) },
    { review: { ...report.review, independent: false } }, { native: { ...n, pending: true } },
    { native: { ...n, observedTokens: { hardProviderRequestCount: 3 } } },
    { limitations: { ...report.limitations, hardBillingCap: 'enforced' } }, { findings: [] }, { extra: true }]) invalid(() => verifyQualificationReport(rehash(report, changes), source, now));
  assert.equal(verifyQualificationReport(rehash(report, {}), source, now).authority, 'none');
});
test('safe provider quota, rate and authentication diagnostics preserve failure without remote text or retries', () => {
  const f = nativeFixture();
  for (const [info, expected] of [['usageLimitExceeded', 'native-provider-quota'], ['rateLimitExceeded', 'native-provider-rate-limit'], ['unauthorized', 'native-provider-unauthorized'], [{ httpConnectionFailed: { httpStatusCode: 401 } }, 'native-provider-unauthorized']] as const) {
    const error = new NativeProviderError({ message: marker, additionalDetails: marker, codexErrorInfo: info }, false);
    assert.equal(nativeFailureCode(error), expected);
    const result = { phase: 'native-turn', code: nativeFailureCode(error), receipts: { checkpoint: f.result.native.checkpoint, nativeDiagnostic: error.diagnostic, owner: f.result.owner } };
    const report = createQualificationReport(options({ ...f, result }));
    assert.equal(report.outcome, 'partial'); assert.equal(JSON.stringify(report).includes(marker), false);
    if (report.native.classification !== 'unavailable') { assert.equal(report.native.failure?.code, expected); assert.equal(report.native.failure?.diagnostic?.willRetry, false); }
  }
});
test('canonical digest ignores object insertion order while full check output digest does not', () => {
  assert.equal(canonical({ b: 1, a: 2 }), canonical({ a: 2, b: 1 }));
  const f = nativeFixture(), reordered = { stderr: check.stderr, stdout: check.stdout, exitCode: 0, passed: true, id: 'strict' };
  assert.notEqual(textHash(JSON.stringify(reordered)), textHash(JSON.stringify(check)));
  const report = createQualificationReport(options({ ...f, result: { ...f.result, checks: [reordered] } }));
  assert.equal(report.outcome, 'partial');
});

test('private capture and failure context additions do not change public qualification projection',()=>{
 const f=nativeFixture();
 const base=createQualificationReport(options(f));
 const success=createQualificationReport(options({...f,result:{...f.result,capture:{directory:marker,status:'accepted'}}}));
 const projection=(report:typeof base)=>{const {input,digest,...visible}=report;return visible;};
 assert.notEqual(success.input.digest,base.input.digest);assert.notEqual(success.digest,base.digest);
 assert.deepEqual(projection(success),projection(base));assert(!JSON.stringify(success).includes(marker));
 const error=new NativeProviderError({codexErrorInfo:'other'},false);
 const result={phase:'native-turn',code:'native-provider-error',receipts:{checkpoint:f.result.native.checkpoint,nativeDiagnostic:error.diagnostic,owner:f.result.owner}};
 const prior=createQualificationReport(options({...f,result}));
 const candidate=createQualificationReport(options({...f,result:{...result,receipts:{...result.receipts,
  checkpointUncertain:false,checks:null,verificationChecks:null,
  failureContext:{schemaVersion:1,origin:'turn-completed',parseStatus:'provider-other',nativeCliVersion:'0.162.1',lastTool:'host_read'},
  capture:{directory:marker,status:'incomplete'}}}}));
 assert.notEqual(candidate.input.digest,prior.input.digest);assert.notEqual(candidate.digest,prior.digest);
 assert.deepEqual(projection(candidate),projection(prior));assert(!JSON.stringify(candidate).includes(marker));
 assert.deepEqual(Object.keys(error.diagnostic).sort(),['httpStatusCode','kind','willRetry']);
});

test('producer checkpoint uncertainty imports false, retains legacy omission, and prevents settled completion when true',()=>{
 const f=nativeFixture();
 for(const flag of [undefined,false,true]){
  const {checkpointUncertain:omitted,...legacy}=f.result.native;
  const native=flag===undefined?legacy:{...legacy,checkpointUncertain:flag};
  for(const result of [{...f.result,native},{...f.result,...native,native:undefined}]){
   // JSON matches the actual exported envelope: omitted optional fields disappear.
   const input=JSON.parse(JSON.stringify({...f,result}));
   const report=createQualificationReport(options(input));
   assert.equal(report.outcome,flag===true?'partial':'completed-scoped');
   assert.equal(report.execution.cleanup,flag===true?'unavailable':'reported-settled');
   if(report.native.classification!=='unavailable')assert.equal(report.native.completed,flag!==true);
  }
 }
 for(const flag of [null,0,1,'false',{}]){
  invalid(()=>createQualificationReport(options({...f,result:{...f.result,native:{...f.result.native,checkpointUncertain:flag}}})));
  invalid(()=>createQualificationReport(options({...f,result:{...f.result,checkpointUncertain:flag}})));
 }
 invalid(()=>createQualificationReport(options({...f,result:{...f.result,native:{...f.result.native,UNKNOWN:true}}})));
 const result={phase:'cleanup',code:'native-capture-unavailable',receipts:{checkpoint:f.result.native.checkpoint,
  checkpointUncertain:true,executionLease:f.result.executionLease,owner:f.result.owner,runtime:f.result.runtime,nativeDiagnostic:null}};
 const failed=createQualificationReport(options({...f,result}));assert.equal(failed.outcome,'partial');assert.equal(failed.execution.cleanup,'unavailable');
});
