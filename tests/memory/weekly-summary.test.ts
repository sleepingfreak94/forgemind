import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, sep } from 'node:path';
import { RunHistory } from '../../src/memory/run-history.js';
import { bytes, digest, serialize } from '../../src/context-engine/validation.js';
import { createWeeklyAccumulator, appendWeeklyRecords, finishWeeklySummary, validateWeeklySummary } from '../../src/memory/weekly-summary.js';
import type { Accumulator, WeeklyOptions, WeeklyScope } from '../../src/memory/weekly-summary.js';
import type { RunCheck, RunRecord, TerminalRunInput } from '../../src/memory/run-contracts.js';
import { fixture } from './fixture.js';

function present<T>(value: T | undefined): T { assert.ok(value !== undefined); return value; }
function at<T>(values: readonly T[], index: number): T { return present(values[index]); }
function input(n: number, execution: 'authenticated' | 'fixture' = 'authenticated', paths = ['src/example.ts']): TerminalRunInput {
  const source = digest('source'), candidate = digest('candidate');
  return { schemaVersion: 1, runId: digest(`run-${n}`), taskId: `task-${n}`, execution, startedAt: 10, endedAt: 20,
    outcome: 'completed', lastPhase: 'terminal', baselineSource: source, candidateSource: candidate, changedPaths: paths,
    checks: [{ phase: 'baseline', id: 'baseline', outcome: 'failed', exitCode: 1, source, evidenceSha256: digest('baseline evidence') },
      { phase: 'candidate', id: 'candidate', outcome: 'passed', exitCode: 0, source: candidate, evidenceSha256: digest('candidate evidence') }],
    review: { outcome: 'pass', source: candidate, evidenceSha256: digest('review evidence') }, terminalReceiptSha256: digest('SECRET RECEIPT') };
}
function withHistory(fn: (history: RunHistory, scope: WeeklyScope) => void, upper = 4): void {
  const f = fixture(); let history: RunHistory | undefined;
  try {
    history = new RunHistory(f.directory, f.root, () => 1000);
    fn(history, { projectId: f.projectId, originalRoot: f.root, dueAt: 2000, lowerExclusive: 0, upperInclusive: upper });
  } finally { history?.close(); f.dispose(); }
}
function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)); }
function complete(scope: WeeklyScope, records: readonly RunRecord[], options: WeeklyOptions = {}) {
  const state = createWeeklyAccumulator(scope, options);
  return finishWeeklySummary(scope.lowerExclusive === scope.upperInclusive ? state : appendWeeklyRecords(state, records, scope.upperInclusive));
}
function rehash(raw: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, digest: _digest, ...body } = raw;
  const id = digest(serialize(body)); return { ...body, id, digest: digest(serialize({ ...body, id })) };
}
function restamp(r: RunRecord, patch: Partial<RunRecord>): RunRecord {
  const { id: _id, digest: _digest, sequence, recordedAt, ...facts } = { ...r, ...patch };
  return { ...facts, sequence, recordedAt,
    id: digest(serialize({ projectId: facts.projectId, workspaceRoot: facts.workspaceRoot, runId: facts.runId })),
    digest: digest(serialize(facts)) };
}

