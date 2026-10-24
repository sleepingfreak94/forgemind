import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrainStore } from '../../src/memory/brain.js';
import { mapBrainSpace } from '../../src/memory/brain-spaces.js';
import { recordHarnessRun } from '../../src/memory/brain-runs.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'brain-runs-')));
after(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
function setup(map = true) {
  const base = join(root, `case${counter++}`);
  const brain = join(base, 'brain'), ws = join(base, 'ws'), artifacts = join(base, 'runs', 'task-1-abc', 'artifacts');
  mkdirSync(ws, { recursive: true }); mkdirSync(artifacts, { recursive: true });
  if (map) { mapBrainSpace(ws, 'personal', brain); chmodSync(brain, 0o700); }
  const input = { brainDirectory: brain, workspace: ws, taskId: 'task-1', objective: 'Add a thing', artifacts, status: 'completed' };
  const rows = () => { const s = new BrainStore(brain, 'personal'); try { return s.history(ws); } finally { s.close(); } };
  return { brain, ws, artifacts, input, rows };
}
const put = (dir: string, name: string, value: unknown) => writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));

test('full artifacts are recorded', () => {
  const { artifacts, input, rows, ws } = setup();
  put(artifacts, 'changes.json', { summary: 'Added the thing', edits: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }] });
  put(artifacts, 'after-checks.json', [{ id: 'build', passed: true }, { id: 'tests', passed: false }]);
  put(artifacts, 'review.json', { verdict: 'approve' });
  const result = recordHarnessRun({ ...input, prUrl: 'https://github.com/o/r/pull/1' });
  assert.equal(result.recorded, true);
  if (result.recorded) assert.equal(result.space, 'personal');
  const [row] = rows();
  assert.equal(row!.project, ws);
  assert.equal(row!.title, 'Add a thing');
  assert.match(row!.summary, /Added the thing/);
  assert.match(row!.summary, /Review: approve\./);
  assert.match(row!.summary, /Checks: build pass, tests fail/);
  assert.deepEqual(row!.files, ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(row!.evidence, ['task-1', 'https://github.com/o/r/pull/1']);
  assert.equal(row!.outcome, 'completed');
  const again = recordHarnessRun({ ...input, prUrl: 'https://github.com/o/r/pull/1' });
  assert.deepEqual(again, result);
  assert.equal(rows().length, 1);
});

test('failed run records the failure message', () => {
  const { artifacts, input, rows } = setup();
  put(artifacts, 'failure.json', { message: 'boom '.repeat(100) });
  assert.equal(recordHarnessRun({ ...input, status: 'failed' }).recorded, true);
  const outcome = rows()[0]!.outcome;
  assert.ok(outcome.startsWith('failed: boom'));
  assert.ok(outcome.length <= 'failed: '.length + 180);
});

test('unmapped workspace records nothing', () => {
  const { brain, input } = setup(false);
  assert.deepEqual(recordHarnessRun(input), { recorded: false, reason: 'project not mapped to a brain space' });
  assert.equal(existsSync(join(brain, 'personal')), false);
});

test('missing artifacts still record a minimal run', () => {
  const { input, rows } = setup();
  rmSync(input.artifacts, { recursive: true });
  assert.equal(recordHarnessRun(input).recorded, true);
  const [row] = rows();
  assert.equal(row!.summary, ''); assert.deepEqual(row!.files, []);
});

test('secret-looking summary is redacted', () => {
  const { artifacts, input, rows } = setup();
  put(artifacts, 'changes.json', { summary: 'token: abc', edits: [] });
  assert.equal(recordHarnessRun(input).recorded, true);
  assert.equal(rows()[0]!.summary, '[redacted]');
});

test('unparsable files are ignored', () => {
  const { artifacts, input, rows } = setup();
  put(artifacts, 'changes.json', '{bad'); put(artifacts, 'review.json', 'nope');
  assert.doesNotThrow(() => recordHarnessRun(input));
  assert.equal(rows().length, 1);
});
