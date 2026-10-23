import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { REVIEWED_CLAUDE_CLI } from '../../src/live-workflow/claude-session.js';
import { REVIEWED_CURSOR_CLI } from '../../src/live-workflow/cursor-session.js';
import { testSuite } from '../../src/local-runtime/test-suites.js';

test('portable routing includes fixtures and leaves POSIX/native verification explicit', () => {
  const suite = testSuite('portable', 'win32', false);
  assert.equal(suite.files.length, 0); assert.ok(!suite.directories.some(path => /policy|host-enforcement/.test(path)));
  for (const identity of [true, false]) {
    assert.throws(() => testSuite('all', 'win32', identity), /POSIX/);
    assert.throws(() => testSuite('host', 'win32', identity), /Seatbelt/);
  }
  assert.throws(() => testSuite('host', 'linux', true), /Seatbelt/);
  assert.ok(testSuite('all', 'darwin', true).directories.includes('dist/tests/policy'));
  assert.equal(testSuite('host', 'darwin', true).files.length, 2);
  assert.throws(() => testSuite('invented', 'darwin', true), /Unknown/);
});
test('setup doctor is credential-free and never certifies an untested host', () => {
  // Compiled test lives in dist/tests/local-runtime; scripts are outside dist.
  const sourceScript = fileURLToPath(new URL('../../../scripts/doctor.mjs', import.meta.url));
  const environment = { HOME: 'doctor-synthetic-secret', OPENAI_API_KEY: 'doctor-synthetic-secret',
    ...(process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
  const result = spawnSync(process.execPath, [sourceScript, '--json'], { encoding: 'utf8', env: environment });
  assert.equal(result.status, 0, result.stderr); const report = JSON.parse(result.stdout);
  assert.equal(report.platform, process.platform); assert.equal(report.portableSetupReady, true);
  assert.equal(report.liveCodingEnabled, false); assert.equal(report.hostVerified, false);
  assert.equal(report.localPolicyIdentityAvailable, process.platform !== 'win32' && typeof process.getuid === 'function');
  assert.ok(!result.stdout.includes('doctor-synthetic-secret'));
  const { claude, cursor } = report.routes;
  assert.equal(claude.reviewedVersion, REVIEWED_CLAUDE_CLI.version); assert.equal(cursor.reviewedVersion, REVIEWED_CURSOR_CLI.version);
  for (const route of [claude, cursor]) { assert.equal(route.buildPresent, false); assert.equal(route.profileReady, false); }
  assert.equal(cursor.personalAllowlistPresent, false);
  assert.equal(claude.probeCommand, `npm run probe:claude -- ~/.local/share/claude/versions/${REVIEWED_CLAUDE_CLI.version} ~/.forgemind/claude-profile`);
  assert.equal(cursor.probeCommand, `npm run probe:cursor -- ~/.local/share/cursor-agent/versions/${REVIEWED_CURSOR_CLI.version} ~/.forgemind/cursor-profile <workspace>`);
  const source = readFileSync(sourceScript, 'utf8');
  assert.ok(!/child_process/.test(source) && !/\b(execFile|execSync|spawn|fork)\b/.test(source));
});
test('verification scripts reject unsupported arguments without running tests or agent diagnostics', () => {
  for (const [file, args] of [['doctor.mjs', ['--unsafe']], ['run-tests.mjs', ['unknown']]] as const) {
    const script = fileURLToPath(new URL(`../../../scripts/${file}`, import.meta.url));
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8',
      env: process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {} });
    assert.equal(result.status, 2); assert.equal(result.stdout, '');
  }
});
