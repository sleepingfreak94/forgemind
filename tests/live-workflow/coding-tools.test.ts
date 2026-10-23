import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodingToolHost, codingTools, runToolCoding } from '../../src/live-workflow/coding-tools.js';
import { sourceIdentity } from '../../src/live-workflow/repository.js';
import { runTask } from '../../src/live-workflow/orchestrator.js';
import { sha256 } from '../../src/live-workflow/validation.js';
import type { LiveTask, ModelPort, ToolCodingRequest } from '../../src/live-workflow/contracts.js';

const darwin = { skip: process.platform !== 'darwin' || process.env.FORGEMIND_NESTED_SANDBOX === '1', timeout: 90000 };
const node = realpathSync(process.execPath);
function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fm-tools-'))), work = join(root, 'repo');
  mkdirSync(join(work, 'config'), { recursive: true }); mkdirSync(join(root, 'worktrees')); mkdirSync(join(root, 'checks'));
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: work, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'f@example.invalid'); git('config', 'user.name', 'F');
  git('remote', 'add', 'origin', 'https://github.com/fixture/project.git');
  writeFileSync(join(work, 'config/forgemind-project.json'), JSON.stringify({ schemaVersion: 1, projectId: 'f', name: 'F',
    documents: { prd: 'docs/PRD.md', srs: 'docs/SRS.md', adrs: 'docs/adr' }, preferences: { askAt: 'project', draftPr: false, evidence: 'text', planReview: 'show' } }));
  writeFileSync(join(work, 'value.txt'), 'before'); writeFileSync(join(work, 'notes.txt'), 'notes');
  git('add', '.'); git('commit', '-q', '-m', 'fixture');
  const task: LiveTask = { schemaVersion: 1, taskId: 'tools-task', objective: 'Change value to after', readPaths: ['value.txt', 'notes.txt'],
    writePaths: ['value.txt'], checks: [{ id: 'value', executable: node, timeoutMs: 10000,
      args: ['-e', "process.exit(require('fs').readFileSync('value.txt','utf8')==='after'?0:1)"] }],
    model: 'claude-sonnet-5-5', provider: 'anthropic', effort: 'low', maxModelRequests: 3, maxPromptBytes: 131072, maxOutputBytes: 262144,
    maxRuntimeMs: 60000, draftPr: false, codingMode: 'tools', maxToolCalls: 6 };
  return { root, work, git, task, close: () => rmSync(root, { recursive: true, force: true }) };
}
const reserved: string[] = [];
const phases: string[] = [];
const phaseData: [string, any][] = [];
const authority = { reserve: (e: { kind: string }) => { reserved.push(e.kind); return { check() {}, finish() {} }; },
  phase: (name: string, _source?: string, data?: unknown) => { phases.push(name); phaseData.push([name, data]); } };
const host = (f: ReturnType<typeof repo>, signal = new AbortController().signal) => new CodingToolHost({ root: f.work, task: f.task,
  source: sourceIdentity(f.work), authority: authority as never, checkDirectory: join(f.root, 'checks'), signal, boundary: () => signal.throwIfAborted() });
const parse = (r: { text: string }) => JSON.parse(r.text);

test('host tools read, apply and check within the exact grants; rejected calls leave the session usable', darwin, async () => {
  const f = repo();
  try {
    const h = host({ ...f, task: { ...f.task, maxToolCalls: 10 } });
    const read = parse(await h.call('host_read', { path: 'value.txt' }));
    assert.deepEqual(read, { path: 'value.txt', sha256: sha256('before'), content: 'before' });
    for (const [name, args, error] of [
      ['host_read', { path: 'config/forgemind-project.json' }, /outside the exact grant/],
      ['host_apply', { summary: 'x', edits: [{ path: 'notes.txt', beforeSha256: sha256('notes'), content: 'x' }] }, /./],
      ['host_apply', { summary: 'x', edits: [{ path: 'value.txt', beforeSha256: sha256('stale'), content: 'x' }] }, /./],
      ['host_check', { id: 'other' }, /outside the exact grant/],
    ] as const) {
      const r = await h.call(name, args);
      assert.equal(r.isError, true, name); assert.match(parse(r).error, error);
    }
    const start = h.source;
    assert.equal(parse(await h.call('host_check', { id: 'value' }))[0].passed, false);
    const applied = parse(await h.call('host_apply', { summary: 'Set value', edits: [{ path: 'value.txt', beforeSha256: sha256('before'), content: 'after' }] }));
    assert.deepEqual(applied.applied, ['value.txt']);
    assert.equal(applied.source, h.source); assert.equal(sourceIdentity(f.work), h.source);
    assert.equal(parse(await h.call('host_check', { id: 'value' }))[0].passed, true);
    const checks = phaseData.filter(([n]) => n === 'tool-check').map(([, d]) => d);
    assert.equal(checks.length, 2);
    assert.deepEqual(checks[0].tree, start); assert.deepEqual(checks[1].tree, h.source);
    assert.deepEqual(checks.map(c => c.checks), [['value'], ['value']]);
    assert.deepEqual(checks[0].results, [{ id: 'value', passed: false, exitCode: 1 }]);
    assert.deepEqual(checks[1].results, [{ id: 'value', passed: true, exitCode: 0 }]);
    assert.equal(h.calls, 8);
    assert.deepEqual(h.result('done').edits.map(e => e.path), ['value.txt']);
    assert.equal(readFileSync(join(f.work, 'notes.txt'), 'utf8'), 'notes');
    assert.ok(reserved.includes('artifact') && reserved.includes('command'));
    assert.deepEqual(phases, ['tool-check', 'tool-apply', 'tool-check']);
  } finally { f.close(); }
});