test('actual history pages and serialized restarts produce identical scoped summaries', () => withHistory((history, scope) => {
  for (let i = 1; i <= 4; i++) history.record(input(i, i % 2 ? 'authenticated' : 'fixture'));
  const records = history.list({ afterSequence: 0, throughSequence: 4, limit: 100 });
  const expected = complete(scope, records);
  for (let split = 1; split < 4; split++) {
    let state = appendWeeklyRecords(createWeeklyAccumulator(scope), records.slice(0, split), split);
    state = appendWeeklyRecords(clone(state), records.slice(split), 4);
    assert.equal(serialize(finishWeeklySummary(state)), serialize(expected));
  }
  let state = createWeeklyAccumulator(scope);
  for (const r of records) state = appendWeeklyRecords(clone(state), [r], r.sequence);
  assert.deepEqual(finishWeeklySummary(state), expected);
  assert.equal(expected.authenticated.runs, 2); assert.equal(expected.fixture.runs, 2);
  assert.equal(expected.selectedRuns, 2); assert.equal(expected.excludedFixtureCount, 2);
  assert.equal(expected.dependencyCount, 4); assert.equal(expected.examples.length, 2);
  assert.equal(expected.authenticated.checks.baselineFailed, 2);
  assert.equal(expected.authenticated.checks.candidatePassed, 2);
  assert.equal(expected.authenticated.reviews.pass, 2);
  const all = complete(scope, records, { executionSelection: 'all' });
  assert.equal(all.selectedRuns, 4); assert.equal(all.excludedFixtureCount, 0);
  assert.equal(all.examples.length, 4); assert.equal(all.dependencySha256, expected.dependencySha256);
  let rolling = digest(serialize({ domain: 'weekly-summary-dependencies-v1' }));
  for (const r of records) rolling = digest(serialize({ domain: 'weekly-summary-dependency-v1', previous: rolling, id: r.id, digest: r.digest, sequence: r.sequence }));
  assert.equal(expected.dependencySha256, rolling);
  const { id, digest: claimed, ...body } = expected;
  assert.equal(id, digest(serialize(body))); assert.equal(claimed, digest(serialize({ ...body, id })));
  assert.deepEqual(validateWeeklySummary(clone(expected)), expected);
  assert.ok(Object.isFrozen(expected)); assert.ok(Object.isFrozen(expected.authenticated.outcomes));
  for (const forbidden of ['SECRET RECEIPT', 'objective', 'stdout', 'stderr', 'errors', 'findings', 'commands', 'exitCode', 'rawReceipt'])
    assert.ok(!serialize(expected).includes(forbidden));
}));

test('whole UTF-8 provenance and full-body budgets remain stable across partitions', () => withHistory((history, scope) => {
  const paths = Array.from({ length: 30 }, (_, i) => `src/${'界'.repeat(40)}-${i}.ts`);
  const records = Array.from({ length: 12 }, (_, i) => history.record(input(i + 1, 'authenticated', i === 0 ? paths : ['src/界.ts'])));
  const summary = complete(scope, records, { maxBytes: 65536 });
  assert.equal(summary.examples.length, 8); assert.equal(summary.omittedExamples, 4);
  const first = at(summary.examples, 0), secondRecord = at(records, 1);
  assert.equal(first.sequence, 2);
  assert.equal(at(first.changedPaths, 0), 'src/界.ts');
  assert.equal(first.runId, secondRecord.runId); assert.equal(first.runDigest, secondRecord.digest);
  assert.ok(bytes(serialize(summary)) <= summary.maxBytes);
  let low = 0, high = 8192;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    try { createWeeklyAccumulator(scope, { maxBytes: middle }); high = middle; } catch { low = middle; }
  }
  const minimum = high;
  assert.throws(() => createWeeklyAccumulator(scope, { maxBytes: minimum - 1 }));
  const small = complete(scope, records, { maxBytes: minimum });
  assert.equal(small.examples.length, 0); assert.equal(small.omittedExamples, 12);
  assert.ok(bytes(serialize(small)) <= minimum);
  for (const budget of [minimum, minimum + 1500, 8192, 65536]) {
    const single = complete(scope, records, { maxBytes: budget });
    let state = createWeeklyAccumulator(scope, { maxBytes: budget });
    for (const r of records) state = appendWeeklyRecords(clone(state), [r], r.sequence);
    assert.equal(serialize(finishWeeklySummary(state)), serialize(single));
    assert.equal(single.selectedRuns, single.examples.length + single.omittedExamples);
    assert.ok(bytes(serialize(single)) <= budget);
  }
}, 12));

