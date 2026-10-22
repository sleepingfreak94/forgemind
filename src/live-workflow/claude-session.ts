import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { supervised } from './process.js';
import type { ProcessRequest } from './process.js';

/** Reviewed Claude Code build (ADR-0014). A different binary needs a new Phase 0 review. */
export const REVIEWED_CLAUDE_CLI = Object.freeze({
  version: '2.1.308',
  versionOutput: '2.1.308 (Claude Code)',
  sha256: 'ca923c86ac84b30574a82331a05b6e066c27477a926ceaffe46a845a33e4dd37',
});
export interface ClaudeCli { path: string; version: string; sha256: string }
export type ClaudeRunner = (request: ProcessRequest) => Promise<{ stdout: string; stderr: string; code: number | null }>;

const literal = (path: string) => `(literal ${JSON.stringify(path)})`;
const subpath = (path: string) => `(subpath ${JSON.stringify(path)})`;
const inside = (root: string, path: string) => { const r = relative(root, path); return r === '' || !r.startsWith('..' + sep) && r !== '..' && !isAbsolute(r); };

/** Pin the unmodified installed binary by canonical path, exact version and content hash. */
export function pinClaudeCli(executable: string): ClaudeCli {
  if (!isAbsolute(executable) || realpathSync(executable) !== executable) throw new Error('Canonical Claude executable required');
  const stat = lstatSync(executable);
  if (!stat.isFile() || !(stat.mode & 0o111) || stat.mode & 0o022) throw new Error('Claude executable must be a non-writable regular file');
  const digest = createHash('sha256').update(readFileSync(executable)).digest('hex');
  if (digest !== REVIEWED_CLAUDE_CLI.sha256) throw new Error('Claude executable is not the reviewed build');
  const version = execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 15000, env: { PATH: '/usr/bin:/bin' } }).trim();
  if (version !== REVIEWED_CLAUDE_CLI.versionOutput) throw new Error('Claude CLI version is not reviewed');
  return { path: executable, version: REVIEWED_CLAUDE_CLI.version, sha256: digest };
}

/** Deny-default profile from Phase 0. Claude Code reads its own Keychain item through
 * /usr/bin/security; ForgeMind never reads it. Hostname egress filtering is unavailable. */
export function claudeInferenceProfile(cli: ClaudeCli, scratch: string, profileDirectory: string, home: string, userCacheDirectory: string): string {
  const mds = join(userCacheDirectory, 'mds');
  return [
    '(version 1)', '(deny default)',
    `(allow process-exec ${literal(cli.path)} ${literal('/usr/bin/security')})`,
    '(allow process-fork)', '(allow process-info* (target same-sandbox))', '(allow signal (target same-sandbox))',
    '(allow sysctl-read)', '(allow file-read-metadata)',
    `(allow file-read* (literal "/") ${['/usr/lib', '/usr/share', '/System', '/Library/Preferences', '/private/var/db/timezone'].map(subpath).join(' ')} ${['/dev/null', '/dev/urandom', '/dev/random', '/private/etc/ssl/cert.pem', '/private/etc/hosts', '/private/etc/resolv.conf', '/private/var/run/resolv.conf', cli.path].map(literal).join(' ')})`,
    `(allow file-read* file-write* ${subpath(scratch)} ${subpath(profileDirectory)} ${literal('/dev/null')} ${literal('/dev/tty')})`,
    `(allow file-read* ${subpath('/private/var/db/mds')} ${subpath('/Library/Keychains')} ${subpath(join(home, 'Library/Keychains'))} ${subpath(mds)} ${literal(join(home, 'Library/Preferences/com.apple.security.plist'))})`,
    `(allow file-write* ${subpath(mds)})`,
    '(allow mach-lookup ' + ['com.apple.SecurityServer', 'com.apple.securityd.xpc', 'com.apple.security.agent', 'com.apple.trustd', 'com.apple.trustd.agent',
      'com.apple.system.opendirectoryd.libinfo', 'com.apple.system.opendirectoryd.membership', 'com.apple.dnssd.service', 'com.apple.mDNSResponder',
      'com.apple.cfprefsd.agent', 'com.apple.cfprefsd.daemon', 'com.apple.system.notification_center', 'com.apple.logd', 'com.apple.diagnosticd']
      .map(name => `(global-name ${JSON.stringify(name)})`).join(' ') + ')',
    '(allow ipc-posix-shm-read* (ipc-posix-name-prefix "apple.cfprefs."))', '(allow user-preference-read)',
    '(allow network-outbound (remote tcp "*:443") (remote udp "*:53") (literal "/private/var/run/mDNSResponder"))', '(allow system-socket)',
  ].join('\n');
}

