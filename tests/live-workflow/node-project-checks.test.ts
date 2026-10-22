import test from 'node:test';
import assert from 'node:assert/strict';
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
const darwin = { skip: process.platform !== 'darwin' || process.env.FORGEMIND_NESTED_SANDBOX === '1', timeout: 120000 };
const authority = { reserve: (_: unknown) => ({ check() {}, finish() {} }) };
const nodeCheck = (id: string, args: string[]): CheckCommand => ({ id, executable: node, profile: 'node-project', timeoutMs: 60000, args });

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fm-node-project-'))), root = join(dir, 'project'), scratch = join(dir, 'scratch');
  mkdirSync(join(root, 'src'), { recursive: true }); mkdirSync(scratch);
  copyFileSync(join(repo, 'package-lock.json'), join(root, 'package-lock.json'));
  writeFileSync(join(root, 'src/value.ts'), 'export const value: number = 2;\n');
  writeFileSync(join(root, 'src/value.test.ts'),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from './value.js';\ntest('value', () => assert.equal(value, 2));\n");
  return { dir, root, scratch, runtime: nodeProjectRuntime(join(repo, 'node_modules')), close: () => rmSync(dir, { recursive: true, force: true }) };
}
const signal = () => AbortSignal.timeout(110000);

test('a node-project phase builds TypeScript and runs its tests in one shared scratch, leaving source untouched', darwin, async () => {
  const f = fixture();
  try {
    const results = await runChecks(f.root, 'source', [
      nodeCheck('build', ['{nodeModules}/typescript/bin/tsc', '--outDir', '{scratch}/out', '--module', 'nodenext', '--target', 'es2022',
        '--typeRoots', '{nodeModules}/@types', '--types', 'node', 'src/value.ts', 'src/value.test.ts']),
      nodeCheck('test', ['--test', '{scratch}/out/value.test.js']),
      nodeCheck('nested-flag', ['-e', "process.exit(process.env.FORGEMIND_NESTED_SANDBOX === '1' ? 0 : 1)"]),
    ], f.scratch, authority as never, signal(), f.runtime);
    assert.deepEqual(results.map(r => [r.id, r.passed]), [['build', true], ['test', true], ['nested-flag', true]], JSON.stringify(results));
    assert.match(results[1]!.stdout, /pass 1/);
    assert.equal(results[0]!.stdout, '', 'TypeScript reported no diagnostics');
    assert.deepEqual(readdirSync(f.root).sort(), ['package-lock.json', 'src']);
    assert.equal(readdirSync(f.scratch).length, 1, 'one shared scratch for the phase');
  } finally { f.close(); }
});

test('node-project checks still deny shells, scratch executables, network and source writes', darwin, async () => {
  const f = fixture();
  try {
    const probes: [string, string][] = [
      ['shell', "try{require('child_process').execFileSync('/bin/sh',['-c','true']);process.exit(1)}catch{process.exit(0)}"],
      ['scratch-binary', "const fs=require('fs'),p=process.env.TMPDIR+'/node-copy';fs.copyFileSync(process.execPath,p);fs.chmodSync(p,0o755);" +
        "try{require('child_process').execFileSync(p,['-e','0']);process.exit(1)}catch(e){process.exit(e.code==='EPERM'||e.code==='EACCES'?0:2)}"],
      ['network', "require('net').connect(443,'1.1.1.1').on('connect',()=>process.exit(1)).on('error',()=>process.exit(0))"],
      ['source-write', "try{require('fs').writeFileSync('src/injected.ts','x');process.exit(1)}catch{process.exit(0)}"],
      ['node-modules-write', `try{require('fs').writeFileSync(${JSON.stringify(join(repo, 'node_modules', '.fm-probe'))},'x');process.exit(1)}catch{process.exit(0)}`],
    ];
    const results = await runChecks(f.root, 'source', probes.map(([id, code]) => nodeCheck(id, ['-e', code])), f.scratch, authority as never, signal(), f.runtime);
    assert.deepEqual(results.filter(r => !r.passed).map(r => r.id), [], JSON.stringify(results));
    assert.equal(existsSync(join(f.root, 'src/injected.ts')), false);
    assert.equal(existsSync(join(repo, 'node_modules', '.fm-probe')), false);
  } finally { f.close(); }
});

test('node-project checks are refused without a genuine, matching runtime or with another executable', darwin, async () => {
  const f = fixture();
  try {
    const run = (commands: CheckCommand[], runtime?: CheckRuntime) => runChecks(f.root, 'source', commands, f.scratch, authority as never, signal(), runtime);
    const probe = nodeCheck('probe', ['-e', '0']);
    await assert.rejects(run([probe]), /require an owner-selected --node-modules/);
    await assert.rejects(run([probe], { ...f.runtime }), /Untrusted check runtime/);
    await assert.rejects(run([{ ...probe, executable: '/bin/echo' }], f.runtime), /pinned Node runtime/);
    writeFileSync(join(f.root, 'package-lock.json'), '{}');
    await assert.rejects(run([probe], f.runtime), /does not match the selected node_modules/);
    assert.throws(() => nodeProjectRuntime(repo + '/node_modules/../node_modules'), /Canonical node_modules/);
    assert.throws(() => nodeProjectRuntime(join(repo, 'src')), /Canonical node_modules/);
  } finally { f.close(); }
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