test('a valid aggregate above 1 MiB is identical in one batch and smaller pages', () => withHistory((history, scope) => {
  const paths = Array.from({ length: 100 }, (_, i) => `src/${'x'.repeat(240)}-${i}.ts`);
  const records = Array.from({ length: 60 }, (_, i) => history.record(input(i + 1, i % 3 ? 'authenticated' : 'fixture', paths)));
  assert.ok(bytes(JSON.stringify(records)) > 1024 * 1024);
  const expected = complete(scope, records, { executionSelection: 'all' });
  assert.equal(expected.examples.length, 0); assert.equal(expected.omittedExamples, 60);
  for (const width of [1, 7, 30]) {
    let state = createWeeklyAccumulator(scope, { executionSelection: 'all' });
    for (let start = 0; start < records.length; start += width) {
      const page = records.slice(start, start + width);
      state = appendWeeklyRecords(clone(state), page, at(page, page.length - 1).sequence);
    }
    assert.equal(serialize(finishWeeklySummary(state)), serialize(expected));
  }
}, 60));

test('100-record limit accepts its boundary and rejects 101 without changing state', () => withHistory((history, scope) => {
  const records = Array.from({ length: 100 }, (_, i) => history.record(input(i + 1)));
  const state = createWeeklyAccumulator(scope), original = serialize(state);
  const summary = finishWeeklySummary(appendWeeklyRecords(state, records, 100));
  assert.equal(summary.dependencyCount, 100); assert.ok(summary.examples.length <= 8);
  assert.throws(() => appendWeeklyRecords(state, [...records, at(records, 0)], 100));
  assert.equal(serialize(state), original);
}, 100));

test('scope, interval, cursor, ordering and record integrity fail closed', () => withHistory((history, scope) => {
  const a = history.record(input(1)), b = history.record(input(2));
  const baseline = at(a.checks, 0), review = present(a.review);
  const state = createWeeklyAccumulator(scope), original = serialize(state);
  assert.throws(() => finishWeeklySummary(state));
  for (const cursor of [0, 5, -1, 1.5, Infinity]) assert.throws(() => appendWeeklyRecords(state, [], cursor));
  assert.throws(() => appendWeeklyRecords(state, [b], 1));
  assert.throws(() => appendWeeklyRecords(state, [b, a], 2));
  assert.throws(() => appendWeeklyRecords(state, [a, { ...a, sequence: 2 }], 2));
  const next = appendWeeklyRecords(state, [a], 1);
  assert.throws(() => appendWeeklyRecords(next, [a], 2));
  const narrowed = createWeeklyAccumulator({ ...scope, lowerExclusive: 1 });
  assert.throws(() => appendWeeklyRecords(narrowed, [a], 4));
  for (const patch of [
    { id: digest('wrong') }, { digest: digest('wrong') }, { taskId: 'other-task' },
    { projectId: 'another-project' }, { workspaceRoot: '/another-root' }, { sequence: 0 },
    { sequence: 1.5 }, { sequence: -1 }, { sequence: 5 }, { recordedAt: -1 }, { recordedAt: Infinity },
    { schemaVersion: 2 }, { outcome: 'unknown' }, { lastPhase: 'unknown' }, { runId: 'bad' },
    { objective: 'SECRET' }, { changedPaths: ['../secret'] }, { checks: [{ ...baseline, command: 'SECRET' }] },
    { review: { ...review, findings: ['SECRET'] } }, { terminalReceiptSha256: 'bad' }
  ]) assert.throws(() => appendWeeklyRecords(state, [{ ...a, ...patch } as RunRecord], 4));
  assert.throws(() => appendWeeklyRecords(state, [restamp(a, { checks: [{ ...baseline, exitCode: 0 }] })], 4));
  for (const changedPaths of [[`src/${'x'.repeat(513)}`], ['src/\u0001bad.ts'], ['src/\ud800.ts'], ['src/\udc00.ts'], ['src/\ud800x.ts']])
    assert.throws(() => appendWeeklyRecords(state, [restamp(a, { changedPaths })], 4));
  assert.equal(serialize(state), original);
  const paired = restamp(a, { changedPaths: ['src/😀.ts'] });
  assert.equal(at(at(complete(scope, [paired]).examples, 0).changedPaths, 0), 'src/😀.ts');
  const finished = finishWeeklySummary(appendWeeklyRecords(next, [], 4));
  assert.equal(finished.dependencyCount, 1); assert.equal(finished.cursor, 4);
  assert.equal(finished.selectedRuns, 1);
  const direct = complete(scope, [a]);
  assert.equal(serialize(finished), serialize(direct));
  assert.equal(complete({ ...scope, lowerExclusive: 4 }, []).dependencyCount, 0);
}));

