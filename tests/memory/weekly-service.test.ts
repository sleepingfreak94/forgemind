import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, cpSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest, serialize } from '../../src/context-engine/validation.js';
import type { TerminalRunInput } from '../../src/memory/run-contracts.js';
import { RunHistory } from '../../src/memory/run-history.js';
import { WeeklyService } from '../../src/memory/weekly-service.js';
import { validateWeeklySummary } from '../../src/memory/weekly-summary.js';
import { fixture } from './fixture.js';

function input(n: number): TerminalRunInput {
  return { schemaVersion: 1, runId: digest(`service fixture ${n}`), taskId: `task-${n}`, execution: 'fixture',
    startedAt: 1000, endedAt: 2000, outcome: 'blocked', lastPhase: 'setup', baselineSource: digest('service fixture source'),
    changedPaths: [], checks: [], terminalReceiptSha256: digest(`service fixture receipt ${n}`) };
}

test('more than 100 genuine history rows page through a fixed watermark and revoked trailing gaps', () => {
  const f = fixture(), history = new RunHistory(f.directory, f.root, () => 3000), service = new WeeklyService(f.directory, f.root);
  try {
    const rows = Array.from({ length: 205 }, (_, n) => history.record(input(n)));
    const upperInclusive = service.watermark(); assert.equal(upperInclusive, 205);
    for (const index of [102, 203, 204]) {
      const r = rows[index]!; history.revoke(r.id, r.digest);
    }
    const later = history.record(input(999)); assert.equal(later.sequence, 206);
    const options = { dueAt: 4000, lowerExclusive: 0, upperInclusive, maxBytes: 65536 };
    const summary = service.generate(options);
    assert.equal(summary.cursor, 205); assert.equal(summary.dependencyCount, 202);
    assert.equal(summary.selectedRuns, 0); assert.equal(summary.excludedFixtureCount, 202);
    assert.equal(summary.fixture.outcomes.blocked, 202); assert.equal(summary.authenticated.runs, 0);
    assert.deepEqual(validateWeeklySummary(JSON.parse(serialize(summary))), summary);
    assert.deepEqual(service.generate({ ...options, pageSize: 1 }), summary);
    assert.deepEqual(service.generate({ ...options, pageSize: 73 }), summary);
    const selected = service.generate({ ...options, executionSelection: 'all', pageSize: 100 });
    assert.equal(selected.selectedRuns, 202); assert.equal(selected.excludedFixtureCount, 0);
    assert.equal(selected.examples.length, 8); assert.equal(selected.omittedExamples, 194);
    assert.ok(selected.examples.every(e => e.sequence <= upperInclusive && e.execution === 'fixture'));
    assert.equal(service.generate({ dueAt: 4000, lowerExclusive: 0 }).dependencyCount, 203);
    assert.throws(() => validateWeeklySummary({ ...summary, dependencyCount: 201 }));
    assert.throws(() => validateWeeklySummary({ ...summary, originalRoot: f.base }));
    const oldBytes = serialize(selected), revoked = rows[0]!; history.revoke(revoked.id, revoked.digest);
    const fresh = service.generate({ ...options, executionSelection: 'all' });
    assert.equal(fresh.dependencyCount, 201); assert.notEqual(fresh.digest, selected.digest);
    assert.deepEqual(validateWeeklySummary(JSON.parse(oldBytes)), selected);
  } finally { service.close(); history.close(); f.dispose(); }
});

test('empty and cursor-only intervals finish without invented records; bounds and options reject', () => {
  const f = fixture(), service = new WeeklyService(f.directory, f.root);
  try {
    const empty = service.generate({ dueAt: 4000, lowerExclusive: 0 });
    assert.equal(empty.dependencyCount, 0); assert.equal(empty.cursor, 0);
    const gap = service.generate({ dueAt: 4000, lowerExclusive: 7, upperInclusive: 20 });
    assert.equal(gap.cursor, 20); assert.equal(gap.dependencyCount, 0);
    assert.equal(service.watermark(7), 7);
    for (const pageSize of [0, 101, NaN, 1.5]) assert.throws(() => service.generate({ dueAt: 4000, lowerExclusive: 0, pageSize }));
    assert.throws(() => service.generate({ dueAt: 4000, lowerExclusive: 3, upperInclusive: 2 }));
    assert.throws(() => service.generate({ dueAt: 4000, lowerExclusive: 0, maxBytes: 1 }));
    assert.throws(() => service.generate({ dueAt: 4000, lowerExclusive: 0, maxBytes: 65537 }));
    assert.throws(() => service.generate({ dueAt: 4000, lowerExclusive: 0, unknown: true } as never));
  } finally { service.close(); f.dispose(); }
});

test('same registered project in another root remains isolated and later scope drift rejects', () => {
  const f = fixture(), clone = join(f.base, 'clone'); cpSync(f.root, clone, { recursive: true });
  const history = new RunHistory(f.directory, f.root), otherHistory = new RunHistory(f.directory, clone);
  const service = new WeeklyService(f.directory, f.root), other = new WeeklyService(f.directory, clone);
  try {
    history.record(input(1)); otherHistory.record(input(2)); otherHistory.record(input(3));
    assert.equal(service.generate({ dueAt: 4000, lowerExclusive: 0 }).dependencyCount, 1);
    assert.equal(other.generate({ dueAt: 4000, lowerExclusive: 0 }).dependencyCount, 2);
    const path = join(f.root, 'config/forgemind-project.json');
    const profile = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...profile, projectId: 'changed' }));
    assert.throws(() => service.generate({ dueAt: 4000, lowerExclusive: 0 }), /scope changed/);
    assert.equal(other.watermark(), 2);
  } finally { other.close(); service.close(); otherHistory.close(); history.close(); f.dispose(); }
});

test('canonical and private storage requirements apply to the service', () => {
  const f = fixture();
  try {
    if (process.platform !== 'win32') {
      const alias = join(f.base, 'alias'); symlinkSync(f.root, alias);
      assert.throws(() => new WeeklyService(f.directory, alias), /canonical/);
    }
    if (typeof process.getuid === 'function') {
      chmodSync(f.directory, 0o755);
      assert.throws(() => new WeeklyService(f.directory, f.root), /private/);
      chmodSync(f.directory, 0o700);
    }
    const service = new WeeklyService(f.directory, f.root);
    try { assert.equal(service.watermark(), 0); } finally { service.close(); }
  } finally { f.dispose(); }
});
