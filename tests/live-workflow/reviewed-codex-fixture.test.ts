import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewedCodexFixture } from './reviewed-codex-fixture.js';

test('native fixture versions require separate explicit paths without an ambient fallback', () => {
  assert.throws(() => reviewedCodexFixture('0.161.0', {}), /FORGEMIND_TEST_CODEX_0161/);
  assert.throws(() => reviewedCodexFixture('0.162.1', { FORGEMIND_TEST_CODEX_0161: process.execPath }), /FORGEMIND_TEST_CODEX_0162/);
  assert.throws(() => reviewedCodexFixture('0.161.0', { FORGEMIND_TEST_CODEX_0162: process.execPath }), /FORGEMIND_TEST_CODEX_0161/);
});
test('native fixture paths reject relative paths and control characters before launch', () => {
  for (const path of ['codex', '../codex', process.execPath + '\n', process.execPath + '\0']) {
    assert.throws(() => reviewedCodexFixture('0.162.1', { FORGEMIND_TEST_CODEX_0162: path }), /absolute path/);
  }
});
test('native fixture paths cannot substitute an executable reporting another version', () => {
  assert.throws(() => reviewedCodexFixture('0.161.0', { FORGEMIND_TEST_CODEX_0161: process.execPath }), /must select reviewed Codex 0\.161\.0/);
  assert.throws(() => reviewedCodexFixture('0.162.1', { FORGEMIND_TEST_CODEX_0162: process.execPath }), /must select reviewed Codex 0\.162\.1/);
});
