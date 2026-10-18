import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, cpSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { runtimeFiles } from '../../src/live-workflow/process.js';
import { NativeProject } from '../../src/live-workflow/native-executor-project.js';
import { FixtureNativeHost, fixtureStdioRpc } from '../../src/live-workflow/native-executor-host.js';
import { nativeTool } from '../../src/live-workflow/native-executor-tools.js';
import { createServer } from 'node:net';
import { NativeOwner } from '../../src/live-workflow/native-executor-owner.js';
import { runNativeChecks, nativeCheckSummary } from '../../src/live-workflow/native-checks.js';
import { validateNativeCheck } from '../../src/live-workflow/native-checks-contracts.js';
import { validateNativeTask } from '../../src/live-workflow/native-executor-run.js';
import { NativeState } from '../../src/live-workflow/native-executor-state.js';
import { sourceIdentity } from '../../src/live-workflow/repository.js';
import type { CompiledTestCheck } from '../../src/live-workflow/native-checks-contracts.js';
import type { NativeTask } from '../../src/live-workflow/native-executor-contracts.js';
import type { ActionAuthority } from '../../src/live-workflow/contracts.js';

const host = { skip: process.platform !== 'darwin', timeout: 90000 };
const project = resolve(import.meta.dirname, '../../..');
function fixture(code = "import test from 'node:test'; import assert from 'node:assert/strict'; import {Value} from '../src/value.js'; test('parameter property',()=>assert.equal(new Value(42).value,42));") {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fm-compiled-check-'))), root = join(dir, 'repo');
  mkdirSync(root); mkdirSync(join(root, 'src')); mkdirSync(join(root, 'tests')); mkdirSync(join(root, 'config'));
  execFileSync('/usr/bin/git', ['init', '-q', root]);
  cpSync(join(project, 'node_modules'), join(root, 'node_modules'), { recursive: true, verbatimSymlinks: true });
  writeFileSync(join(root, '.gitignore'), 'node_modules/\ndist/\n.env\n.codex/\n');
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, 'package-lock.json'), readFileSync(join(project, 'package-lock.json')));
  writeFileSync(join(root, 'config/tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
    noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, verbatimModuleSyntax: true,
    rootDir: '..', outDir: '../dist', types: ['node'], skipLibCheck: true,
  }, include: ['../src/**/*.ts', '../tests/**/*.ts'] }));
  writeFileSync(join(root, 'src/value.ts'), 'export class Value { constructor(readonly value: number) {} }\n');
  writeFileSync(join(root, 'tests/value.test.ts'), code);
  writeFileSync(join(root, 'tests/unselected.test.ts'), "throw new Error('unselected test must never execute'); export {};\n");
  const check: CompiledTestCheck = { kind: 'typescript-tests', id: 'compiled', compilerExecutable:
    realpathSync(join(root, 'node_modules/@typescript/typescript-darwin-' + process.arch + '/lib/tsc')),
    nodeExecutable: realpathSync(process.execPath), project: 'config/tsconfig.json',
    testPaths: ['tests/value.test.ts'], timeoutMs: 30000 };
  const task: NativeTask = { project: 'fixture', task: 'compiled-check', root, source: sourceIdentity(root),
    model: 'gpt-6.1-sol', effort: 'medium', readPaths: [], writePaths: [], checks: [check],
    budget: { runtimeMs: 90000, turns: null, toolCalls: null, retries: 0, inputBytes: 100000,
      resultBytes: 1048576, wireBytes: 1048576, outputBytes: 1048576 } };
  let owner: NativeOwner;
  const renew = () => {
    owner?.close(); task.source = sourceIdentity(root);
    owner = new NativeOwner(join(dir, 'owner-' + Math.random().toString(36).slice(2)), task, Date.now() + 90000, () => {});
  };
  renew();
  return { dir, root, task, check, renew, get owner() { return owner; },
    run: (authority: ActionAuthority = owner, signal: AbortSignal = AbortSignal.timeout(60000)) =>
      runNativeChecks(root, task.source, task.checks, join(dir, 'checks'), authority, signal),
    close: () => { owner.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('compiled native check handles parameter properties, selects exact tests and binds artifacts', host, async () => {
  const f = fixture();
  try {
    validateNativeTask(f.task);
    const [result] = await f.run();
    assert.ok(result && 'stages' in result);
    assert.equal(result.passed, true, result.stderr + result.stdout);
    assert.equal(result.stages.length, 2);
    assert.match(result.stdout, /parameter property/);
    assert.doesNotMatch(result.stdout, /unselected test must never execute/);
    const compiled = result.artifactManifest.find(file => file.path.endsWith('/src/value.js'))!;
    assert.match(readFileSync(compiled.path, 'utf8'), /this.value = value/);
    assert.ok(result.stages.every(stage => stage.command.dependencies.some(file => file.path.includes('/node_modules/'))));
    assert.equal(sourceIdentity(f.root), f.task.source);
    const summary = nativeCheckSummary(result);
    assert.deepEqual(Object.keys(summary).sort(), ['exitCode', 'id', 'passed', 'stderr', 'stdout']);
    assert.ok(Buffer.byteLength(JSON.stringify(summary)) * 2 < 10000);
    assert.ok(result.stages.some(stage => JSON.stringify(stage.command).length > 10000));
    const bindings = result.stages.map(stage => stage.command.profileSha256);
    assert.ok(bindings.every(hash => /^[a-f0-9]{64}$/.test(hash)));
    // Existing checkpoint shapes remain valid; changing the check definition requires a fresh checkpoint.
    const state = new NativeState(join(f.dir, 'state'), f.task); state.close();
    const reopened = new NativeState(join(f.dir, 'state'), f.task); reopened.close();
    assert.throws(() => new NativeState(join(f.dir, 'state'), { ...f.task,
      checks: [{ ...f.check, testPaths: ['tests/unselected.test.ts'] }] }), /binding mismatch/);
  } finally { f.close(); }
});

test('strict errors fail compilation without emitting or executing tests', host, async () => {
  const f = fixture("const wrong: number = 'not a number'; export {};\n");
  try {
    // Compiler strict flags cannot be disabled by the source configuration.
    const config = join(f.root, 'config/tsconfig.json'), value = JSON.parse(readFileSync(config, 'utf8'));
    value.compilerOptions.strict = false; value.compilerOptions.noCheck = true; writeFileSync(config, JSON.stringify(value));
    writeFileSync(join(f.root, 'src/value.ts'), 'export function invalid(value) { return value; }\n');
    f.renew();
    const [result] = await f.run();
    assert.ok(result && 'stages' in result);
    assert.equal(result.passed, false);
    assert.equal(result.stages.length, 1);
    assert.match(result.stdout, /TS2322/);
    assert.match(result.stdout, /TS7006/);
    assert.deepEqual(result.artifactManifest, []);
    assert.equal(result.stages[0]?.command.stage, 'compile');
    assert.equal(sourceIdentity(f.root), f.task.source);
  } finally { f.close(); }
});

test('compiled tests retain sandbox denials and use a separate writable temporary directory', host, async () => {
  const server = createServer(socket => socket.end());
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const f = fixture(`import test from 'node:test'; import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs'; import {join} from 'node:path';
import {execFileSync} from 'node:child_process'; import {connect} from 'node:net';
test('sandbox', async()=> {
 assert.equal(process.env.FORGEMIND_SECRET,undefined);
 for(const p of ['.env','.git/config','.codex/secret'])assert.throws(()=>readFileSync(p),p);
 assert.throws(()=>writeFileSync('src/value.ts','bad'));
 assert.throws(()=>writeFileSync(new URL('./value.test.js',import.meta.url),'bad'));
 assert.throws(()=>execFileSync('/usr/bin/true'));
 assert.throws(()=>execFileSync(process.execPath,['-e','process.exit(0)']));
 writeFileSync(join(process.env.TMPDIR!,'allowed'),'ok');
 await new Promise<void>((done,reject)=>{const s=connect(${address.port},'127.0.0.1');s.once('error',()=>done());s.once('connect',()=>{s.destroy();reject(Error('network unexpectedly allowed'));});});
});`);
  writeFileSync(join(f.root, '.env'), 'fixture-secret'); mkdirSync(join(f.root, '.codex'));
  writeFileSync(join(f.root, '.codex/secret'), 'fixture-secret'); process.env.FORGEMIND_SECRET = 'secret';
  try {
    const [result] = await f.run(); assert.equal(result?.passed, true, result?.stderr + '\n' + result?.stdout);
    assert.equal(sourceIdentity(f.root), f.task.source);
  } finally {
    delete process.env.FORGEMIND_SECRET; f.close();
    await new Promise<void>(done => server.close(() => done()));
  }
});

test('native owner rejects serialized or altered stage commands even with the approved check definition', host, async () => {
  const f = fixture(), stages: string[] = [];
  try {
    const authority: ActionAuthority = { reserve(envelope) {
      const detail = envelope.detail as { operation: string; stage?: string };
      if (detail.operation === 'native.compiled-check.stage') {
        stages.push(detail.stage!);
        assert.ok(Object.isFrozen(detail));
        assert.throws(() => f.owner.reserve({ ...envelope, detail: structuredClone(detail) }), /Unsealed/);
        assert.throws(() => f.owner.reserve({ ...envelope, detail: { ...detail, args: ['-e', 'bad'] } }), /Unsealed/);
      }
      return f.owner.reserve(envelope);
    } };
    const [result] = await f.run(authority);
    assert.equal(result?.passed, true); assert.deepEqual(stages, ['compile', 'execute']);
  } finally { f.close(); }
});

test('source or compiler input drift after compilation prevents execution', host, async () => {
  for (const drift of ['source', 'dependency']) {
    const f = fixture(), stages: string[] = [];
    try {
      const authority: ActionAuthority = { reserve(envelope) {
        const detail = envelope.detail as { stage?: string };
        if (detail.stage) stages.push(detail.stage);
        const receipt = f.owner.reserve(envelope);
        return { check: () => receipt.check(), finish(status, digest) {
          receipt.finish(status, digest);
          if (detail.stage === 'compile' && status === 'completed') {
            const path = drift === 'source' ? join(f.root, 'src/value.ts') :
              join(f.root, 'node_modules/typescript/package.json');
            writeFileSync(path, readFileSync(path, 'utf8') + '\n');
          }
        } };
      } };
      await assert.rejects(f.run(authority), /source|identity changed|inputs changed/i);
      assert.deepEqual(stages, ['compile']);
    } finally { f.close(); }
  }
});

test('artifact drift at the execution reservation prevents the test process from starting', host, async () => {
  const f = fixture();
  try {
    const authority: ActionAuthority = { reserve(envelope) {
      const detail = envelope.detail as { stage?: string; artifactManifest?: {path: string}[] };
      const receipt = f.owner.reserve(envelope);
      if (detail.stage === 'execute') {
        const path = detail.artifactManifest!.find(file => file.path.endsWith('/tests/value.test.js'))!.path;
        writeFileSync(path, "throw Error('tampered artifact executed');");
      }
      return receipt;
    } };
    await assert.rejects(f.run(authority), /identity changed/);
  } finally { f.close(); }
});


test('external Node executable drift at reservation is rejected before execution', host, async () => {
  const f = fixture();
  try {
    const node = join(f.dir, 'node');
    const original = realpathSync(process.execPath);
    copyFileSync(original, node);
    for (const library of runtimeFiles(original)) {
      if (library !== original && [dirname(original), resolve(dirname(original), '../lib')].includes(dirname(library)))
        copyFileSync(library, join(f.dir, basename(library)));
    }
    f.check.nodeExecutable = node; f.renew();
    const authority: ActionAuthority = { reserve(envelope) {
      const receipt = f.owner.reserve(envelope);
      if ((envelope.detail as {stage?: string}).stage === 'execute') {
        const replacement = join(f.dir, 'replacement');
        copyFileSync('/usr/bin/true', replacement); renameSync(replacement, node);
      }
      return receipt;
    } };
    await assert.rejects(f.run(authority), /identity changed/);
  } finally { f.close(); }
});

test('compiled check cancellation and timeout reap workers and settle indeterminate receipts', host, async () => {
  for (const cancel of [true, false]) {
    const f = fixture("import test from 'node:test'; test('wait', async()=>new Promise<void>(done=>setTimeout(done,60000)));");
    const statuses: string[] = [], controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      if (!cancel) { f.check.timeoutMs = 7000; f.renew(); }
      const authority: ActionAuthority = { reserve(envelope) {
        const detail = envelope.detail as {stage?: string};
        const receipt = f.owner.reserve(envelope);
        if (detail.stage === 'execute' && cancel) timer = setTimeout(() => controller.abort(), 100);
        return { check: () => receipt.check(), finish(status, digest) { statuses.push(status); receipt.finish(status, digest); } };
      } };
      await assert.rejects(f.run(authority, controller.signal), /Cancel|Deadline|abort|timeout/i);
      assert.equal(statuses.at(-1), 'indeterminate');
    } finally { if (timer) clearTimeout(timer); f.close(); }
  }
});


test('two native host_check calls retain full owner evidence within the unchanged worker result budget', host, async () => {
  const f = fixture(), state = new NativeState(join(f.dir, 'state'), f.task);
  const project = new NativeProject(f.root, f.owner, (...args) => f.owner.phase(...args), () => f.owner.active());
  const host = new FixtureNativeHost(fixtureStdioRpc(new PassThrough(), new PassThrough()), f.owner,
    () => f.owner.active(), async () => {}, () => project.source(), async () => {
      const [result] = await f.run();
      return nativeCheckSummary(result!);
    }, project);
  try {
    for (let n = 0; n < 2; n++) {
      const result = JSON.parse(await nativeTool(f.task, state, host, 'host_check', {id:f.check.id}, AbortSignal.timeout(30000)));
      assert.equal(result.passed, true); assert.equal(result.stages, undefined);
    }
    assert.ok(state.value.counters.resultBytes < 10000);
  } finally { host.rpc.close(); state.close(); f.close(); }
});

test('compiled check validation rejects path escapes, extra arguments, unknown kinds and empty selections', host, () => {
  const f = fixture();
  try {
    const invalid = [
      {...f.check, testPaths: []}, {...f.check, testPaths: ['../outside.test.ts']},
      {...f.check, testPaths: ['src/value.ts']}, {...f.check, project: '../tsconfig.json'},
      {...f.check, args: ['--noCheck']}, {...f.check, kind: 'other'},
    ];
    for (const check of invalid) assert.throws(() => validateNativeCheck(f.root, check as CompiledTestCheck));
    assert.throws(() => validateNativeCheck(f.root, {...f.check, compilerExecutable: 'tsc'}));
  } finally { f.close(); }
});
