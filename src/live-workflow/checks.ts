import { realpathSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { runtimeFiles, supervised } from './process.js';
import { sha256 } from './validation.js';
import type { ActionAuthority, CheckCommand } from './contracts.js';
export interface CheckResult {
  id: string;
  passed: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}
/** Checks get repository reads and private scratch writes. No network, credentials or source writes. */
export async function runChecks(
  root: string,
  source: string,
  commands: CheckCommand[],
  scratchParent: string,
  authority: ActionAuthority,
  signal: AbortSignal,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const command of commands) {
    signal.throwIfAborted();
    const scratch = mkdtempSync(join(scratchParent, 'check-'));
    mkdirSync(join(scratch, 'tmp'), { mode: 0o700 });
    const executable = realpathSync(command.executable),
      files = runtimeFiles(executable);
    // No process-fork: the command must use a single-process runner, e.g. Node --test-isolation=none.
    const profile = `(version 1)\n(deny default)\n(allow process-exec (literal ${JSON.stringify(executable)}))\n(allow process-info* (target same-sandbox))\n(allow sysctl-read)\n(allow file-read-metadata)\n(allow file-read* (literal "/") (subpath "/usr/lib") (subpath "/System/Library") (literal "/dev/null") (subpath ${JSON.stringify(root)}) (subpath ${JSON.stringify(scratch)}) ${files.map((f) => `(literal ${JSON.stringify(f)})`).join(' ')})\n(deny file-read* (subpath ${JSON.stringify(join(root, '.git'))}) (subpath ${JSON.stringify(join(root, '.codex'))}) (regex #"(^|/)\\.env($|\\.)"))\n(allow file-write* (subpath ${JSON.stringify(scratch)}))`;
    const receipt = authority.reserve({
      kind: 'command',
      source,
      detail: {
        id: command.id,
        executable,
        dependencies: files,
        args: command.args,
        cwd: root,
        profileSha256: sha256(profile),
        timeoutMs: command.timeoutMs,
      },
    });
    try {
      const result = await supervised({
        executable,
        dependencies: files,
        args: command.args,
        cwd: root,
        env: {
          PATH: '/usr/bin:/bin',
          HOME: scratch,
          TMPDIR: join(scratch, 'tmp'),
          LANG: 'C',
          LC_ALL: 'C',
          OPENSSL_CONF: '/dev/null',
        },
        profile,
        timeoutMs: command.timeoutMs,
        maxOutputBytes: 1048576,
        signal,
        check: () => receipt.check(),
      });
      const item = {
        id: command.id,
        passed: result.code === 0,
        exitCode: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
      };
      receipt.finish(result.code === 0 ? 'completed' : 'failed', sha256(JSON.stringify(item)));
      results.push(item);
    } catch (error) {
      try {
        receipt.finish('indeterminate');
      } catch {}
      throw error;
    }
  }
  return results;
}