test('descriptor-safe boundaries never invoke getters and reject unsafe shapes', () => withHistory((history, scope) => {
  const record = history.record(input(1)); const state = createWeeklyAccumulator(scope);
  let calls = 0; const getter = () => { calls++; return 1; };
  const badRecord = { ...record }; Object.defineProperty(badRecord, 'sequence', { enumerable: true, get: getter });
  assert.throws(() => appendWeeklyRecords(state, [badRecord], 4));
  const badState = { ...state }; Object.defineProperty(badState, 'cursor', { enumerable: true, get: getter });
  assert.throws(() => finishWeeklySummary(badState));
  const badScope = { ...scope }; Object.defineProperty(badScope, 'dueAt', { enumerable: true, get: getter });
  assert.throws(() => createWeeklyAccumulator(badScope));
  const array = [record]; Object.defineProperty(array, '0', { enumerable: true, get: getter });
  assert.throws(() => appendWeeklyRecords(state, array, 4));
  const summary = complete(scope, [record]);
  const badSummary = clone(summary); Object.defineProperty(at(badSummary.examples, 0), 'taskId', { enumerable: true, get: getter });
  assert.throws(() => validateWeeklySummary(badSummary));
  const nested = { ...record, checks: [{ ...at(record.checks, 0) }] };
  Object.defineProperty(at(nested.checks, 0), 'source', { enumerable: true, get: getter });
  assert.throws(() => appendWeeklyRecords(state, [nested], 4));
  for (const bad of [Object.assign(Object.create({ inherited: true }), record), { ...record, [Symbol('secret')]: 1 }])
    assert.throws(() => appendWeeklyRecords(state, [bad], 4));
  const hidden = { ...record }; Object.defineProperty(hidden, 'hidden', { value: 'secret' });
  assert.throws(() => appendWeeklyRecords(state, [hidden], 4));
  const extra = Object.assign([record], { extra: true });
  const symbolic = Object.assign([record], { [Symbol('secret')]: true });
  const inherited = [record]; Object.setPrototypeOf(inherited, Object.create(Array.prototype));
  const concealed = [record]; Object.defineProperty(concealed, '0', { enumerable: false });
  for (const bad of [new Array(1), extra, symbolic, inherited, concealed]) assert.throws(() => appendWeeklyRecords(state, bad, 4));
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  assert.throws(() => validateWeeklySummary(cyclic));
  const options = {}; Object.defineProperty(options, 'maxBytes', { enumerable: true, get: getter });
  assert.throws(() => createWeeklyAccumulator(scope, options)); assert.equal(calls, 0);
}));

test('defaults apply only to absent options and roots use native lexical semantics', () => withHistory((_history, scope) => {
  const state = createWeeklyAccumulator(scope);
  assert.equal(state.maxBytes, 8192); assert.equal(state.executionSelection, 'authenticated');
  for (const options of [null, undefined, { maxBytes: null }, { executionSelection: null }, { maxBytes: undefined }, { executionSelection: undefined }])
    assert.throws(() => createWeeklyAccumulator(scope, options as never));
  for (const maxBytes of [0, -1, 1.5, 65537, Infinity, NaN, '8192'])
    assert.throws(() => createWeeklyAccumulator(scope, { maxBytes } as never));
  assert.throws(() => createWeeklyAccumulator(scope, { executionSelection: 'fixture' } as never));
  assert.throws(() => createWeeklyAccumulator(scope, { extra: true } as never));
  const roots = sep === '\\' ? ['C:\\', 'C:\\repo', '\\\\server\\share\\', '\\\\server\\share\\repo'] : ['/', '/repo', '/tmp/界'];
  for (const originalRoot of [scope.originalRoot, parse(scope.originalRoot).root, ...roots, `${scope.originalRoot}${sep}😀`]) {
    const value = createWeeklyAccumulator({ ...scope, originalRoot });
    assert.equal(value.originalRoot, originalRoot);
  }
  const badRoots = sep === '\\'
    ? ['repo', 'C:repo', '\\repo', 'C:\\a\\..\\b', 'C:\\repo\\', 'C:/repo', 'C:\\a\\\\b']
    : ['repo', '/a/../b', '/a/./b', '/repo/', '/a//b', 'C:\\repo', '/a\\b'];
  for (const originalRoot of [...badRoots, `${scope.originalRoot}\u0001`, `${scope.originalRoot}\ud800`, `${scope.originalRoot}\udc00`])
    assert.throws(() => createWeeklyAccumulator({ ...scope, originalRoot }));
}));