interface SessionState { profileDirectory: string; home: string; userCacheDirectory: string; subscriptionType: string; closed: boolean }
const sessions = new WeakMap<ClaudeSubscriptionSession, SessionState>();
let mint: (state: SessionState) => ClaudeSubscriptionSession;
/** Owner's own Claude sign-in, made through Claude Code's flow. Holds paths only, never tokens. */
export class ClaudeSubscriptionSession {
  private constructor() {}
  static { mint = state => { const session = new ClaudeSubscriptionSession(); sessions.set(session, state); return session; }; }
  get subscriptionType(): string { return this.#state().subscriptionType; }
  /** Child launch for one invocation; the profile is shared, everything writable else is per-call scratch. */
  launch(cli: ClaudeCli, scratch: string, args: string[], input: string, limits: { timeoutMs: number; maxOutputBytes: number },
    signal: AbortSignal, check: () => void): ProcessRequest {
    const state = this.#state();
    const tmp = join(scratch, 'tmp'), work = join(scratch, 'work');
    for (const directory of [tmp, work]) mkdirSync(directory, { mode: 0o700, recursive: true });
    return {
      executable: cli.path, args, cwd: work, input, signal, check, ...limits,
      profile: claudeInferenceProfile(cli, scratch, state.profileDirectory, state.home, state.userCacheDirectory),
      env: {
        PATH: '/usr/bin:/bin', HOME: state.home, USER: userInfo().username, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8',
        TMPDIR: tmp, CLAUDE_CODE_TMPDIR: tmp, CLAUDE_CONFIG_DIR: state.profileDirectory,
        DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
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
  profileDirectory: string; cli: ClaudeCli; scratchRoot: string; workspace?: string; signal?: AbortSignal; runner?: ClaudeRunner;
}): Promise<ClaudeSubscriptionSession> {
  const { profileDirectory, cli } = options;
  if (!isAbsolute(profileDirectory) || realpathSync(profileDirectory) !== profileDirectory) throw new Error('Canonical Claude profile directory required');
  const stat = lstatSync(profileDirectory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || stat.mode & 0o077) throw new Error('Claude profile must be an owner-only directory');
  if (options.workspace && (inside(options.workspace, profileDirectory) || inside(profileDirectory, options.workspace)))
    throw new Error('Claude profile must be separate from project source');
  const home = realpathSync(homedir());
  const userCacheDirectory = realpathSync(execFileSync('/usr/bin/getconf', ['DARWIN_USER_CACHE_DIR'], { encoding: 'utf8' }).trim());
  const state: SessionState = { profileDirectory, home, userCacheDirectory, subscriptionType: 'unknown', closed: false };
  const session = mint(state);
  const scratch = mkdtempSync(join(options.scratchRoot, 'claude-status-'));
  const result = await (options.runner ?? supervised)(session.launch(cli, scratch, ['auth', 'status'], '',
    { timeoutMs: 30000, maxOutputBytes: 65536 }, options.signal ?? AbortSignal.timeout(30000), () => {}));
  let status: Record<string, unknown>;
  try { status = JSON.parse(result.stdout); } catch { throw new Error('Claude sign-in status unavailable'); }
  if (result.code !== 0 || status.loggedIn !== true || status.authMethod !== 'claude.ai' || status.apiProvider !== 'firstParty')
    throw new Error('Claude profile is not signed in with a Claude subscription; run `claude auth login` with this CLAUDE_CONFIG_DIR yourself');
  state.subscriptionType = typeof status.subscriptionType === 'string' ? status.subscriptionType.slice(0, 40) : 'unknown';
  return session;
}
