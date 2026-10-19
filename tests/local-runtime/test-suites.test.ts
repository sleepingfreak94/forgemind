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
