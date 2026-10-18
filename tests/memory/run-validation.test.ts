import assert from 'node:assert/strict';
import { test } from 'node:test';
import { terminalRun } from '../../src/memory/run-validation.js';

const B = 'b'.repeat(64), C = 'c'.repeat(64), E = 'e'.repeat(64);
function check(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { phase: 'candidate', id: 'typecheck', outcome: 'passed', exitCode: 0, source: C, evidenceSha256: E, ...overrides };
}
function bare(): Record<string, unknown> {
  return { schemaVersion: 1, runId: 'a'.repeat(64), taskId: 'task-1', execution: 'authenticated', startedAt: 0,
    endedAt: 1, outcome: 'blocked', lastPhase: 'terminal', baselineSource: B, changedPaths: [], checks: [], terminalReceiptSha256: E };
}
function run(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...bare(), outcome: 'completed', candidateSource: C, changedPaths: ['src/a.ts'], checks: [check()],
    review: { outcome: 'pass', source: C, evidenceSha256: E }, ...overrides };
}
function without(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}
test('accepts terminal outcomes, fixtures, source-bound checks and absent optional facts', () => {
  for (const outcome of ['failed', 'blocked', 'indeterminate']) {
    const value = terminalRun({ ...bare(), outcome });
    assert.equal(value.outcome, outcome); assert.equal('candidateSource' in value, false); assert.equal('review' in value, false);
  }
  assert.equal(terminalRun(run({ execution: 'fixture' })).execution, 'fixture');
  terminalRun(run({ checks: [check({ phase: 'baseline', source: B, outcome: 'failed', exitCode: 1 }), check()] }));
  terminalRun({ ...bare(), checks: [check({ phase: 'baseline', source: B, outcome: 'indeterminate', exitCode: null })] });
  terminalRun(run({ outcome: 'failed', checks: [check({ outcome: 'failed', exitCode: -1 })] }));
  terminalRun(run({ changedPaths: Array.from({ length: 100 }, (_, i) => `src/p${i}`), checks: Array.from({ length: 24 }, (_, i) => check({ id: `c${i}` })) }));
  for (const lastPhase of ['setup', 'planning', 'approval', 'baseline', 'coding', 'candidate', 'review', 'delivery', 'publication', 'terminal']) terminalRun({ ...bare(), lastPhase });
});
test('returns an isolated deeply frozen snapshot', () => {
  const item = check(), paths = ['src/a.ts'], raw = run({ checks: [item], changedPaths: paths });
  const value = terminalRun(raw); raw.taskId = 'other'; paths.push('src/b.ts'); item.outcome = 'failed';
  const saved = value.checks[0]; assert.ok(saved);
  assert.equal(value.taskId, 'task-1'); assert.deepEqual(value.changedPaths, ['src/a.ts']); assert.equal(saved.outcome, 'passed');
  for (const part of [value, value.changedPaths, value.checks, saved, value.review]) assert.equal(Object.isFrozen(part), true);
  assert.equal(Reflect.set(saved, 'outcome', 'failed'), false);
});
const invalid: [string, Record<string, unknown>][] = [
  ['schema', { schemaVersion: '1' }], ['hash', { runId: 'A'.repeat(64) }], ['receipt', { terminalReceiptSha256: 'bad' }],
  ['baseline hash', { baselineSource: null }], ['candidate hash', { candidateSource: 1 }], ['slug', { taskId: '../task' }],
  ['long slug', { taskId: 'x'.repeat(129) }], ['execution', { execution: 'trusted' }], ['outcome', { outcome: 'success' }],
  ['phase', { lastPhase: 'done' }], ['negative time', { startedAt: -1 }], ['reversed time', { startedAt: 2 }],
  ['fractional time', { endedAt: 0.5 }], ['unsafe time', { endedAt: Number.MAX_SAFE_INTEGER + 1 }], ['time type', { endedAt: '1' }],
  ['paths type', { changedPaths: 'src/a.ts' }], ['traversal', { changedPaths: ['../a'] }], ['absolute', { changedPaths: ['/a'] }],
  ['reserved path', { changedPaths: ['.git/config'] }], ['path primitive', { changedPaths: [1] }], ['duplicates', { changedPaths: ['a', 'a'] }],
  ['path count', { changedPaths: Array.from({ length: 101 }, (_, i) => `p${i}`) }], ['checks type', { checks: null }],
  ['check count', { checks: Array.from({ length: 25 }, (_, i) => check({ id: `c${i}` })) }], ['duplicate checks', { checks: [check(), check()] }],
  ['no candidate checks', { checks: [] }], ['review type', { review: [] }], ['review outcome', { review: { outcome: 'approved', source: C, evidenceSha256: E } }],
  ['review source', { review: { outcome: 'pass', source: B, evidenceSha256: E } }], ['review evidence', { review: { outcome: 'pass', source: C, evidenceSha256: '' } }],
  ['UTF8 byte limit', { changedPaths: Array.from({ length: 10 }, (_, i) => `${i}/${'é'.repeat(1800)}`) }],
];
for (const [name, overrides] of invalid) test(`rejects ${name}`, () => assert.throws(() => terminalRun(run(overrides))));
test('rejects missing facts and unknown fields at every object level', () => {
  for (const key of Object.keys(bare())) assert.throws(() => terminalRun(without(run(), key)));
  for (const key of Object.keys(check())) assert.throws(() => terminalRun(run({ checks: [without(check(), key)] })));
  for (const key of ['outcome', 'source', 'evidenceSha256']) assert.throws(() => terminalRun(run({ review: without({ outcome: 'pass', source: C, evidenceSha256: E }, key) })));
  for (const key of ['summary', 'logs', 'errors', 'credentials', 'objectives', 'artifactPaths', 'unexpected']) assert.throws(() => terminalRun(run({ [key]: 'raw' })));
  assert.throws(() => terminalRun(run({ checks: [check({ logs: 'raw' })] })));
  assert.throws(() => terminalRun(run({ review: { outcome: 'pass', source: C, evidenceSha256: E, summary: 'raw' } })));
});
test('rejects malformed or contradictory checks and incomplete completion', () => {
  for (const overrides of [{ phase: 'review' }, { id: '' }, { id: 2 }, { outcome: 'success' }, { source: B }, { evidenceSha256: false },
    { exitCode: '0' }, { exitCode: 0.5 }, { exitCode: Number.MAX_SAFE_INTEGER + 1 }, { exitCode: null }, { exitCode: 1 },
    { outcome: 'failed', exitCode: 0 }, { outcome: 'failed', exitCode: null }, { outcome: 'indeterminate', exitCode: 1 },
    { outcome: 'failed', exitCode: 1 }, { outcome: 'indeterminate', exitCode: null }]) assert.throws(() => terminalRun(run({ checks: [check(overrides)] })));
  for (const outcome of ['revise', 'blocked']) assert.throws(() => terminalRun(run({ review: { outcome, source: C, evidenceSha256: E } })));
  assert.throws(() => terminalRun(without(run(), 'review'))); assert.throws(() => terminalRun({ ...bare(), outcome: 'completed' }));
  assert.throws(() => terminalRun({ ...bare(), checks: [check()] }));
  assert.throws(() => terminalRun({ ...bare(), review: { outcome: 'pass', source: C, evidenceSha256: E } }));
});
test('rejects unsafe descriptors, prototypes, sparse arrays, cycles and non-JSON primitives without invoking getters', () => {
  let reads = 0;
  const accessor = Object.defineProperty(run(), 'taskId', { enumerable: true, get() { reads++; return 'task-1'; } });
  const array = Object.defineProperty([check()], '0', { enumerable: true, get() { reads++; return check(); } });
  const cycle = run(); cycle.review = cycle;
  for (const raw of [accessor, run({ checks: array }), Object.setPrototypeOf(run(), { inherited: true }),
    Object.assign(run(), { [Symbol('extra')]: 1 }), Object.defineProperty(run(), 'hidden', { value: 1 }),
    run({ checks: new Array(1) }), cycle, run({ candidateSource: undefined }), run({ startedAt: NaN }), run({ endedAt: Infinity }), run({ taskId: () => 'task' })]) assert.throws(() => terminalRun(raw));
  assert.equal(reads, 0);
});
