import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewedCodexFixture } from '../../src/local-runtime/reviewed-codex.js';
import { reviewedCodexFixture as legacyFixture } from '../live-workflow/reviewed-codex-fixture.js';
import { testSuite } from '../../src/local-runtime/test-suites.js';

const runnerUrl = new URL('../../../scripts/run-tests.mjs', import.meta.url);
const runnerPath = fileURLToPath(runnerUrl);
const { runTests } = await import(runnerUrl.href);
const first = 'FORGEMIND_TEST_CODEX_0161', second = 'FORGEMIND_TEST_CODEX_0162';

function temporary(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'forgemind-prerequisites-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
async function invoke(mode: string, env: NodeJS.ProcessEnv, root: string, platform: NodeJS.Platform = 'darwin', posixIdentity = true) {
  let stderr = '', dispatches = 0;
  const status = await runTests([mode], { env, root, platform, posixIdentity,
    stderr: (message: string) => { stderr += message; },
    run: async () => { dispatches++; return { status: 0, timedOut: false }; } });
  return { status, stderr, dispatches };
}
function compiledFixtures(root: string, mode: string): void {
  for (const directory of testSuite(mode, 'darwin', true).directories) {
    mkdirSync(join(root, directory), { recursive: true });
    writeFileSync(join(root, directory, 'sentinel.test.js'), 'throw new Error("must never execute");\n');
  }
}
function versionFixture(root: string, version: string): string {
  const path = join(root, `version-${version}`);
  // Resolver-only fixture. It cannot serve native protocol requests or provider inference.
  writeFileSync(path, `#!/bin/sh
[ "$#" -eq 1 ] && [ "$1" = "--version" ] || exit 90
[ -z "$HOME" ] && [ -z "$OPENAI_API_KEY" ] && [ -z "$CODEX_HOME" ] || exit 91
[ "$PATH" = "/usr/bin:/bin" ] && [ "$LANG" = C ] && [ "$LC_ALL" = C ] || exit 92
printf '%s\\n' 'codex-cli ${version}'
`, { mode: 0o700 });
  return path;
}

test('legacy imports delegate to the exact shared resolver', () => {
  assert.equal(legacyFixture, reviewedCodexFixture);
});

test('missing selectors and nonexistent paths fail before discovery or worker dispatch', async t => {
  const root = temporary(t); // No compiled test directories: prerequisite failure must come first.
  for (const env of [{}, { [first]: join(root, 'private-missing'), [second]: join(root, 'private-missing') }]) {
    const result = await invoke('all', env, root);
    assert.equal(result.status, 2);
    assert.equal(result.dispatches, 0);
    assert.match(result.stderr, /FORGEMIND_TEST_CODEX_0161/);
    assert.match(result.stderr, /FORGEMIND_TEST_CODEX_0162/);
    assert.match(result.stderr, /absolute executable path/);
    assert.doesNotMatch(result.stderr, /private-missing|ENOENT|No compiled tests/);
    assert.ok(!result.stderr.includes(root));
  }
});

test('wrong versions from the actual Node executable cannot dispatch native test workers', async t => {
  const root = temporary(t);
  const result = await invoke('all', { [first]: process.execPath, [second]: process.execPath }, root);
  assert.equal(result.status, 2);
  assert.equal(result.dispatches, 0);
  assert.match(result.stderr, /reviewed Codex 0\.161\.0/);
  assert.match(result.stderr, /reviewed Codex 0\.162\.1/);
  assert.ok(!result.stderr.includes(process.execPath));
});

test('CLI rejects missing prerequisites without TAP output or starting fixture servers', { skip: process.platform === 'win32' }, () => {
  const result = spawnSync(process.execPath, [runnerPath, 'all'], {
    encoding: 'utf8', timeout: 10000, maxBuffer: 8192, env: {}
  });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /FORGEMIND_TEST_CODEX_0161/);
  assert.match(result.stderr, /FORGEMIND_TEST_CODEX_0162/);
});

test('host and portable dispatch without resolving any Codex selector', async t => {
  const root = temporary(t);
  compiledFixtures(root, 'portable');
  for (const mode of ['host', 'portable']) {
    const result = await invoke(mode, { [first]: 'invalid\npath', [second]: 'relative-path' }, root);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.dispatches, 1);
    assert.equal(result.stderr, '');
  }
});

