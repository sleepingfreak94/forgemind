import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTask } from '../../src/live-workflow/orchestrator.js';
import { CURSOR_PHASE_MODELS } from '../../src/live-workflow/routing-profile.js';
import type { LiveTask, ModelPort, ToolCodingRequest } from '../../src/live-workflow/contracts.js';

const darwin = { skip: process.platform !== 'darwin' || process.env.FORGEMIND_NESTED_SANDBOX === '1', timeout: 90000 };
const node = realpathSync(process.execPath);
const marker = (file: string, text: string) => ({ executable: node, timeoutMs: 10000,
  args: ['-e', `process.exit(require('fs').readFileSync('${file}','utf8')==='${text}'?0:1)`] });
function repo(planReview: string, overrides: Partial<LiveTask> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fm-split-'))), work = join(root, 'repo');
  mkdirSync(join(work, 'config'), { recursive: true }); mkdirSync(join(root, 'worktrees'));
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: work, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'f@example.invalid'); git('config', 'user.name', 'F');
  git('remote', 'add', 'origin', 'https://github.com/fixture/project.git');
  writeFileSync(join(work, 'config/forgemind-project.json'), JSON.stringify({ schemaVersion: 1, projectId: 'f', name: 'F',
    documents: { prd: 'docs/PRD.md', srs: 'docs/SRS.md', adrs: 'docs/adr' }, preferences: { askAt: 'project', draftPr: false, evidence: 'text', planReview } }));
  writeFileSync(join(work, 'a.txt'), 'a0'); writeFileSync(join(work, 'b.txt'), 'b0');
  git('add', '.'); git('commit', '-q', '-m', 'fixture');
  const task: LiveTask = { schemaVersion: 1, taskId: 'split-task', objective: 'Change a and b', readPaths: ['a.txt', 'b.txt'],
    writePaths: ['a.txt', 'b.txt'], checks: [{ id: 'a', ...marker('a.txt', 'A1') }, { id: 'b', ...marker('b.txt', 'B1') }],
    model: 'claude-sonnet-5-5', provider: 'anthropic', effort: 'low', maxModelRequests: 6, maxPromptBytes: 131072, maxOutputBytes: 262144,
    maxRuntimeMs: 120000, draftPr: false, split: true, ...overrides };
  return { root, work, task, close: () => rmSync(root, { recursive: true, force: true }) };
}
const planAnswer = { objective: 'Change a and b', paths: ['a.txt', 'b.txt'], steps: ['Edit a', 'Edit b'], acceptanceCriteria: ['a and b changed'], risks: [] };
const subtaskList = [{ title: 'Edit a', objective: 'Set a', writePaths: ['a.txt'], checks: ['a'] },
  { title: 'Edit b', objective: 'Set b', writePaths: ['b.txt'], checks: ['b'] }];
const edit = (input: any, path: string, content: string) => ({ summary: `Set ${path}`,
  edits: [{ path, beforeSha256: input.sources.find((s: any) => s.path === path).sha256, content }] });

function harness(codingAnswers: ((input: any) => unknown)[], plan: unknown = { ...planAnswer, subtasks: subtaskList }, codeWithTools?: (n: number, r: ToolCodingRequest) => Promise<{ summary: string }>) {
  const log = { coding: [] as any[], review: [] as any[], confirmed: [] as any[], tools: 0 };
  const factory = (): ModelPort => ({
    complete: (async (_i: string, input: any, _s: unknown, _g: unknown, phase: string) => {
      if (phase === 'plan') return structuredClone(plan);
      if (phase === 'review') { log.review.push(input); return { verdict: 'pass', findings: [], acceptance: ['ok'] }; }
      log.coding.push(input); return codingAnswers[log.coding.length - 1]!(input);
    }) as never,
    ...(codeWithTools ? { codeWithTools: async (request: ToolCodingRequest) => codeWithTools(++log.tools, request) } : {}),
  });
  return { log, factory };
}
const run = (f: ReturnType<typeof repo>, h: ReturnType<typeof harness>, confirm = true, brainContext?: string) => runTask({ workspace: f.work, task: f.task,
  stateDirectory: join(f.root, 'state'), worktreeDirectory: join(f.root, 'worktrees'),
  confirmPlan: async plan => { h.log.confirmed.push(plan); return confirm; }, modelFactory: h.factory,
  ...(brainContext !== undefined ? { brainContext } : {}) });
const phaseCount = (artifacts: string, name: string) =>
  JSON.parse(readFileSync(join(artifacts, 'receipt.json'), 'utf8')).phases.filter((p: { name: string }) => p.name === name).length;

