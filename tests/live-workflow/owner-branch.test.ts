import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTask } from '../../src/live-workflow/orchestrator.js';
import { sha256 } from '../../src/live-workflow/validation.js';
import type { LiveTask } from '../../src/live-workflow/contracts.js';

// Generous budgets: under the full parallel suite a 60 s run budget ran out (each run is about 30 s alone).
const darwin = { skip: process.platform !== 'darwin', timeout: 300000 };
const author = { name: 'Branch Owner', email: '123+owner@users.noreply.github.com' };

/** A project on the owner's own branch feature/abc-123, and a fixture model that plans, edits value.txt and passes review. */
function fixture(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fm-owner-branch-'))), repo = join(root, 'repo');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(repo, 'config'), { recursive: true }); mkdirSync(join(root, 'worktrees'));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-b', 'main'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
  git('remote', 'add', 'origin', 'https://github.com/fixture/project.git');
  writeFileSync(join(repo, 'config/forgemind-project.json'), JSON.stringify({ schemaVersion: 1, projectId: 'fixture', name: 'Fixture',
    documents: { prd: 'docs/PRD.md', srs: 'docs/SRS.md', adrs: 'docs/adr' },
    preferences: { askAt: 'project', draftPr: false, evidence: 'text', planReview: 'show' } }));
  writeFileSync(join(repo, 'value.txt'), 'before'); writeFileSync(join(repo, 'notes.txt'), 'main');
  git('add', '.'); git('commit', '-m', 'fixture');
  // The owner's branch already has its own earlier commit, outside the task's write paths.
  git('switch', '-c', 'feature/abc-123'); writeFileSync(join(repo, 'notes.txt'), 'ticket notes'); git('commit', '-am', 'ticket notes');
  const start = git('rev-parse', 'HEAD');
  const task: LiveTask = { schemaVersion: 1, taskId: 'fix-value', objective: 'Change value to after', readPaths: ['value.txt'],
    writePaths: ['value.txt'], checks: [{ id: 'value', executable: realpathSync(process.execPath),
      args: ['-e', "process.exit(require('fs').readFileSync('value.txt','utf8')==='after'?0:1)"], timeoutMs: 5000 }],
    model: 'fixture-model', effort: 'low', maxModelRequests: 3, maxPromptBytes: 65536, maxOutputBytes: 65536, maxRuntimeMs: 240000, draftPr: false };
  let calls = 0;
  const outputs = [
    { objective: task.objective, paths: ['value.txt'], steps: ['Fix value'], acceptanceCriteria: ['Value is after'], risks: [] },
    { summary: 'Correct value', edits: [{ path: 'value.txt', beforeSha256: sha256('before'), content: 'after' }] },
    { verdict: 'pass', findings: [], acceptance: ['Value is after'] },
  ];
  const options = { workspace: repo, task, stateDirectory: join(root, 'state'), worktreeDirectory: join(root, 'worktrees'),
    codexExecutable: '/missing', confirmPlan: async () => false, modelFactory: () => ({ complete: async () => outputs[calls++] }) };
  return { root, repo, git, task, start, options, calls: () => calls };
}

test('on the owner branch the reviewed commit lands in the project folder and the separate checkout is removed', darwin, async t => {
  const f = fixture(t);
  const result = await runTask({ ...f.options, commitAuthor: author });
  assert.equal(result.status, 'completed-local'); assert.equal(result.branch, 'feature/abc-123'); assert.equal(result.worktree, undefined);
  assert.equal(f.git('symbolic-ref', '--short', 'HEAD'), 'feature/abc-123');
  assert.equal(readFileSync(join(f.repo, 'value.txt'), 'utf8'), 'after');
  assert.equal(f.git('status', '--porcelain'), '');
  assert.equal(f.git('rev-parse', 'HEAD~1'), f.start, 'one commit on top of the owner branch');
  assert.equal(f.git('log', '-1', '--format=%an <%ae>'), 'Branch Owner <123+owner@users.noreply.github.com>');
  assert.equal(f.git('branch', '--list', 'task/*'), '');
  assert.equal(existsSync(join(f.root, 'worktrees', 'fix-value')), false);
  assert.equal(f.git('rev-parse', 'main'), f.git('rev-parse', 'feature/abc-123~2'), 'main is untouched');
});

