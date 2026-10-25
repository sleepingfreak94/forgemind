import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { supervised } from './process.js';
import type { ProcessRequest } from './process.js';

/** Reviewed Claude Code build (ADR-0014). A different binary needs a new Phase 0 review. */
export const REVIEWED_CLAUDE_CLI = Object.freeze({
  version: '2.1.309',
  versionOutput: '2.1.309 (Claude Code)',
  sha256: '5eadc0009cdcdbc0d06e58110d7b2baf88ced6088b1c33a60a21217fe410619c',
});
export type ReviewedClaudeBuild = { readonly version: string; readonly versionOutput: string; readonly sha256: string };
/** Only `pinClaudeCli` and `pinClaudeConformanceCli` create one; plain objects are refused at launch. */
export interface ClaudeCli { readonly path: string; readonly version: string; readonly sha256: string; readonly reviewed: boolean }
export type ClaudeRunner = (request: ProcessRequest) => Promise<{ stdout: string; stderr: string; code: number | null }>;

const literal = (path: string) => `(literal ${JSON.stringify(path)})`;
const subpath = (path: string) => `(subpath ${JSON.stringify(path)})`;
const pinned = new WeakSet<ClaudeCli>();
const inside = (root: string, path: string) => { const r = relative(root, path); return r === '' || !r.startsWith('..' + sep) && r !== '..' && !isAbsolute(r); };

/** Pin the unmodified installed binary by canonical path, exact version and content hash.
 * Only the reviewed build is accepted. */
export function pinClaudeCli(executable: string): ClaudeCli {
  return pinBuild(executable, REVIEWED_CLAUDE_CLI);
}
/** For conformance fakes only; production code must never call it. Runs the same pinning checks
 * against the supplied build; the result has `reviewed: false` unless the digest equals the reviewed one. */
export function pinClaudeConformanceCli(executable: string, build: ReviewedClaudeBuild): ClaudeCli {
  return pinBuild(executable, build);
}
function pinBuild(executable: string, build: ReviewedClaudeBuild): ClaudeCli {
  if (!isAbsolute(executable) || realpathSync(executable) !== executable) throw new Error('Canonical Claude executable required');
  const stat = lstatSync(executable);
  if (!stat.isFile() || !(stat.mode & 0o111) || stat.mode & 0o022) throw new Error('Claude executable must be a non-writable regular file');
  const digest = createHash('sha256').update(readFileSync(executable)).digest('hex');
  if (digest !== build.sha256) throw new Error('Claude executable is not the reviewed build');
  const version = execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 15000, env: { PATH: '/usr/bin:/bin' } }).trim();
  if (version !== build.versionOutput) throw new Error('Claude CLI version is not reviewed');
  const cli = Object.freeze({ path: executable, version: build.version, sha256: digest, reviewed: digest === REVIEWED_CLAUDE_CLI.sha256 });
  pinned.add(cli);
  return cli;
}
export function assertPinnedClaudeCli(cli: unknown): asserts cli is ClaudeCli {
  if (!cli || typeof cli !== 'object' || !pinned.has(cli as ClaudeCli)) throw new Error('Untrusted Claude executable pin');
}

/** Deny-default profile from Phase 0. Claude Code reads its own Keychain item through
 * /usr/bin/security; ForgeMind never reads it. Hostname egress filtering is unavailable.
 * The preference, cfprefs and logging reads are the system base the CLI needs to start;
 * only the Keychain additions were bisected, so the base is a disclosed residual (ADR-0014).
 * The CLI may write only its login Keychain file (and its .sb- save sibling) so refreshed
 * tokens persist; unsafe home paths are refused. */
