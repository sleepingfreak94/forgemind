import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewedCodexFixture } from '../../src/local-runtime/reviewed-codex.js';
import { reviewedCodexFixture as legacyFixture } from '../live-workflow/reviewed-codex-fixture.js';
import { testSuite } from '../../src/local-runtime/test-suites.js';

const runnerPath = fileURLToPath(new URL('../../../scripts/run-tests.mjs', import.meta.url));
const { runTests } = await import(runnerPath);
const first = 'FORGEMIND_TEST_CODEX_0161', second = 'FORGEMIND_TEST_CODEX_0162';

function temporary(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'forgemind-prerequisites-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function invoke(mode: string, env: NodeJS.ProcessEnv, root: string) {
  let stderr = '', dispatches = 0;
  const status = runTests([mode], { env, root, platform: 'darwin', posixIdentity: true,
    stderr: (message: string) => { stderr += message; },
    spawn: () => { dispatches++; return { status: 0 }; } });
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

test('missing selectors and nonexistent paths fail before discovery or worker dispatch', t => {
  const root = temporary(t); // No compiled test directories: prerequisite failure must come first.
  for (const env of [{}, { [first]: join(root, 'private-missing'), [second]: join(root, 'private-missing') }]) {
    const result = invoke('all', env, root);
    assert.equal(result.status, 2);
    assert.equal(result.dispatches, 0);
    assert.match(result.stderr, /FORGEMIND_TEST_CODEX_0161/);
    assert.match(result.stderr, /FORGEMIND_TEST_CODEX_0162/);
    assert.match(result.stderr, /absolute executable path/);
    assert.doesNotMatch(result.stderr, /private-missing|ENOENT|No compiled tests/);
    assert.ok(!result.stderr.includes(root));
  }
});

test('wrong versions from the actual Node executable cannot dispatch native test workers', t => {
  const root = temporary(t);
  const result = invoke('all', { [first]: process.execPath, [second]: process.execPath }, root);
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

test('host and portable dispatch without resolving any Codex selector', t => {
  const root = temporary(t);
  compiledFixtures(root, 'portable');
  for (const mode of ['host', 'portable']) {
    const result = invoke(mode, { [first]: 'invalid\npath', [second]: 'relative-path' }, root);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.dispatches, 1);
    assert.equal(result.stderr, '');
  }
});

test('actual bounded local version fixtures validate before synthetic dispatch', { skip: process.platform === 'win32' }, t => {
  const root = temporary(t), env: NodeJS.ProcessEnv = {
    [first]: versionFixture(root, '0.161.0'), [second]: versionFixture(root, '0.162.1'),
    HOME: 'synthetic-secret', CODEX_HOME: 'synthetic-secret', OPENAI_API_KEY: 'synthetic-secret'
  };
  compiledFixtures(root, 'all');
  assert.equal(reviewedCodexFixture('0.161.0', env), realpathSync(env[first]!));
  assert.equal(reviewedCodexFixture('0.162.1', env), realpathSync(env[second]!));
  const result = invoke('all', env, root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.dispatches, 1); // The injected dispatcher never starts native workers.
  assert.equal(result.stderr, '');
  for (const missing of [first, second]) {
    const partial = { ...env }; delete partial[missing];
    const denied = invoke('all', partial, root);
    assert.equal(denied.status, 2);
    assert.equal(denied.dispatches, 0);
    assert.ok(denied.stderr.includes(missing));
  }
});

test('failed version subprocess output and executable paths are sanitized', { skip: process.platform === 'win32' }, t => {
  const root = temporary(t), executable = join(root, 'private-executable');
  writeFileSync(executable, '#!/bin/sh\nprintf synthetic-private-output >&2\nexit 9\n', { mode: 0o700 });
  const result = invoke('all', { [first]: executable, [second]: executable }, root);
  assert.equal(result.status, 2);
  assert.equal(result.dispatches, 0);
  assert.doesNotMatch(result.stderr, /synthetic-private-output|private-executable/);
  assert.ok(!result.stderr.includes(root));
});
