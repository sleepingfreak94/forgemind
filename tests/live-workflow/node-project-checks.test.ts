import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChecks } from '../../src/live-workflow/checks.js';
import { nodeProjectRuntime } from '../../src/live-workflow/check-runtime.js';
import type { CheckRuntime } from '../../src/live-workflow/check-runtime.js';
import { runTask } from '../../src/live-workflow/orchestrator.js';
import type { CheckCommand, LiveTask } from '../../src/live-workflow/contracts.js';

const repo = realpathSync(fileURLToPath(new URL('../../..', import.meta.url)));
const node = realpathSync(process.execPath);
const nativeTsc = join(repo, 'node_modules', '@typescript', `typescript-${process.platform}-${process.arch}`, 'lib', 'tsc');
const darwin = { skip: process.platform !== 'darwin' || process.env.FORGEMIND_NESTED_SANDBOX === '1', timeout: 120000 };
const authority = { reserve: (_: unknown) => ({ check() {}, finish() {} }) };
const nodeCheck = (id: string, args: string[], executable = node): CheckCommand => ({ id, executable, profile: 'node-project', timeoutMs: 60000, args });
/** Passes only when `body` fails with a sandbox denial (EPERM/EACCES), not any other error. */
const denied = (id: string, body: string) => nodeCheck(id, ['-e',
  `const done=e=>process.exit(e&&(e.code==='EPERM'||e.code==='EACCES')?0:(console.error(e&&e.code),2));try{${body}}catch(e){done(e)}`]);

function fixture(ignore = '/node_modules\n.env\n') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fm-node-project-'))), root = join(dir, 'project'), scratch = join(dir, 'scratch');
  mkdirSync(join(root, 'src'), { recursive: true }); mkdirSync(scratch);
  copyFileSync(join(repo, 'package-lock.json'), join(root, 'package-lock.json'));
  writeFileSync(join(root, 'src/value.ts'), 'export const value: number = 2;\n');
  writeFileSync(join(root, 'src/value.test.ts'),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from './value.js';\ntest('value', () => assert.equal(value, 2));\n");
  writeFileSync(join(root, '.gitignore'), ignore);
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=F', '-c', 'user.email=f@example.invalid', ...args], { cwd: root });
  git('init', '-q'); git('add', '.'); git('commit', '-q', '-m', 'fixture');
  if (ignore.includes('.env')) writeFileSync(join(root, '.env'), 'SECRET=x\n');
  return { dir, root, scratch, runtime: nodeProjectRuntime(join(repo, 'node_modules')), close: () => rmSync(dir, { recursive: true, force: true }) };
}
const signal = () => AbortSignal.timeout(110000);
const run = (f: ReturnType<typeof fixture>, commands: CheckCommand[], runtime: CheckRuntime | undefined = f.runtime, abort = signal()) =>
  runChecks(f.root, 'source', commands, f.scratch, authority as never, abort, runtime);

test('a node-project phase builds with the native compiler and tests in one process, leaving source untouched', darwin, async () => {
  const f = fixture();
  try {
    const results = await run(f, [
      nodeCheck('build', ['--outDir', '{scratch}/out', '--module', 'nodenext', '--target', 'es2022',
        '--typeRoots', '{nodeModules}/@types', '--types', 'node', 'src/value.ts', 'src/value.test.ts'], nativeTsc),
      nodeCheck('test', ['--test', '--test-isolation=none', '{scratch}/out/value.test.js']),
      nodeCheck('nested-flag', ['-e', "process.exit(process.env.FORGEMIND_NESTED_SANDBOX === '1' ? 0 : 1)"]),
    ]);
    assert.deepEqual(results.map(r => [r.id, r.passed]), [['build', true], ['test', true], ['nested-flag', true]], JSON.stringify(results));
    assert.equal(results[0]!.stdout, '', 'TypeScript reported no diagnostics');
    assert.match(results[1]!.stdout, /pass 1/);
    assert.deepEqual(readdirSync(f.root).sort(), ['.env', '.git', '.gitignore', 'package-lock.json', 'src'], 'source untouched and the node_modules link removed');
    assert.equal(readdirSync(f.scratch).length, 1, 'one shared scratch for the phase');
  } finally { f.close(); }
});