test('the owner branch needs a commit author before any checkout is made', darwin, async t => {
  const f = fixture(t);
  await assert.rejects(runTask(f.options), /needs --author-name and --author-email/);
  assert.equal(f.git('branch', '--list', 'task/*'), ''); assert.equal(f.calls(), 0);
  assert.equal(f.git('rev-parse', 'HEAD'), f.start);
});

test('a project folder changed during the run is left untouched and the checkout is kept', darwin, async t => {
  const f = fixture(t);
  const onProgress = (message: string) => { if (/independent review/i.test(message)) writeFileSync(join(f.repo, 'value.txt'), 'owner edit'); };
  await assert.rejects(runTask({ ...f.options, commitAuthor: author, onProgress }), /Dirty source repository/);
  assert.equal(f.git('rev-parse', 'HEAD'), f.start, 'the owner branch did not move');
  assert.equal(readFileSync(join(f.repo, 'value.txt'), 'utf8'), 'owner edit');
  assert.ok(existsSync(join(f.root, 'worktrees', 'fix-value')), 'the run checkout is kept for inspection');
});

function interceptNetwork(t: test.TestContext, listed: unknown[]) {
  const network: { executable: string; args: string[] }[] = [];
  t.mock.method(childProcess, 'execFileSync', (executable: string, args: string[], options: unknown) => {
    const command = args[0]?.endsWith('/repository-supervisor.js')
      ? JSON.parse(Buffer.from(args[1]!, 'base64url').toString()) as { executable: string; args: string[] } : { executable, args };
    if (command.executable === 'gh' || command.executable === 'git' && command.args.includes('push')) {
      network.push(command);
      return Buffer.from(command.executable === 'git' ? '' : command.args[1] === 'list' ? JSON.stringify(listed) : 'https://github.com/fixture/project/pull/23\n');
    }
    return execFileSync(executable, args, options as Parameters<typeof execFileSync>[2]);
  });
  return network;
}
function helper(f: ReturnType<typeof fixture>) {
  const ghPath = join(f.root, 'gh');
  writeFileSync(ghPath, 'fixture helper; never executed'); chmodSync(ghPath, 0o755);
  return { author, gitCredentialHelper: { ghPath, sha256: sha256(readFileSync(ghPath)) } };
}

test('a draft PR on the owner branch pushes that branch from the project folder into the default branch', darwin, async t => {
  const f = fixture(t), network = interceptNetwork(t, []);
  f.task.draftPr = true;
  const result = await runTask({ ...f.options, publication: helper(f) });
  assert.equal(result.status, 'completed'); assert.equal(result.branch, 'feature/abc-123');
  assert.equal(result.prUrl, 'https://github.com/fixture/project/pull/23');
  const head = f.git('rev-parse', 'HEAD');
  assert.deepEqual(network.map(c => c.executable === 'gh' ? `gh ${c.args[1]}` : 'push'), ['gh list', 'push', 'gh create']);
  assert.ok(network[0]!.args.includes('feature/abc-123') && network[0]!.args.includes('main'));
  assert.ok(network[1]!.args.includes(`${head}:refs/heads/feature/abc-123`));
  assert.ok(!network[1]!.args.some(arg => /^(--force|-f|\+)/.test(arg)), 'never a force push');
  const create = network[2]!.args;
  assert.equal(create[create.indexOf('--head') + 1], 'feature/abc-123'); assert.equal(create[create.indexOf('--base') + 1], 'main');
});

test('an open PR for the owner branch is updated by the push instead of opening another', darwin, async t => {
  const f = fixture(t);
  const network = interceptNetwork(t, [{ url: 'https://github.com/fixture/project/pull/7', state: 'OPEN', isDraft: false,
    headRefOid: '0'.repeat(40), baseRefOid: '1'.repeat(40) }]);
  f.task.draftPr = true;
  const result = await runTask({ ...f.options, publication: helper(f) });
  assert.equal(result.prUrl, 'https://github.com/fixture/project/pull/7');
  assert.deepEqual(network.map(c => c.executable === 'gh' ? `gh ${c.args[1]}` : 'push'), ['gh list', 'push']);
});