test('framing, serialized states, summary hashes and budgets are validated', () => withHistory((history, scope) => {
  const record = history.record(input(1)); const summary = complete(scope, [record]);
  for (const patch of [
    { schemaVersion: 2 }, { historical: false }, { trust: 'trusted' }, { executionSelection: 'fixture' },
    { cursor: 3 }, { maxBytes: 65537 }, { maxBytes: 1 }, { dueAt: -1 }, { lowerExclusive: 5 },
    { upperInclusive: 0 }, { projectId: 'invalid project' }, { originalRoot: '/a/../b' },
    { dependencyCount: 2 }, { selectedRuns: 2 }, { excludedFixtureCount: 1 }, { omittedExamples: 1 },
    { dependencySha256: 'bad' }, { extra: 'unknown' }
  ]) assert.throws(() => validateWeeklySummary(rehash({ ...summary, ...patch })));
  assert.throws(() => validateWeeklySummary({ ...summary, id: digest('wrong') }));
  assert.throws(() => validateWeeklySummary({ ...summary, digest: digest('wrong') }));
  assert.throws(() => validateWeeklySummary({ ...summary, dueAt: summary.dueAt + 1 }));
  const first = at(summary.examples, 0), check = at(first.checks, 0);
  for (const patch of [
    { sequence: 0 }, { runId: 'bad' }, { id: digest('wrong') }, { taskId: 'bad task' },
    { changedPaths: ['../bad'] }, { stdout: 'SECRET' }, { checks: [{ ...check, rawReceipt: 'SECRET' }] },
    { review: { source: digest('other'), evidenceSha256: digest('evidence') } }
  ]) assert.throws(() => validateWeeklySummary(rehash({ ...summary, examples: [{ ...first, ...patch }] })));
  const initial = createWeeklyAccumulator(scope);
  const malformed = clone(initial) as unknown as Record<string, unknown>;
  delete malformed.omittedExamples; assert.throws(() => finishWeeklySummary(malformed as unknown as Accumulator));
  assert.throws(() => appendWeeklyRecords({ ...initial, unknown: true } as Accumulator, [], 4));
  assert.throws(() => createWeeklyAccumulator({ ...scope, extra: true } as WeeklyScope));
  const badCounters = clone(initial); (badCounters.authenticated.outcomes as Record<string, number>).completed = 1;
  assert.throws(() => appendWeeklyRecords(badCounters, [], 4));
  const empty = finishWeeklySummary(appendWeeklyRecords(initial, [], 4));
  assert.equal(empty.dependencyCount, 0); assert.equal(empty.examples.length, 0);
  assert.throws(() => validateWeeklySummary(rehash({ ...empty, dependencySha256: digest('nonempty') })));
}));

test('checked sums and increments reject overflow without mutating prior evidence', () => withHistory((history, scope) => {
  const record = history.record(input(1)), max = Number.MAX_SAFE_INTEGER;
  const state = clone(createWeeklyAccumulator({ ...scope, upperInclusive: max }));
  const mutable = state as unknown as Record<string, unknown>;
  mutable.cursor = max - 1; mutable.dependencyCount = max - 1; mutable.selectedRuns = max - 1;
  mutable.omittedExamples = max - 1; mutable.dependencySha256 = digest('opaque evidence commitment');
  const c = state.authenticated as unknown as Record<string, unknown>;
  c.runs = max - 1; (c.outcomes as Record<string, number>).completed = max - 1;
  (c.phases as Record<string, number>).terminal = max - 1; (c.reviews as Record<string, number>).pass = max - 1;
  const checks = c.checks as Record<string, number>;
  checks.baselineFailed = max;
  // This state is structurally valid, but the next genuine baseline check overflows.
  assert.doesNotThrow(() => finishWeeklySummary(appendWeeklyRecords(state, [], max)));
  const original = serialize(state);
  assert.throws(() => appendWeeklyRecords(state, [{ ...record, sequence: max }], max));
  assert.equal(serialize(state), original);
  checks.candidatePassed = 1;
  assert.throws(() => appendWeeklyRecords(state, [], max));
  assert.ok(!Object.keys(state).includes('records')); assert.ok(!Object.keys(state).includes('ids'));
}));

