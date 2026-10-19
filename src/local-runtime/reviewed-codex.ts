import { execFileSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export type ReviewedCodexVersion = '0.161.0' | '0.162.1';

/** Test prerequisites only. Production launchers still independently pin the runtime. */
export function reviewedCodexFixture(version: '0.161.0' | '0.162.1', env: NodeJS.ProcessEnv = process.env): string {
  const key = version === '0.161.0' ? 'FORGEMIND_TEST_CODEX_0161' : 'FORGEMIND_TEST_CODEX_0162';
  const selected = env[key];
  if (!selected || !isAbsolute(selected) || /[\0\r\n]/.test(selected))
    throw new Error(`Set ${key} to an absolute path for reviewed Codex ${version}`);
  const executable = realpathSync(selected);
  if (!statSync(executable).isFile()) throw new Error(`${key} must identify an executable file`);
  const actual = execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 5000,
    maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C',
      ...(process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) } }).trim();
  if (actual !== `codex-cli ${version}`) throw new Error(`${key} must select reviewed Codex ${version}`);
  return executable;
}
