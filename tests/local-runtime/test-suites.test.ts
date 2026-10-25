import assert from 'node:assert/strict';
import test from 'node:test';
import { testSuite, validateTestPrerequisites } from '../../src/local-runtime/test-suites.js';

test('only the all suite requires both exact reviewed Codex fixtures', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    assert.deepEqual(testSuite('all', platform, true).requiredCodexFixtures, ['0.161.0', '0.162.1']);
  }
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    for (const identity of [true, false]) {
      const suite = testSuite('portable', platform, identity);
      assert.deepEqual(suite.requiredCodexFixtures, []);
      assert.doesNotThrow(() => validateTestPrerequisites(suite, {}));
    }
  }
  const host = testSuite('host', 'darwin', true);
  assert.deepEqual(host.requiredCodexFixtures, []);
  assert.equal(host.timeoutMs, 15000);
  assert.equal(host.files.length, 2);
  assert.doesNotThrow(() => validateTestPrerequisites(host, {}));
});

test('every suite has its wall-clock limit and local mirrors all without fixture requirements', () => {
  const expected = { portable: 300000, host: 600000, all: 1800000, local: 1800000 } as const;
  const pairs: [keyof typeof expected, NodeJS.Platform][] = [
    ['portable', 'darwin'], ['portable', 'linux'], ['portable', 'win32'],
    ['all', 'darwin'], ['all', 'linux'], ['local', 'darwin'], ['local', 'linux'], ['host', 'darwin']];
  for (const [mode, platform] of pairs) {
    const { maxRunMs } = testSuite(mode, platform, true);
    assert.ok(Number.isInteger(maxRunMs) && maxRunMs > 0);
    assert.equal(maxRunMs, expected[mode]);
  }
  for (const platform of ['darwin', 'linux'] as const) {
    const local = testSuite('local', platform, true), all = testSuite('all', platform, true);
    assert.deepEqual(local.directories, all.directories);
    assert.deepEqual(local.files, all.files);
    assert.deepEqual(local.requiredCodexFixtures, []);
    assert.deepEqual(all.requiredCodexFixtures, ['0.161.0', '0.162.1']);
  }
  assert.throws(() => testSuite('local', 'win32', true), /POSIX identity/);
  assert.throws(() => testSuite('local', 'linux', false), /POSIX identity/);
  assert.throws(() => testSuite('nope', 'darwin', true), error => {
    assert.ok(error instanceof Error);
    for (const name of ['portable', 'all', 'local', 'host']) assert.ok(error.message.includes(name));
    return true;
  });
});

test('the prerequisite error names both missing pinned fixtures without selecting ambient commands', () => {
  assert.throws(() => validateTestPrerequisites(testSuite('all', 'linux', true), {
    PATH: '/private/should-not-search', CODEX_HOME: '/private/should-not-read'
  }), error => {
    assert.ok(error instanceof Error);
    for (const name of ['FORGEMIND_TEST_CODEX_0161', 'FORGEMIND_TEST_CODEX_0162', '0.161.0', '0.162.1', 'npm run test:portable'])
      assert.ok(error.message.includes(name));
    assert.ok(!error.message.includes('/private/'));
    return true;
  });
});