test('node-project checks cannot start processes, reach the network, write outside scratch or read secrets', darwin, async () => {
  const f = fixture();
  try {
    const results = await run(f, [
      denied('shell', "require('child_process').execFileSync('/bin/sh',['-c','true'])"),
      denied('node-child', "require('child_process').execFileSync(process.execPath,['-e','0'])"),
      denied('detached-child', "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}).on('error',done).on('spawn',()=>process.exit(1))"),
      denied('network', "require('net').connect(443,'1.1.1.1').on('error',done).on('connect',()=>process.exit(1))"),
      denied('source-write', "require('fs').writeFileSync('src/injected.ts','x')"),
      denied('node-modules-write', `require('fs').writeFileSync(${JSON.stringify(join(repo, 'node_modules', '.fm-probe'))},'x')`),
      denied('linked-node-modules-write', "require('fs').writeFileSync(process.env.HOME+'/node_modules/.fm-probe','x')"),
      denied('git-read', "require('fs').readFileSync('.git/HEAD')"),
      denied('env-read', "require('fs').readFileSync('.env')"),
    ]);
    assert.deepEqual(results.filter(r => !r.passed).map(r => [r.id, r.stderr.trim().slice(0, 80)]), [], JSON.stringify(results));
    assert.equal(existsSync(join(f.root, 'src/injected.ts')), false);
    assert.equal(existsSync(join(repo, 'node_modules', '.fm-probe')), false);
  } finally { f.close(); }
});

test('single-process checks interleave without node_modules access and the shared scratch survives them', darwin, async () => {
  const f = fixture();
  try {
    const single: CheckCommand = { id: 'single', executable: node, timeoutMs: 60000,
      args: ['-e', `try{require('fs').readFileSync(${JSON.stringify(join(repo, 'node_modules', 'typescript', 'package.json'))});process.exit(1)}catch(e){process.exit(e.code==='EPERM'?0:2)}`] };
    const results = await run(f, [
      nodeCheck('mark', ['-e', "require('fs').writeFileSync(process.argv[1],'x')", '{scratch}/marker']),
      single,
      nodeCheck('read-mark', ['-e', "require('fs').readFileSync(process.argv[1])", '{scratch}/marker']),
    ]);
    assert.deepEqual(results.map(r => [r.id, r.passed]), [['mark', true], ['single', true], ['read-mark', true]], JSON.stringify(results));
    assert.equal(readdirSync(f.scratch).length, 2, 'the single-process check had its own scratch');
  } finally { f.close(); }
});

test('the worktree link is removed after a failing or aborted check', darwin, async () => {
  const f = fixture();
  try {
    const [failed] = await run(f, [nodeCheck('fail', ['-e', 'process.exit(1)'])]);
    assert.equal(failed!.passed, false);
    assert.equal(existsSync(join(f.root, 'node_modules')), false);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);
    await assert.rejects(run(f, [nodeCheck('hang', ['-e', 'setInterval(()=>{},1000)'])], f.runtime, controller.signal));
    assert.equal(existsSync(join(f.root, 'node_modules')), false);
  } finally { f.close(); }
});

test('node-project checks are refused without a genuine, matching runtime or with another executable', darwin, async () => {
  const f = fixture();
  try {
    const probe = nodeCheck('probe', ['-e', '0']);
    await assert.rejects(runChecks(f.root, 'source', [probe], f.scratch, authority as never, signal()), /require an owner-selected --node-modules/);
    await assert.rejects(run(f, [probe], { ...f.runtime }), /Untrusted check runtime/);
    await assert.rejects(run(f, [{ ...probe, executable: '/bin/echo' }]), /pinned Node runtime or a tool inside/);
    writeFileSync(join(f.root, 'package-lock.json'), '{}');
    await assert.rejects(run(f, [probe]), /does not match the selected node_modules/);
    assert.throws(() => nodeProjectRuntime(repo + '/node_modules/../node_modules'), /Canonical node_modules/);
    assert.throws(() => nodeProjectRuntime(join(repo, 'src')), /Canonical node_modules/);
  } finally { f.close(); }
});

test('the node_modules link must be ignored and must not replace a different node_modules', darwin, async () => {
  const unignored = fixture('');
  try {
    await assert.rejects(run(unignored, [nodeCheck('probe', ['-e', '0'])]), /would change source identity/);
    assert.equal(existsSync(join(unignored.root, 'node_modules')), false, 'refused link is removed');
  } finally { unignored.close(); }
  const foreign = fixture();
  try {
    mkdirSync(join(foreign.root, 'node_modules'));
    await assert.rejects(run(foreign, [nodeCheck('probe', ['-e', '0'])]), /not the selected node_modules/);
  } finally { foreign.close(); }
});

test('a task with node-project checks is refused before any worktree without an owner runtime', async () => {
  const task: LiveTask = { schemaVersion: 1, taskId: 'np-task', objective: 'x', readPaths: ['value.txt'], writePaths: ['value.txt'],
    checks: [nodeCheck('build', ['-e', '0'])], model: 'gpt-test', effort: 'low', maxModelRequests: 3, maxPromptBytes: 65536,
    maxOutputBytes: 65536, maxRuntimeMs: 60000, draftPr: false };
  const state = join(tmpdir(), 'fm-np-never-' + process.pid);
  await assert.rejects(runTask({ workspace: '/nonexistent', task, stateDirectory: state, worktreeDirectory: state,
    modelFactory: () => ({ complete: async () => ({}) }), confirmPlan: async () => false }), /require an owner-selected --node-modules/);
  assert.equal(existsSync(state), false);
});