export function claudeInferenceProfile(cli: ClaudeCli, scratch: string, profileDirectory: string, home: string, userCacheDirectory: string,
  mcpPort?: number): string {
  if (mcpPort !== undefined && (!Number.isSafeInteger(mcpPort) || mcpPort < 1024 || mcpPort > 65535)) throw new Error('Invalid MCP port');
  if (!/^\/[A-Za-z0-9._\/-]+$/.test(home) || home.includes('..')) throw new Error('Unsupported home path for the Claude sandbox');
  const keychainHome = home.replaceAll('.', '[.]');
  const mds = join(userCacheDirectory, 'mds');
  return [
    '(version 1)', '(deny default)',
    `(allow process-exec ${literal(cli.path)} ${literal('/usr/bin/security')})`,
    '(allow process-fork)', '(allow process-info* (target same-sandbox))', '(allow signal (target same-sandbox))',
    '(allow sysctl-read)', '(allow file-read-metadata)',
    `(allow file-read* (literal "/") ${['/usr/lib', '/usr/share', '/System', '/Library/Preferences', '/private/var/db/timezone'].map(subpath).join(' ')} ${['/dev/null', '/dev/urandom', '/dev/random', '/private/etc/ssl/cert.pem', '/private/etc/hosts', '/private/etc/resolv.conf', '/private/var/run/resolv.conf', cli.path].map(literal).join(' ')})`,
    `(allow file-read* file-write* ${subpath(scratch)} ${subpath(profileDirectory)} ${literal('/dev/null')} ${literal('/dev/tty')})`,
    `(allow file-read* ${subpath('/private/var/db/mds')} ${subpath('/Library/Keychains')} ${subpath(join(home, 'Library/Keychains'))} ${subpath(mds)} ${literal(join(home, 'Library/Preferences/com.apple.security.plist'))})`,
    `(allow file-read* ${literal('/usr/bin/security')})`,
    `(allow file-write* (regex #"^${keychainHome}/Library/Keychains/login[.]keychain-db([.]sb-[0-9a-f]+-[A-Za-z0-9]+)?$"))`,
    `(allow file-write* ${subpath(mds)})`,
    '(allow mach-lookup ' + ['com.apple.SecurityServer', 'com.apple.securityd.xpc', 'com.apple.security.agent', 'com.apple.trustd', 'com.apple.trustd.agent',
      'com.apple.system.opendirectoryd.libinfo', 'com.apple.system.opendirectoryd.membership', 'com.apple.dnssd.service', 'com.apple.mDNSResponder',
      'com.apple.cfprefsd.agent', 'com.apple.cfprefsd.daemon', 'com.apple.system.notification_center', 'com.apple.logd', 'com.apple.diagnosticd']
      .map(name => `(global-name ${JSON.stringify(name)})`).join(' ') + ')',
    '(allow ipc-posix-shm-read* (ipc-posix-name-prefix "apple.cfprefs."))', '(allow user-preference-read)',
    `(allow network-outbound (remote tcp "*:443") (remote udp "*:53") (literal "/private/var/run/mDNSResponder")${mcpPort ? ` (remote ip "localhost:${mcpPort}")` : ''})`,
    '(allow system-socket)',
  ].join('\n');
}