test('fixed outcome, phase, check and review counters include terminal failures', () => withHistory((history, scope) => {
  const base = input(1);
  const records = [history.record(base)];
  for (const [i, outcome, lastPhase] of [[2, 'failed', 'candidate'], [3, 'blocked', 'approval'], [4, 'indeterminate', 'setup']] as const) {
    const { candidateSource: _candidate, review: _review, ...facts } = input(i, 'fixture');
    records.push(history.record({ ...facts, outcome, lastPhase, checks: [] }));
  }
  const summary = complete(scope, records, { executionSelection: 'all' });
  assert.equal(summary.authenticated.outcomes.completed, 1);
  assert.equal(summary.fixture.outcomes.failed, 1); assert.equal(summary.fixture.outcomes.blocked, 1);
  assert.equal(summary.fixture.outcomes.indeterminate, 1); assert.equal(summary.fixture.reviews.absent, 3);
  assert.equal(summary.fixture.phases.candidate, 1); assert.equal(summary.fixture.phases.approval, 1);
  assert.equal(summary.fixture.phases.setup, 1);
}));

test('revoked gaps and dependency changes rebuild historical identities', () => withHistory((history, scope) => {
  const a = history.record(input(1)), b = history.record(input(2, 'fixture')), c = history.record(input(3));
  const original = complete(scope, [a, b, c]);
  const changed = restamp(b, { terminalReceiptSha256: digest('changed receipt') });
  const rebuilt = complete(scope, [a, changed, c]);
  assert.notEqual(rebuilt.dependencySha256, original.dependencySha256);
  assert.notEqual(rebuilt.id, original.id); assert.notEqual(rebuilt.digest, original.digest);
  assert.deepEqual(rebuilt.examples, original.examples);
  history.revoke(b.id, b.digest);
  const active = history.list({ afterSequence: 0, throughSequence: scope.upperInclusive, limit: 100 });
  const revoked = complete(scope, active);
  let state = createWeeklyAccumulator(scope);
  state = appendWeeklyRecords(clone(state), [a], 1);
  state = appendWeeklyRecords(clone(state), [], 2);
  state = appendWeeklyRecords(clone(state), [c], 3);
  state = appendWeeklyRecords(clone(state), [], 4);
  assert.equal(serialize(finishWeeklySummary(state)), serialize(revoked));
  assert.equal(revoked.dependencyCount, 2); assert.notEqual(revoked.id, original.id);
  assert.notEqual(revoked.digest, original.digest);
  // Structural historical validation neither consults dependencies nor restores bodies.
  assert.deepEqual(validateWeeklySummary(original), original);
}));

