import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { invocationBudget } from '../../src/live-workflow/invocation-budget.js';

test('native invocation honors each validated configured task duration', () => {
  for (const [taskMs, expected] of [[1, 1], [1000, 1000], [300000, 300000], [300001, 300001], [900000, 900000]] as const) {
    const budget = invocationBudget(taskMs, new AbortController().signal);
    try { assert.equal(budget.timeoutMs, expected); assert.equal(budget.signal.aborted, false); }
    finally { budget.dispose(); }
    assert.equal(budget.signal.aborted, true);
  }
});
test('invocation signal aborts at its deadline and on task cancellation', async () => {
  const short = invocationBudget(10, new AbortController().signal);
  try { await delay(40); assert.equal(short.signal.aborted, true); }
  finally { short.dispose(); }
  const task = new AbortController(), budget = invocationBudget(1000, task.signal);
  try { task.abort(); assert.equal(budget.signal.aborted, true); } finally { budget.dispose(); }
});
test('invocation cannot accept malformed or already cancelled budgets', () => {
  for (const value of [0, -1, 1.5, Infinity, 900001]) assert.throws(() => invocationBudget(value, new AbortController().signal));
  const task = new AbortController(); task.abort();
  assert.throws(() => invocationBudget(1000, task.signal));
});

test('long invocation stays active beyond five minutes but expires at its configured boundary', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const budget = invocationBudget(900000, new AbortController().signal);
  try {
    t.mock.timers.tick(300001); assert.equal(budget.signal.aborted, false);
    t.mock.timers.tick(599998); assert.equal(budget.signal.aborted, false);
    t.mock.timers.tick(1); assert.equal(budget.signal.aborted, true);
  } finally { budget.dispose(); }
});
test('earlier owner cancellation and dispose win over a long configured duration', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const task = new AbortController(), reason = new Error('owner cancelled');
  const budget = invocationBudget(900000, task.signal);
  task.abort(reason); assert.equal(budget.signal.aborted, true); assert.equal(budget.signal.reason, reason);
  budget.dispose();
  const disposed = invocationBudget(900000, new AbortController().signal);
  disposed.dispose(); assert.equal(disposed.signal.aborted, true);
  t.mock.timers.tick(900000); assert.equal(disposed.signal.aborted, true);
});
