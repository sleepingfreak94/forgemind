import { lstatSync, realpathSync, mkdirSync, mkdtempSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { runtimeFiles, supervised } from './process.js';
import { sha256 } from './validation.js';
import { sourceIdentity } from './repository.js';
import { assertCheckRuntime } from './check-runtime.js';
import type { CheckRuntime } from './check-runtime.js';
import type { ActionAuthority, CheckCommand } from './contracts.js';
export interface CheckResult {
  id: string;
  passed: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}
const subpath = (path: string) => `(subpath ${JSON.stringify(path)})`;
const literal = (path: string) => `(literal ${JSON.stringify(path)})`;
function checkProfile(root: string, scratch: string, executable: string, files: string[], nodeModules?: string): string {
  // single-process: no fork, so the command must use e.g. Node --test-isolation=none.
  // node-project (ADR-0015): fork, exec of the pinned Node runtime and of owner-installed tools inside the
  // read-only node_modules (for example the native TypeScript compiler); nothing the check can write is executable.
  return [
    '(version 1)', '(deny default)',
    `(allow process-exec ${literal(executable)}${nodeModules ? ' ' + subpath(nodeModules) : ''})`,
    ...(nodeModules ? ['(allow process-fork)', '(allow signal (target same-sandbox))'] : []),
    '(allow process-info* (target same-sandbox))', '(allow sysctl-read)', '(allow file-read-metadata)',
    `(allow file-read* (literal "/") (subpath "/usr/lib") (subpath "/System/Library") (literal "/dev/null") ${subpath(root)} ${subpath(scratch)}${nodeModules ? ' ' + subpath(nodeModules) : ''} ${files.map(literal).join(' ')})`,
    `(deny file-read* ${subpath(join(root, '.git'))} ${subpath(join(root, '.codex'))} (regex #"(^|/)\\.env($|\\.)"))`,
    `(allow file-write* ${subpath(scratch)}${nodeModules ? ' (literal "/dev/null")' : ''})`,
  ].join('\n');
}
/** Tools such as tsc resolve packages upward from the sources, so a node-project phase links the selected
 * node_modules into the checked tree. The link must be ignored (source identity unchanged) and is removed after. */
function linkNodeModules(root: string, runtime: CheckRuntime): () => void {
  const link = join(root, 'node_modules');
  let existing = false;
  try { lstatSync(link); existing = true; } catch {}
  if (existing) {
    if (realpathSync(link) !== runtime.nodeModules) throw new Error('Checked tree node_modules is not the selected node_modules');
    return () => {};
  }
  const before = sourceIdentity(root);
  symlinkSync(runtime.nodeModules, link, 'dir');
  const remove = () => { try { unlinkSync(link); } catch {} };
  let after: string | undefined;
  try { after = sourceIdentity(root); } catch {}
  if (after !== before) {
    remove();
    throw new Error('A node_modules link would change source identity; ignore /node_modules in the project');
  }
  return remove;
}
/** Checks get repository reads and private scratch writes. No network, credentials or source writes. */
export async function runChecks(
  root: string,
  source: string,
  commands: CheckCommand[],
  scratchParent: string,
  authority: ActionAuthority,
  signal: AbortSignal,
  runtime?: CheckRuntime,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  // All node-project checks of one phase share a scratch, in manifest order (build, then test).
  let shared: string | undefined, unlink: (() => void) | undefined;
  try {
    for (const command of commands) {
      signal.throwIfAborted();
      const node = command.profile === 'node-project';
      if (node) {
        if (!runtime) throw new Error('node-project checks require an owner-selected --node-modules');
        assertCheckRuntime(runtime, root);
      }
      const executable = realpathSync(command.executable),
        files = runtimeFiles(executable);
      if (node && executable !== runtime!.node) throw new Error('node-project checks must run the pinned Node runtime');
      let scratch: string;
      if (node && shared) scratch = shared;
      else {
        scratch = realpathSync(mkdtempSync(join(scratchParent, node ? 'node-project-' : 'check-')));
        mkdirSync(join(scratch, 'tmp'), { mode: 0o700 });
        if (node) {
          symlinkSync(runtime!.nodeModules, join(scratch, 'node_modules'), 'dir'); shared = scratch;
          unlink = linkNodeModules(root, runtime!);
        }
      }
      const args = node
        ? command.args.map(a => a.replaceAll('{scratch}', scratch).replaceAll('{nodeModules}', runtime!.nodeModules))
        : command.args;
      const profile = checkProfile(root, scratch, executable, files, node ? runtime!.nodeModules : undefined);
      const receipt = authority.reserve({
        kind: 'command',
        source,
        detail: {
          id: command.id,
          executable,
          dependencies: files,
          args,
          cwd: root,
          profileSha256: sha256(profile),
          timeoutMs: command.timeoutMs,
          ...(node ? { profile: 'node-project', nodeModules: runtime!.nodeModules, lockSha256: runtime!.lockSha256,
            nodeModulesIdentity: runtime!.identity, unhashed: ['nodeModulesContents'] } : {}),
        },
      });
      try {
        const result = await supervised({
          executable,
          dependencies: files,
          args,
          cwd: root,
          env: {
            PATH: '/usr/bin:/bin',
            HOME: scratch,
            TMPDIR: join(scratch, 'tmp'),
            LANG: 'C',
            LC_ALL: 'C',
            OPENSSL_CONF: '/dev/null',
            // Seatbelt cannot nest: tests that apply their own profile detect this and skip.
            FORGEMIND_NESTED_SANDBOX: '1',
          },
          profile,
          timeoutMs: command.timeoutMs,
          maxOutputBytes: 1048576,
          signal,
          check: () => { receipt.check(); if (node) assertCheckRuntime(runtime, root); },
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
  } finally { unlink?.(); }
  return results;
}
