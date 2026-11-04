import { lstatSync, realpathSync, mkdirSync, mkdtempSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { protectedPaths } from '../host-enforcement/windows-sandbox.js';
import { windowsHost } from '../host-enforcement/windows-host.js';
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
  // No profile allows fork: the command is the only process, so nothing can outlive the supervisor's reap.
  // Tests use e.g. Node --test-isolation=none. node-project (ADR-0015) adds read-only node_modules.
  return [
    '(version 1)', '(deny default)',
    `(allow process-exec ${literal(executable)})`,
    '(allow process-info* (target same-sandbox))', '(allow sysctl-read)', '(allow file-read-metadata)',
    `(allow file-read* (literal "/") (subpath "/usr/lib") (subpath "/System/Library") (literal "/dev/null") ${subpath(root)} ${subpath(scratch)}${nodeModules ? ' ' + subpath(nodeModules) : ''} ${files.map(literal).join(' ')})`,
    `(deny file-read* ${subpath(join(root, '.git'))} ${subpath(join(root, '.codex'))} (regex #"(^|/)\\.env($|\\.)"))`,
    `(allow file-write* ${subpath(scratch)}${nodeModules ? ' (literal "/dev/null")' : ''})`,
  ].join('\n');
}
/** Windows form of checkProfile: read the tree, write scratch, never .git, .codex or .env*, and no child processes.
 * The pinned node.exe is readable through the runtime capability that windows:setup granted. */
export function windowsCheckPolicy(root: string, scratch: string) {
  return { readPaths: [root], writePaths: [scratch], denyPaths: protectedPaths(root), activeProcessLimit: 1 };
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
  phaseEvidence = true,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const windows = process.platform === 'win32', canonical = windows ? realpathSync.native : realpathSync;
  // All node-project checks of one phase share a scratch, in manifest order (build, then test).
  let shared: string | undefined, unlink: (() => void) | undefined;
  try {
    for (const command of commands) {
      signal.throwIfAborted();
      const node = command.profile === 'node-project';
      if (windows && node) throw new Error('node-project checks are not supported on Windows yet');
      if (node) {
        if (!runtime) throw new Error('node-project checks require an owner-selected --node-modules');
        assertCheckRuntime(runtime, root);
      }
      const executable = canonical(command.executable),
        files = runtimeFiles(executable);
      if (windows && executable !== windowsHost().node.path)
        throw new Error('Windows checks must run the node.exe that windows:setup pinned');
      // Either the pinned Node runtime or an owner-installed tool such as the native TypeScript compiler.
    if (node && executable !== runtime!.node && !executable.startsWith(runtime!.nodeModules + '/'))
      throw new Error('node-project checks must run the pinned Node runtime or a tool inside the selected node_modules');
      let scratch: string;
      if (node && shared) scratch = shared;
      else {
        scratch = canonical(mkdtempSync(join(scratchParent, node ? 'node-project-' : 'check-')));
        mkdirSync(join(scratch, 'tmp'), { mode: 0o700 });
        if (node) {
          symlinkSync(runtime!.nodeModules, join(scratch, 'node_modules'), 'dir'); shared = scratch;
          unlink = linkNodeModules(root, runtime!);
        }
      }
      const args = node
        ? command.args.map(a => a.replaceAll('{scratch}', scratch).replaceAll('{nodeModules}', runtime!.nodeModules))
        : command.args;
      const containment = windows ? windowsCheckPolicy(root, scratch) : undefined;
      const profile = containment ? JSON.stringify(containment) : checkProfile(root, scratch, executable, files, node ? runtime!.nodeModules : undefined);
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
          env: windows ? {
            SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
            // Windows points TEMP and TMP of an AppContainer at <LOCALAPPDATA>\Packages\<container>\AC\Temp, which the
            // profile creates and deletes, so LOCALAPPDATA must be the real one. The container can't read the rest of it.
            LOCALAPPDATA: process.env.LOCALAPPDATA ?? '',
            USERPROFILE: scratch, HOME: scratch,
            FORGEMIND_NESTED_SANDBOX: '1',
          } : {
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
          ...(containment ? { containment } : {}),
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
        const status = result.code === 0 ? 'completed' : 'failed';
        // Only orchestrator before/after phase checks carry an output digest: run history binds each phase check
        // result to exactly one terminal receipt with that digest, so in-session (host_check) and split-subtask
        // checks finish with status only, like other non-evidence actions.
        if (phaseEvidence) receipt.finish(status, sha256(JSON.stringify(item)));
        else receipt.finish(status);
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