test('budget exhaustion, outside source changes and cancellation end the session for good', darwin, async () => {
  const f = repo();
  try {
    const h = host({ ...f, task: { ...f.task, maxToolCalls: 2 } });
    await h.call('host_read', { path: 'value.txt' }); await h.call('host_read', { path: 'value.txt' });
    await assert.rejects(h.call('host_read', { path: 'value.txt' }), /budget exhausted/);
    await assert.rejects(h.call('host_read', { path: 'value.txt' }), /budget exhausted/, 'stays stopped');
    const drift = host(f);
    writeFileSync(join(f.work, 'value.txt'), 'changed outside');
    await assert.rejects(drift.call('host_read', { path: 'value.txt' }), /Source changed outside host tools/);
    writeFileSync(join(f.work, 'value.txt'), 'before');
    const controller = new AbortController(), aborted = host(f, controller.signal);
    controller.abort();
    await assert.rejects(aborted.call('host_read', { path: 'value.txt' }));
    assert.throws(() => new CodingToolHost({ root: f.work, task: { ...f.task, codingMode: 'single-call' }, source: 'x', authority: authority as never,
      checkDirectory: f.root, signal: controller.signal, boundary() {} }), /not granted/);
  } finally { f.close(); }
});

test('a failure to record an applied edit or a check ends the session', darwin, async () => {
  for (const failing of ['tool-apply', 'tool-check']) {
    const f = repo();
    try {
      const local = { reserve: () => ({ check() {}, finish() {} }),
        phase: (name: string) => { if (name === failing) throw new Error('record failed'); } };
      const signal = new AbortController().signal;
      const h = new CodingToolHost({ root: f.work, task: f.task, source: sourceIdentity(f.work), authority: local as never,
        checkDirectory: join(f.root, 'checks'), signal, boundary: () => signal.throwIfAborted() });
      if (failing === 'tool-apply')
        await assert.rejects(h.call('host_apply', { summary: 'x', edits: [{ path: 'value.txt', beforeSha256: sha256('before'), content: 'after' }] }), /record failed/);
      else await assert.rejects(h.call('host_check', { id: 'value' }), /record failed/);
      assert.match(h.fatal?.message ?? '', /record failed/);
      await assert.rejects(h.call('host_read', { path: 'value.txt' }), /record failed/);
    } finally { f.close(); }
  }
});

/** Stands in for Claude: plans and reviews with complete(), codes by calling host tools. */
function toolModel(calls: (request: ToolCodingRequest) => Promise<void>): ModelPort {
  const answers = [{ objective: 'Change value to after', paths: ['value.txt'], steps: ['Edit value'], acceptanceCriteria: ['value is after'], risks: [] },
    { verdict: 'pass', findings: [], acceptance: ['value is after'] }];
  return { complete: async () => answers.shift(), codeWithTools: async request => { await calls(request); return { summary: 'Set value to after' }; } };
}

test('a tools-mode task codes through host tools inside the real pipeline and is reviewed from its diff', darwin, async () => {
  const f = repo();
  const seen: string[] = [];
  try {
    const result = await runTask({ workspace: f.work, task: f.task, stateDirectory: join(f.root, 'state'), worktreeDirectory: join(f.root, 'worktrees'),
      confirmPlan: async () => false, modelFactory: (runAuthority, source) => toolModel(async request => {
        // Like NativeClaudeModel: one provider receipt held across the whole session, checked after edits.
        const provider = runAuthority.reserve({ kind: 'provider', source: source(), detail: { phase: 'coding' } });
        provider.check();
        assert.deepEqual(request.tools.map(t => t.name), codingTools.map(t => t.name));
        assert.equal(request.maxToolCalls, 6);
        const read = JSON.parse((await request.call('host_read', { path: 'value.txt' })).text);
        await request.call('host_apply', { summary: 'Set value', edits: [{ path: 'value.txt', beforeSha256: read.sha256, content: 'after' }] });
        const check = JSON.parse((await request.call('host_check', { id: 'value' })).text);
        seen.push(String(check[0].passed));
        request.assertCurrent();
        provider.check();
        provider.finish('completed', sha256('session'));
      }) });
    assert.equal(result.status, 'completed-local');
    assert.deepEqual(seen, ['true']);
    assert.equal(readFileSync(join(result.worktree!, 'value.txt'), 'utf8'), 'after');
    assert.equal(readFileSync(join(f.work, 'value.txt'), 'utf8'), 'before');
    assert.match(readFileSync(join(result.artifacts, 'candidate.patch'), 'utf8'), /\+after/);
    const receipt = JSON.parse(readFileSync(join(result.artifacts, 'receipt.json'), 'utf8'));
    assert.ok(receipt.phases.some((p: { name: string }) => p.name === 'tool-apply'));
  } finally { f.close(); }
});

test('tools mode is refused for a model that cannot drive host tools, and an edit-free session fails', darwin, async () => {
  const f = repo();
  try {
    const signal = new AbortController().signal;
    const options = { root: f.work, task: f.task, source: sourceIdentity(f.work), authority: authority as never, checkDirectory: join(f.root, 'checks'),
      signal, boundary() {}, input: {} };
    await assert.rejects(runToolCoding({ complete: async () => ({}) }, options), /requires a route that can drive host tools/);
    await assert.rejects(runToolCoding(toolModel(async () => {}), options), /applied no edits/);
  } finally { f.close(); }
});
