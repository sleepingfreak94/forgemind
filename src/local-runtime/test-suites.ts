/** Verification routing only. This does not grant runtime execution authority. */
export interface TestSuite { directories: string[]; files: string[]; timeoutMs?: number }
export function testSuite(mode: string, platform: NodeJS.Platform, posixIdentity: boolean): TestSuite {
  const portable = ['dist/tests/context-engine', 'dist/tests/agent-drivers', 'dist/tests/local-runtime', 'dist/tests/project-workflow', 'dist/tests/memory'];
  if (mode === 'portable') return { directories: portable, files: [] as string[] };
  if (mode === 'all') {
    if (platform === 'win32' || !posixIdentity) throw new Error('Full policy tests require POSIX identity. Use npm run test:portable for deterministic fixtures.');
    return { directories: [...portable, 'dist/tests/policy', 'dist/tests/live-workflow'], files: ['dist/tests/host-enforcement/manifest.test.js'] };
  }
  if (mode === 'host') {
    if (platform !== 'darwin' || !posixIdentity) throw new Error('Enforced host tests require macOS Seatbelt; no unsandboxed fallback is available.');
    return { directories: [], files: ['dist/tests/host-enforcement/native.test.js', 'dist/tests/host-enforcement/cursor-native.test.js'], timeoutMs: 15000 };
  }
  throw new Error('Unknown test suite. Expected portable, all or host.');
}