test('every fixed check mapping and phase is counted separately for both executions', () => withHistory((history, scope) => {
  const phases = ['setup', 'planning', 'approval', 'baseline', 'coding', 'candidate', 'review', 'delivery', 'publication', 'terminal'] as const;
  const reviewOutcomes = ['pass', 'revise', 'blocked'] as const;
  const records: RunRecord[] = [];
  for (const execution of ['authenticated', 'fixture'] as const) {
    for (const [index, lastPhase] of phases.entries()) {
      const base = input(records.length + 1, execution);
      const candidateSource = present(base.candidateSource);
      const checks: RunCheck[] = [];
      for (const phase of ['baseline', 'candidate'] as const) {
        for (const outcome of ['passed', 'failed', 'indeterminate'] as const) {
          checks.push({ phase, id: outcome, outcome, exitCode: outcome === 'passed' ? 0 : outcome === 'failed' ? 1 : null,
            source: phase === 'baseline' ? base.baselineSource : candidateSource, evidenceSha256: digest(`${phase}-${outcome}`) });
        }
      }
      const { review: _review, ...facts } = base;
      records.push(history.record({ ...facts, outcome: 'failed', lastPhase, checks,
        ...(index === 9 ? {} : { review: { outcome: at(reviewOutcomes, index % 3), source: candidateSource, evidenceSha256: digest('review') } }) }));
    }
  }
  const summary = complete(scope, records, { executionSelection: 'all', maxBytes: 65536 });
  for (const execution of ['authenticated', 'fixture'] as const) {
    const counters = summary[execution];
    assert.equal(counters.runs, 10);
    assert.deepEqual(counters.outcomes, { completed: 0, failed: 10, blocked: 0, indeterminate: 0 });
    assert.deepEqual(Object.keys(counters.phases).sort(), [...phases].sort());
    for (const phase of phases) assert.equal(counters.phases[phase], 1);
    assert.deepEqual(counters.checks, { baselinePassed: 10, baselineFailed: 10, baselineIndeterminate: 10,
      candidatePassed: 10, candidateFailed: 10, candidateIndeterminate: 10 });
    assert.deepEqual(counters.reviews, { pass: 3, revise: 3, blocked: 3, absent: 1 });
  }
  let state = createWeeklyAccumulator(scope, { executionSelection: 'all', maxBytes: 65536 });
  for (const record of records) state = appendWeeklyRecords(clone(state), [record], record.sequence);
  assert.equal(serialize(finishWeeklySummary(state)), serialize(summary));
  const selected = complete(scope, records);
  assert.equal(selected.selectedRuns, 10); assert.equal(selected.excludedFixtureCount, 10);
  assert.equal(selected.dependencyCount, 20); assert.equal(selected.dependencySha256, summary.dependencySha256);
}, 20));

type EvidenceKind = 'baseline' | 'candidate' | 'review' | 'absent';
function contradict(state: Accumulator, execution: 'authenticated' | 'fixture', kind: EvidenceKind, count = 0): Accumulator {
  const c = state[execution];
  const checks = kind === 'baseline' ? { ...c.checks, baselinePassed: 0, baselineFailed: count, baselineIndeterminate: 0 }
    : kind === 'candidate' ? { ...c.checks, candidatePassed: count, candidateFailed: 0, candidateIndeterminate: 0 } : c.checks;
  const reviews = kind === 'review' ? { pass: 0, revise: 0, blocked: 0, absent: c.runs }
    : kind === 'absent' ? { pass: c.runs, revise: 0, blocked: 0, absent: 0 } : c.reviews;
  return { ...state, [execution]: { ...c, checks, reviews } };
}
function evidenceInput(n: number, execution: 'authenticated' | 'fixture', reviewed: boolean): TerminalRunInput {
  const { review, ...facts } = input(n, execution);
  return { ...facts, outcome: reviewed ? facts.outcome : 'failed', checks: reviewed ? facts.checks.flatMap(c => [c, { ...c, id: `${c.id}-extra` }]) : [],
    ...(reviewed ? { review: present(review) } : {}) };
}

test('reviewer reproduction: rehashed zero checks and absent review contradict the retained example', () => withHistory((history, scope) => {
  const summary = complete(scope, [history.record(input(1))]);
  assert.equal(summary.examples.length, 1); assert.equal(at(summary.examples, 0).checks.length, 2);
  assert.ok(at(summary.examples, 0).review);
  let tampered: Accumulator = summary;
  for (const kind of ['baseline', 'candidate', 'review'] as const) tampered = contradict(tampered, 'authenticated', kind);
  assert.ok(Object.values(tampered.authenticated.checks).every(n => n === 0));
  assert.deepEqual(tampered.authenticated.reviews, { pass: 0, revise: 0, blocked: 0, absent: 1 });
  assert.throws(() => validateWeeklySummary(rehash({ ...tampered })), /invalid weekly summary/);
}));

