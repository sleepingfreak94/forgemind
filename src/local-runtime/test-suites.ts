import { reviewedCodexFixture } from './reviewed-codex.js';
import type { ReviewedCodexVersion } from './reviewed-codex.js';

/** Verification routing only. This does not grant runtime execution authority. */
export interface TestSuite {
  directories: string[];
  files: string[];
  requiredCodexFixtures: ReviewedCodexVersion[];
  timeoutMs?: number;
  /** Wall-clock limit for the whole run, in milliseconds. */
  maxRunMs: number;
}
export const REVIEWED_CODEX_VERSIONS = ['0.161.0', '0.162.1'] as const;

/** Versions whose reviewed binary cannot be resolved. Never returns paths or error text. */
export function missingCodexFixtures(env: NodeJS.ProcessEnv = process.env): ReviewedCodexVersion[] {
  const missing: ReviewedCodexVersion[] = [];
  for (const version of REVIEWED_CODEX_VERSIONS) {
    try { reviewedCodexFixture(version, env); } catch { missing.push(version); }
  }
  return missing;
}

export function testSuite(mode: string, platform: NodeJS.Platform, posixIdentity: boolean): TestSuite {
  const portable = ['dist/tests/context-engine', 'dist/tests/agent-drivers', 'dist/tests/local-runtime', 'dist/tests/project-workflow', 'dist/tests/memory'];
  if (mode === 'portable') return { directories: portable, files: ['dist/tests/host-enforcement/windows-sandbox.test.js'], requiredCodexFixtures: [], maxRunMs: 300000 };
  if (mode === 'all' || mode === 'local') {
    if (platform === 'win32' || !posixIdentity) throw new Error('Full policy tests require POSIX identity. Use npm run test:portable for deterministic fixtures.');
    return { directories: [...portable, 'dist/tests/policy', 'dist/tests/live-workflow'],
      files: ['dist/tests/host-enforcement/manifest.test.js'],
      requiredCodexFixtures: mode === 'all' ? ['0.161.0', '0.162.1'] : [], maxRunMs: 1800000 };
  }
  if (mode === 'host') {
    if (platform !== 'darwin' || !posixIdentity) throw new Error('Enforced host tests require macOS Seatbelt; no unsandboxed fallback is available.');
    return { directories: [], files: ['dist/tests/host-enforcement/native.test.js', 'dist/tests/host-enforcement/cursor-native.test.js'],
      timeoutMs: 15000, requiredCodexFixtures: [], maxRunMs: 600000 };
  }
  throw new Error('Unknown test suite. Expected portable, all, local or host.');
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