test('a split task codes and checks each subtask in turn and merges one candidate', darwin, async () => {
  const f = repo('auto');
  try {
    const h = harness([i => edit(i, 'a.txt', 'A1'), i => edit(i, 'b.txt', 'B1')]);
    const result = await run(f, h, true, 'brain: prefer small edits');
    assert.equal(result.status, 'completed-local');
    assert.equal(h.log.coding.length, 2);
    for (const c of h.log.coding) assert.equal(c.brain, 'brain: prefer small edits');
    assert.equal(h.log.confirmed.length, 1);
    assert.equal(h.log.confirmed[0].subtasks.length, 2);
    for (const n of [1, 2]) {
      assert.ok(existsSync(join(result.artifacts, `subtask-${n}-checks.json`)));
      assert.equal(JSON.parse(readFileSync(join(result.artifacts, `subtask-${n}-checks.json`), 'utf8'))[0].passed, true);
    }
    assert.ok(existsSync(join(result.artifacts, 'subtask-2-checks.json')));
    assert.equal(phaseCount(result.artifacts, 'subtask'), 2);
    assert.equal(h.log.coding[1].subtask.index, 2);
    assert.equal(h.log.coding[1].earlier[0].title, 'Edit a');
    assert.equal(h.log.coding[1].sources.find((s: any) => s.path === 'a.txt').content, 'A1');
    assert.ok(h.log.review[0].diff.includes('a.txt') && h.log.review[0].diff.includes('b.txt'));
  } finally { f.close(); }
});

test('a split task needs plan approval even when the project only shows plans', darwin, async () => {
  const f = repo('show');
  try {
    const h = harness([]);
    const result = await run(f, h, false);
    assert.equal(result.status, 'needs-plan-approval');
    assert.equal(h.log.coding.length, 0);
    assert.equal(h.log.confirmed.length, 1);
  } finally { f.close(); }
});

test('a subtask that fails its checks stops the run before the next subtask', darwin, async () => {
  const f = repo('auto');
  try {
    const h = harness([i => edit(i, 'a.txt', 'wrong'), i => edit(i, 'b.txt', 'B1')]);
    await assert.rejects(run(f, h), /Subtask 1 of 2/);
    assert.equal(h.log.coding.length, 1);
  } finally { f.close(); }
});

test('a Cursor task splits through single-call coding', darwin, async () => {
  const f = repo('auto', { provider: 'cursor', model: CURSOR_PHASE_MODELS.coding });
  try {
    const h = harness([i => edit(i, 'a.txt', 'A1'), i => edit(i, 'b.txt', 'B1')]);
    const result = await run(f, h);
    assert.equal(result.status, 'completed-local');
    assert.equal(h.log.coding.length, 2);
    assert.equal(phaseCount(result.artifacts, 'subtask'), 2);
  } finally { f.close(); }
});

test('tools-mode split runs one session per subtask and refuses writes outside the subtask', darwin, async () => {
  const f = repo('auto', { codingMode: 'tools', maxToolCalls: 6 });
  const seen: any = {};
  try {
    const h = harness([], undefined, async (n, request) => {
      const call = async (name: string, args: unknown) => request.call(name, args);
      const hash = async (path: string) => JSON.parse((await call('host_read', { path })).text).sha256 as string;
      if (n === 1) {
        seen.refused = await call('host_apply', { summary: 'x', edits: [{ path: 'b.txt', beforeSha256: await hash('b.txt'), content: 'B1' }] });
        seen.b = JSON.parse((await call('host_read', { path: 'b.txt' })).text).content;
        await call('host_apply', { summary: 'Set a', edits: [{ path: 'a.txt', beforeSha256: await hash('a.txt'), content: 'A1' }] });
        seen.check = JSON.parse((await call('host_check', { id: 'a' })).text)[0].passed;
        return { summary: 'Set a' };
      }
      await call('host_apply', { summary: 'Set b', edits: [{ path: 'b.txt', beforeSha256: await hash('b.txt'), content: 'B1' }] });
      return { summary: 'Set b' };
    });
    const result = await run(f, h);
    assert.equal(result.status, 'completed-local');
    assert.equal(h.log.tools, 2);
    assert.equal(seen.refused.isError, true);
    assert.equal(seen.b, 'b0');
    assert.equal(seen.check, true);
    assert.equal(readFileSync(join(result.worktree!, 'b.txt'), 'utf8'), 'B1');
  } finally { f.close(); }
});

test('without split a plan answer with subtasks is refused', darwin, async () => {
  const f = repo('auto');
  delete (f.task as { split?: true }).split;
  try {
    const h = harness([i => edit(i, 'a.txt', 'A1')]);
    await assert.rejects(run(f, h));
    assert.equal(h.log.coding.length, 0);
  } finally { f.close(); }
});