for (const execution of ['authenticated', 'fixture'] as const) {
  for (const kind of ['baseline', 'candidate', 'review', 'absent'] as const) {
    test(`${execution} ${kind} counters cover retained evidence in validation, append and finish`, () => withHistory((history, scope) => {
      const records = [history.record(evidenceInput(1, execution, true)), history.record(evidenceInput(2, execution, false))];
      const state = appendWeeklyRecords(createWeeklyAccumulator(scope, { executionSelection: 'all', maxBytes: 65536 }), records, 2);
      const summary = finishWeeklySummary({ ...state, cursor: scope.upperInclusive });
      // One check per phase is insufficient: the retained example has two per phase.
      assert.throws(() => validateWeeklySummary(rehash({ ...contradict(summary, execution, kind, 1) })), /invalid weekly summary/);
      const invalid = clone(contradict(state, execution, kind, 1)), before = serialize(invalid);
      assert.throws(() => appendWeeklyRecords(invalid, [], scope.upperInclusive), /invalid weekly summary/);
      assert.throws(() => finishWeeklySummary({ ...invalid, cursor: scope.upperInclusive }), /invalid weekly summary/);
      assert.equal(serialize(invalid), before);
    }));
  }
}

test('mixed execution groups cannot compensate; omitted and partial evidence remain valid lower bounds', () => withHistory((history, scope) => {
  const records: RunRecord[] = [];
  for (const execution of ['authenticated', 'fixture'] as const)
    for (let i = 0; i < 4; i++) records.push(history.record(evidenceInput(records.length + 1, execution, i % 2 === 0)));
  const summary = complete(scope, records, { executionSelection: 'all', maxBytes: 65536 });
  const partial = { ...summary, examples: [0, 1, 4, 5].map(i => at(summary.examples, i)), omittedExamples: 4 };
  assert.doesNotThrow(() => validateWeeklySummary(rehash(partial)));
  for (const execution of ['authenticated', 'fixture'] as const) {
    for (const kind of ['baseline', 'candidate', 'review', 'absent'] as const) {
      const tampered = contradict(partial, execution, kind);
      const totals = [tampered.authenticated, tampered.fixture];
      const available = totals.reduce((n, c) => n + (kind === 'baseline'
        ? c.checks.baselinePassed + c.checks.baselineFailed + c.checks.baselineIndeterminate : kind === 'candidate'
          ? c.checks.candidatePassed + c.checks.candidateFailed + c.checks.candidateIndeterminate
          : kind === 'review' ? c.reviews.pass + c.reviews.revise + c.reviews.blocked : c.reviews.absent), 0);
      assert.ok(available >= (kind === 'baseline' || kind === 'candidate' ? 4 : 2));
      assert.throws(() => validateWeeklySummary(rehash({ ...tampered })), /invalid weekly summary/);
    }
  }
  assert.doesNotThrow(() => validateWeeklySummary(rehash({ ...summary, examples: [], omittedExamples: 8 })));
  const fewerChecks = { ...partial, examples: partial.examples.map(e => ({ ...e, checks: e.checks.slice(0, 1) })) };
  assert.doesNotThrow(() => validateWeeklySummary(rehash(fewerChecks)));
  // Examples carry no outcome, last phase, check outcome or review verdict to infer.
  let redistributed: Accumulator = partial;
  for (const execution of ['authenticated', 'fixture'] as const) {
    const c = redistributed[execution];
    redistributed = { ...redistributed, [execution]: { ...c, outcomes: { completed: 0, failed: 0, blocked: c.runs, indeterminate: 0 },
      phases: { ...c.phases, terminal: 0, setup: 4 },
      checks: { baselinePassed: 0, baselineFailed: 0, baselineIndeterminate: 4, candidatePassed: 0, candidateFailed: 0, candidateIndeterminate: 4 },
      reviews: { pass: 0, revise: 2, blocked: 0, absent: 2 } } };
  }
  assert.doesNotThrow(() => validateWeeklySummary(rehash({ ...redistributed })));
  for (const executionSelection of ['authenticated', 'all'] as const)
    assert.doesNotThrow(() => validateWeeklySummary(clone(complete(scope, [], { executionSelection }))));
}, 8));
