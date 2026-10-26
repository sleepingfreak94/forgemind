import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
const entries = (brain: string, ws: string) => { const s = new BrainStore(brain, 'personal'); try { return s.list({ project: ws }); } finally { s.close(); } };
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
  assert.deepEqual(again, { ...result, lessons: 0 });
  if (result.recorded) assert.equal(result.lessons, 1);
  assert.equal(rows().length, 1);
});

const LESSON = 'auto-proposed from a harness run';

test('failed checks propose capped, unapproved lessons', () => {
  const { artifacts, input, brain, ws } = setup();
  put(artifacts, 'after-checks.json', ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, passed: false })).concat([{ id: 'ok', passed: true }]));
  const result = recordHarnessRun(input);
  assert.ok(result.recorded && result.lessons === 3);
  const all = entries(brain, ws);
  assert.deepEqual(all.map(e => e.text).sort(), ['a', 'b', 'c'].map(id => `Check ${id} failed after the change in Add a thing.`));
  for (const e of all) {
    assert.equal(e.kind, 'lesson'); assert.equal(e.status, 'proposed'); assert.equal(e.reason, LESSON);
    assert.deepEqual(e.evidence, ['task-1', 'task-1-abc']);
  }
  const s = new BrainStore(brain, 'personal');
  try { assert.deepEqual(s.approved(ws), []); } finally { s.close(); }
});

for (const verdict of ['revise', 'blocked']) {
  test(`${verdict} review findings propose lessons`, () => {
    const { artifacts, input, brain, ws } = setup();
    put(artifacts, 'review.json', { verdict, findings: ['one', 'x'.repeat(400), 'three', 'four'] });
    const result = recordHarnessRun(input);
    assert.ok(result.recorded && result.lessons === 3);
    const texts = entries(brain, ws).map(e => e.text);
    assert.equal(texts.length, 3);
    assert.ok(texts.includes(`Reviewer (${verdict}): one`));
    assert.ok(texts.includes(`Reviewer (${verdict}): ${'x'.repeat(300)}`));
    assert.ok(!texts.some(t => t.includes('four')));
  });
}

test('failure message proposes a run-stopped lesson', () => {
  const { artifacts, input, brain, ws } = setup();
  put(artifacts, 'failure.json', { message: 'y'.repeat(400) });
  const result = recordHarnessRun({ ...input, status: 'failed' });
  assert.ok(result.recorded && result.lessons === 1);
  const [e] = entries(brain, ws);
  assert.equal(e!.text, 'Run stopped: ' + 'y'.repeat(180));
  assert.equal(e!.status, 'proposed');
});

test('a passing run proposes no lessons', () => {
  const { artifacts, input, brain, ws } = setup();
  put(artifacts, 'after-checks.json', [{ id: 'build', passed: true }]);
  put(artifacts, 'review.json', { verdict: 'pass', findings: ['fine'] });
  const result = recordHarnessRun(input);
  assert.ok(result.recorded && result.lessons === 0);
  assert.equal(entries(brain, ws).length, 0);
});

test('secret-looking findings are skipped', () => {
  const { artifacts, input, brain, ws } = setup();
  put(artifacts, 'review.json', { verdict: 'revise', findings: ['token: abc', 'clean finding'] });
  const result = recordHarnessRun(input);
  assert.ok(result.recorded && result.lessons === 1);
  assert.deepEqual(entries(brain, ws).map(e => e.text), ['Reviewer (revise): clean finding']);
});

test('recording the same run twice proposes nothing new', () => {
  const { artifacts, input, brain, ws } = setup();
  put(artifacts, 'after-checks.json', [{ id: 'tests', passed: false }]);
  const first = recordHarnessRun(input), second = recordHarnessRun(input);
  assert.ok(first.recorded && first.lessons === 1);
  assert.ok(second.recorded && second.lessons === 0);
  assert.equal(entries(brain, ws).length, 1);
});

test('titles use the first sentence, capped', () => {
  const title = (objective: string) => { const s = setup(); recordHarnessRun({ ...s.input, objective }); return s.rows()[0]!.title; };
  assert.equal(title('Fix bugs. Then more'), 'Fix bugs');
  assert.equal(title('Scope: details'), 'Scope');
  assert.equal(title('Line one\nline two'), 'Line one');
  const long = title('a'.repeat(200));
  assert.equal(long.length, 120);
  assert.ok(long.endsWith('…'));
  assert.equal(title('b'.repeat(120)), 'b'.repeat(120));
  assert.equal(title('   '), 'task-1');
});

test('failed run records the failure message', () => {
  const { artifacts, input, rows } = setup();
  put(artifacts, 'failure.json', { message: 'boom '.repeat(100) });
  assert.equal(recordHarnessRun({ ...input, status: 'failed' }).recorded, true);
  const outcome = rows()[0]!.outcome;
  assert.ok(outcome.startsWith('failed: boom'));
  assert.ok(outcome.length <= 'failed: '.length + 180);
});

test('unmapped workspace records in the personal space', () => {
  const { input, rows, ws } = setup(false);
  const result = recordHarnessRun(input);
  assert.equal(result.recorded, true);
  if (result.recorded) assert.equal(result.space, 'personal');
  const all = rows();
  assert.equal(all.length, 1); assert.equal(all[0]!.project, ws);
});

test('unmapped workspaces share space-wide entries but keep project entries and history apart', () => {
  const a = setup(false);
  const ws2 = join(root, `case${counter++}`, 'ws2'), art2 = join(ws2, '..', 'runs', 'task-2-abc', 'artifacts');
  mkdirSync(ws2, { recursive: true }); mkdirSync(art2, { recursive: true });
  const store = new BrainStore(a.brain, 'personal');
  let wide: string, mine: string;
  try {
    const base = { kind: 'convention' as const, reason: 'r', evidence: [] };
    wide = store.propose({ ...base, project: null, text: 'Wide rule' }); store.approve(wide);
    mine = store.propose({ ...base, project: a.ws, text: 'Own rule' }); store.approve(mine);
  } finally { store.close(); }
  assert.equal(recordHarnessRun(a.input).recorded, true);
  assert.equal(recordHarnessRun({ ...a.input, workspace: ws2, taskId: 'task-2', artifacts: art2 }).recorded, true);
  const s = new BrainStore(a.brain, 'personal');
  try {
    assert.deepEqual(s.approved(a.ws).map(e => e.id).sort(), [wide, mine].sort());
    assert.deepEqual(s.approved(ws2).map(e => e.id), [wide]);
    assert.deepEqual(s.history(a.ws).map(h => h.project), [a.ws]);
    assert.deepEqual(s.history(ws2).map(h => h.project), [ws2]);
  } finally { s.close(); }
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
