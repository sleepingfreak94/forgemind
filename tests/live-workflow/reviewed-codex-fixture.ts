import { reviewedCodexFixture } from '../../src/local-runtime/reviewed-codex.js';
import type { ReviewedCodexVersion } from '../../src/local-runtime/reviewed-codex.js';

/** Backward-compatible test import; runtime launchers still independently pin Codex. */
export { reviewedCodexFixture };

/** Skip reason when the reviewed binary is unavailable, else false. Never exposes paths. */
export function codexMissing(version: ReviewedCodexVersion, env: NodeJS.ProcessEnv = process.env): string | false {
  try { reviewedCodexFixture(version, env); return false; }
  catch { return `needs reviewed Codex ${version} (set ${version === '0.161.0' ? 'FORGEMIND_TEST_CODEX_0161' : 'FORGEMIND_TEST_CODEX_0162'})`; }
}
