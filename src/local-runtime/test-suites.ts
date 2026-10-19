import { reviewedCodexFixture } from './reviewed-codex.js';
import type { ReviewedCodexVersion } from './reviewed-codex.js';

/** Verification routing only. This does not grant runtime execution authority. */
export interface TestSuite {
  directories: string[];
  files: string[];
  requiredCodexFixtures: ReviewedCodexVersion[];
  timeoutMs?: number;
}
export function testSuite(mode: string, platform: NodeJS.Platform, posixIdentity: boolean): TestSuite {
  const portable = ['dist/tests/context-engine', 'dist/tests/agent-drivers', 'dist/tests/local-runtime', 'dist/tests/project-workflow', 'dist/tests/memory'];
  if (mode === 'portable') return { directories: portable, files: [], requiredCodexFixtures: [] };
  if (mode === 'all') {
    if (platform === 'win32' || !posixIdentity) throw new Error('Full policy tests require POSIX identity. Use npm run test:portable for deterministic fixtures.');
    return { directories: [...portable, 'dist/tests/policy', 'dist/tests/live-workflow'],
      files: ['dist/tests/host-enforcement/manifest.test.js'], requiredCodexFixtures: ['0.161.0', '0.162.1'] };
  }
  if (mode === 'host') {
    if (platform !== 'darwin' || !posixIdentity) throw new Error('Enforced host tests require macOS Seatbelt; no unsandboxed fallback is available.');
    return { directories: [], files: ['dist/tests/host-enforcement/native.test.js', 'dist/tests/host-enforcement/cursor-native.test.js'],
      timeoutMs: 15000, requiredCodexFixtures: [] };
  }
  throw new Error('Unknown test suite. Expected portable, all or host.');
}

/** Check every prerequisite before discovering tests or starting any test worker. */
export function validateTestPrerequisites(suite: Pick<TestSuite, 'requiredCodexFixtures'>, env: NodeJS.ProcessEnv = process.env): void {
  const failures: string[] = [];
  for (const version of suite.requiredCodexFixtures) {
    try { reviewedCodexFixture(version, env); }
    catch {
      // Never expose executable paths, child output, or inherited environment values.
      const key = version === '0.161.0' ? 'FORGEMIND_TEST_CODEX_0161' : 'FORGEMIND_TEST_CODEX_0162';
      failures.push(`Set ${key} to an absolute executable path for reviewed Codex ${version} (--version must report codex-cli ${version}).`);
    }
  }
  if (failures.length) throw new Error(`Missing or invalid test prerequisites. ${failures.join(' ')} Use npm run test:portable for deterministic fixtures.`);
}