test('actual bounded local version fixtures validate before synthetic dispatch', { skip: process.platform === 'win32' }, async t => {
  const root = temporary(t), env: NodeJS.ProcessEnv = {
    [first]: versionFixture(root, '0.161.0'), [second]: versionFixture(root, '0.162.1'),
    HOME: 'synthetic-secret', CODEX_HOME: 'synthetic-secret', OPENAI_API_KEY: 'synthetic-secret'
  };
  compiledFixtures(root, 'all');
  assert.equal(reviewedCodexFixture('0.161.0', env), realpathSync(env[first]!));
  assert.equal(reviewedCodexFixture('0.162.1', env), realpathSync(env[second]!));
  const result = await invoke('all', env, root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.dispatches, 1); // The injected dispatcher never starts native workers.
  assert.equal(result.stderr, '');
  for (const missing of [first, second]) {
    const partial = { ...env }; delete partial[missing];
    const denied = await invoke('all', partial, root);
    assert.equal(denied.status, 2);
    assert.equal(denied.dispatches, 0);
    assert.ok(denied.stderr.includes(missing));
  }
});

test('failed version subprocess output and executable paths are sanitized', { skip: process.platform === 'win32' }, async t => {
  const root = temporary(t), executable = join(root, 'private-executable');
  writeFileSync(executable, '#!/bin/sh\nprintf synthetic-private-output >&2\nexit 9\n', { mode: 0o700 });
  const result = await invoke('all', { [first]: executable, [second]: executable }, root);
  assert.equal(result.status, 2);
  assert.equal(result.dispatches, 0);
  assert.doesNotMatch(result.stderr, /synthetic-private-output|private-executable/);
  assert.ok(!result.stderr.includes(root));
});

test('local dispatches without fixtures and names the skipped Codex versions', { skip: process.platform === 'win32' }, async t => {
  const root = temporary(t);
  compiledFixtures(root, 'local');
  const none = await invoke('local', {}, root);
  assert.equal(none.status, 0, none.stderr);
  assert.equal(none.dispatches, 1);
  assert.equal(none.stderr.split('\n').filter(Boolean).length, 1);
  assert.ok(none.stderr.includes('0.161.0') && none.stderr.includes('0.162.1') && none.stderr.includes('skipped'));
  assert.ok(!none.stderr.includes(root));
  const partial = await invoke('local', { [first]: versionFixture(root, '0.161.0'), HOME: 'synthetic-secret' }, root);
  assert.equal(partial.status, 0, partial.stderr);
  assert.equal(partial.dispatches, 1);
  assert.ok(partial.stderr.includes('0.162.1') && !partial.stderr.includes('0.161.0') && partial.stderr.includes('skipped'));
  assert.ok(!partial.stderr.includes(root) && !partial.stderr.includes('synthetic-secret'));
  const both = await invoke('local', { [first]: versionFixture(root, '0.161.0'), [second]: versionFixture(root, '0.162.1') }, root);
  assert.equal(both.status, 0, both.stderr);
  assert.equal(both.dispatches, 1);
  assert.equal(both.stderr, '');
  for (const [platform, identity] of [['win32', true], ['linux', false]] as const) {
    const denied = await invoke('local', {}, root, platform, identity);
    assert.equal(denied.status, 2);
    assert.equal(denied.dispatches, 0);
    assert.match(denied.stderr, /POSIX identity/);
  }
});

test('a run over its limit is stopped with its whole process group', { skip: process.platform === 'win32', timeout: 20000 }, async t => {
  const root = temporary(t), pidFile = join(root, 'pids.txt');
  for (const [index, relative] of testSuite('portable', 'darwin', true).directories.entries()) {
    const directory = join(root, relative);
    mkdirSync(directory, { recursive: true });
    if (index !== 0) { writeFileSync(join(directory, 'sentinel.test.js'), 'require("node:test")("noop", () => {});\n'); continue; }
    writeFileSync(join(directory, 'sentinel.test.js'), `const { spawn } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
appendFileSync(process.env.FM_PID_FILE, process.pid + '\\n' + child.pid + '\\n');
setInterval(() => {}, 1000);\n`);
  }
  let pids: number[] = [];
  t.after(() => { for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } });
  let stderr = '';
  const started = Date.now();
  const status = await runTests(['portable'], { root, env: { FM_PID_FILE: pidFile, PATH: process.env.PATH }, maxRunMs: 2000,
    stderr: (message: string) => { stderr += message; } });
  assert.equal(status, 2);
  assert.ok(Date.now() - started < 10000);
  assert.match(stderr, /test run exceeded .* minutes and was stopped\. Run a narrower suite or the single slow test file\./);
  assert.ok(existsSync(pidFile));
  pids = readFileSync(pidFile, 'utf8').split('\n').filter(Boolean).map(Number);
  assert.ok(pids.length >= 2);
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } };
  const deadline = Date.now() + 3000;
  while (pids.some(alive) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  for (const pid of pids) assert.equal(alive(pid), false);
});
