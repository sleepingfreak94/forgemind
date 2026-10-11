import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { invocationBudget } from '../../src/live-workflow/invocation-budget.js';

test('native invocation caps a longer task at five minutes and preserves shorter budgets', () => {
  for (const [taskMs, expected] of [[900000, 300000], [1000, 1000]] as const) {
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