interface SessionState { readonly cli: ClaudeCli; profileDirectory: string; home: string; userCacheDirectory: string; subscriptionType: string; closed: boolean }
const sessions = new WeakMap<ClaudeSubscriptionSession, SessionState>();
let mint: (state: SessionState) => ClaudeSubscriptionSession;
/** Owner's own Claude sign-in, made through Claude Code's flow. Holds paths only, never tokens. */
export class ClaudeSubscriptionSession {
  private constructor() {}
  static { mint = state => { const session = new ClaudeSubscriptionSession(); sessions.set(session, state); return session; }; }
  get subscriptionType(): string { return this.#state().subscriptionType; }
  /** Child launch for one invocation; the profile is shared, everything writable else is per-call scratch. */
  launch(cli: ClaudeCli, scratch: string, args: string[], input: string, limits: { timeoutMs: number; maxOutputBytes: number },
    signal: AbortSignal, check: () => void, mcpPort?: number): ProcessRequest {
    const state = this.#state();
    assertPinnedClaudeCli(cli);
    if (cli !== state.cli) throw new Error("Claude CLI differs from the session's pinned build");
    const tmp = join(scratch, 'tmp'), work = join(scratch, 'work');
    for (const directory of [tmp, work]) mkdirSync(directory, { mode: 0o700, recursive: true });
    return {
      executable: cli.path, executableSha256: cli.sha256, args, cwd: work, input, signal, check, ...limits,
      profile: claudeInferenceProfile(cli, scratch, state.profileDirectory, state.home, state.userCacheDirectory, mcpPort),
      env: {
        PATH: '/usr/bin:/bin', HOME: state.home, USER: userInfo().username, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8',
        TMPDIR: tmp, CLAUDE_CODE_TMPDIR: tmp, CLAUDE_CONFIG_DIR: state.profileDirectory,
        DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        // No CLI-side retries; a reported retry is rejected by the stream parser regardless.
        CLAUDE_CODE_MAX_RETRIES: '0',
      },
    };
  }
  assertActive(): void { this.#state(); }
  close(): void { const state = sessions.get(this); if (state) state.closed = true; }
  #state(): SessionState {
    const state = sessions.get(this);
    if (!state || state.closed) throw new Error('Claude subscription session inactive');
    return state;
  }
}
export function assertClaudeSession(value: unknown): asserts value is ClaudeSubscriptionSession {
  if (!(value instanceof ClaudeSubscriptionSession) || !sessions.has(value)) throw new Error('Untrusted Claude session');
  value.assertActive();
}

/** Validate the owner-private profile and ask the sandboxed CLI whether it is signed in.
 * Only loggedIn/authMethod/apiProvider/subscriptionType are read from its answer. */
export async function openClaudeSubscriptionSession(options: {
  profileDirectory: string; cli: ClaudeCli; scratchRoot: string;
  /** Project source, run state and worktree roots the profile must neither contain nor sit inside. */
  separateFrom?: readonly string[]; signal?: AbortSignal; runner?: ClaudeRunner;
}): Promise<ClaudeSubscriptionSession> {
  const { profileDirectory, cli } = options;
  assertPinnedClaudeCli(cli);
  if (!isAbsolute(profileDirectory) || realpathSync(profileDirectory) !== profileDirectory) throw new Error('Canonical Claude profile directory required');
  const stat = lstatSync(profileDirectory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || stat.mode & 0o077) throw new Error('Claude profile must be an owner-only directory');
  for (const root of options.separateFrom ?? [])
    if (inside(root, profileDirectory) || inside(profileDirectory, root))
      throw new Error('Claude profile must be separate from project source, run state and worktrees');
  const home = realpathSync(homedir());
  const userCacheDirectory = realpathSync(execFileSync('/usr/bin/getconf', ['DARWIN_USER_CACHE_DIR'], { encoding: 'utf8' }).trim());
  const state: SessionState = { cli, profileDirectory, home, userCacheDirectory, subscriptionType: 'unknown', closed: false };
  const session = mint(state);
  const scratch = mkdtempSync(join(options.scratchRoot, 'claude-status-'));
  try {
    const result = await (options.runner ?? supervised)(session.launch(cli, scratch, ['auth', 'status'], '',
      { timeoutMs: 30000, maxOutputBytes: 65536 }, options.signal ?? AbortSignal.timeout(30000), () => {}));
    let status: Record<string, unknown>;
    try { status = JSON.parse(result.stdout); } catch { throw new Error('Claude sign-in status unavailable'); }
    if (result.code !== 0 || status.loggedIn !== true || status.authMethod !== 'claude.ai' || status.apiProvider !== 'firstParty')
      throw new Error('Claude profile is not signed in with a Claude subscription; run `claude auth login` with this CLAUDE_CONFIG_DIR yourself');
    const plan = status.subscriptionType;
    state.subscriptionType = typeof plan === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(plan) ? plan : 'unknown';
    return session;
  } catch (error) {
    session.close();
    throw error;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
