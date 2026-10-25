import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { serialize } from '../../src/context-engine/validation.js';
import { renderWeeklyEmail, weeklyReportLines } from '../../src/memory/weekly-email.js';
import { createWeeklyAccumulator, finishWeeklySummary } from '../../src/memory/weekly-summary.js';
import type { Summary } from '../../src/memory/weekly-summary.js';

const h = (c: string) => c.repeat(64);
const counts = <K extends string>(keys: readonly K[], v: Partial<Record<K, number>>) =>
  Object.fromEntries(keys.map(k => [k, v[k] ?? 0])) as Record<K, number>;
const ex = (i: number, paths: string[], withReview: boolean): Summary['examples'][number] => ({
  id: h('a'), runId: h('b'), runDigest: h('c'), sequence: i, taskId: 'task-' + i, execution: 'authenticated',
  baselineSource: h('d'), candidateSource: h('e'), changedPaths: paths, terminalReceiptSha256: h('f'),
  checks: [{ phase: 'baseline', id: 'build', source: h('d'), evidenceSha256: h('1') },
    { phase: 'candidate', id: 'build', source: h('e'), evidenceSha256: h('2') }],
  ...(withReview ? { review: { source: h('e'), evidenceSha256: h('3') } } : {})
});
const summary: Summary = {
  schemaVersion: 1, projectId: 'proj', originalRoot: resolve('/', 'p'), dueAt: Date.UTC(2026, 9, 25, 4, 30),
  lowerExclusive: 0, upperInclusive: 9, cursor: 9, historical: true, trust: 'evidence-only',
  executionSelection: 'authenticated', maxBytes: 65536,
  authenticated: { runs: 12,
    outcomes: counts(['completed', 'failed', 'blocked', 'indeterminate'], { completed: 8, failed: 2, blocked: 2 }),
    phases: counts(['setup', 'planning', 'approval', 'baseline', 'coding', 'candidate', 'review', 'delivery', 'publication', 'terminal'],
      { coding: 3, terminal: 9 }),
    checks: counts(['baselinePassed', 'baselineFailed', 'baselineIndeterminate', 'candidatePassed', 'candidateFailed', 'candidateIndeterminate'],
      { candidatePassed: 10, candidateFailed: 3 }),
    reviews: counts(['pass', 'revise', 'blocked', 'absent'], { pass: 5, revise: 1, blocked: 1, absent: 5 }) },
  fixture: { runs: 0, outcomes: counts(['completed', 'failed', 'blocked', 'indeterminate'], {}),
    phases: counts(['setup', 'planning', 'approval', 'baseline', 'coding', 'candidate', 'review', 'delivery', 'publication', 'terminal'], {}),
    checks: counts(['baselinePassed', 'baselineFailed', 'baselineIndeterminate', 'candidatePassed', 'candidateFailed', 'candidateIndeterminate'], {}),
    reviews: counts(['pass', 'revise', 'blocked', 'absent'], {}) },
  selectedRuns: 12, excludedFixtureCount: 2, dependencyCount: 12, dependencySha256: h('9'),
  examples: [ex(1, ['a&b/<x>.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'], true), ex(2, ['z.ts'], false)],
  omittedExamples: 7, id: 'abcdef0123456789'.padEnd(64, '0'), digest: '0123456789abcdef'.padEnd(64, '1')
};
const empty = () => finishWeeklySummary(createWeeklyAccumulator({ projectId: 'proj', originalRoot: resolve('/', 'p'), dueAt: 0, lowerExclusive: 0, upperInclusive: 0 }));
const forbidden = /<script|<img|<link|href=|src=|url\(|https?:|:\/\//i;

test('empty summary renders friendly empty state', () => {
  const s = empty(), r = renderWeeklyEmail(s);
  assert.ok(r.html.startsWith('<!doctype html>'));
  assert.ok(r.html.includes('No harness runs were recorded this week.'));
  assert.ok(r.html.includes('Week ending Thu, 1 Jan 1970'));
  assert.ok(!r.html.includes('Where runs stopped')); assert.ok(!r.html.includes('Last step reached'));
  assert.ok(!r.text.includes('Where runs stopped')); assert.ok(!r.html.includes('Completed'));
  assert.ok(r.text.endsWith(serialize(s)));
});
test('non-empty summary renders sections, escaping and +N more', () => {
  const r = renderWeeklyEmail(summary), html = r.html;
  assert.ok(html.includes('Week ending Sun, 25 Oct 2026'));
  assert.ok(html.includes('a&amp;b/&lt;x&gt;.ts')); assert.ok(!html.includes('<x>'));
  assert.ok(html.includes('+2 more')); assert.ok(html.includes('+7 more runs not shown'));
  assert.ok(html.includes('—'));
  for (const s of ['Runs', 'Completed', 'Failed', 'Blocked', '#15803d', '#b91c1c', '#b45309', '#0f172a', '#f1f5f9', 'max-width:640px'])
    assert.ok(html.includes(s), s);
  assert.ok(html.includes('Last step reached')); assert.ok(!html.includes('Where runs stopped')); assert.ok(html.includes('coding')); assert.ok(html.includes('terminal'));
  assert.ok(!html.includes('>setup<'));
  assert.ok(html.includes(summary.id.slice(0, 12))); assert.ok(html.includes(summary.digest.slice(0, 12)));
  assert.ok(html.includes('Fixture runs excluded: 2'));
  assert.ok(html.includes('The exact evidence JSON is in the plain-text part of this email.'));
  assert.ok(!/<style/i.test(html));
});
test('deterministic, non-mutating and works on frozen input', () => {
  const copy = structuredClone(summary);
  assert.deepEqual(renderWeeklyEmail(copy), renderWeeklyEmail(copy)); assert.deepEqual(copy, summary);
  const frozen = Object.freeze(structuredClone(summary));
  assert.deepEqual(renderWeeklyEmail(frozen), renderWeeklyEmail(summary));
});
test('html has no script, image, link or URL', () => {
  assert.doesNotMatch(renderWeeklyEmail(summary).html, forbidden);
  assert.doesNotMatch(renderWeeklyEmail(empty()).html, forbidden);
});
test('text has heading first and evidence marker before the JSON', () => {
  const t = renderWeeklyEmail(summary).text;
  assert.ok(t.startsWith('ForgeMind weekly report\n'));
  assert.ok(t.includes('\n\n--- Evidence (exact JSON, for verification) ---\n' + serialize(summary)));
  assert.ok(t.endsWith(serialize(summary)));
  assert.ok(t.includes('- task-1: 5 files (a&b/<x>.ts, b.ts, c.ts, +2 more); checks 1 run; review reviewed'));
  assert.ok(t.includes('- task-2: 1 file (z.ts); checks 1 run; review —'));
  const html = renderWeeklyEmail(summary).html;
  assert.ok(html.includes('>1 run<') && html.includes('>reviewed<'));
  assert.ok(!html.includes('>1/2<') && !html.includes('>pass<') && !t.includes('1/2'));
  assert.ok(t.includes('+7 more runs not shown'));
});
test('weeklyReportLines is the readable text block of the email', () => {
  const marker = '\n\n--- Evidence (exact JSON, for verification) ---\n';
  for (const x of [summary, empty()]) assert.equal(renderWeeklyEmail(x).text, weeklyReportLines(x) + marker + serialize(x));
  const l = weeklyReportLines(summary);
  assert.ok(l.startsWith('ForgeMind weekly report\n'));
  assert.ok(l.includes('\nLast step reached\ncoding: 3\nterminal: 9'));
  assert.ok(!l.includes('Where runs stopped') && !l.includes('Evidence'));
  assert.ok(l.endsWith('Fixture runs excluded: 2'));
});
test('files stay under 500 lines', () => {
  for (const f of ['src/memory/weekly-email.ts', 'tests/memory/weekly-email.test.ts'])
    assert.ok(readFileSync(f, 'utf8').split('\n').length < 500);
});
