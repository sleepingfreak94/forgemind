import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { supervised } from './process.js';
import type { ProcessRequest } from './process.js';

/** Reviewed Cursor CLI build (docs/cursor-route-plan.md Phase 0): the whole version directory is pinned. */
export const REVIEWED_CURSOR_CLI = Object.freeze({
  version: '2026.10.22-27dcf5f',
  manifestSha256: '84d8f8c27a8e33e868e17c4c7ce82094fbf0e628e8d08d9e084915aa1803dd07',
});
export type ReviewedCursorBuild = { readonly version: string; readonly manifestSha256: string };
/** Only the pin functions create one; plain objects are refused at launch. */
export interface CursorCli {
  readonly directory: string; readonly node: string; readonly entry: string;
  readonly version: string; readonly manifestSha256: string; readonly reviewed: boolean;
}
export type CursorRunner = (request: ProcessRequest) => Promise<{ stdout: string; stderr: string; code: number | null }>;
/** Plan tiers that identify a company seat; every other tier is treated as personal. */
const COMPANY_TIERS = new Set(['Business', 'Teams', 'Enterprise']);
const pinned = new WeakSet<CursorCli>();
const inside = (root: string, path: string) => { const r = relative(root, path); return r === '' || !r.startsWith('..' + sep) && r !== '..' && !isAbsolute(r); };
const literal = (path: string) => `(literal ${JSON.stringify(path)})`;
const subpath = (path: string) => `(subpath ${JSON.stringify(path)})`;

/** Digest of every file in the version directory, by relative path; symlinks and writable files are refused. */
export function cursorBuildManifest(root: string): string {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Cursor CLI directory contains a symlink');
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) { if (lstatSync(path).mode & 0o022) throw new Error('Cursor CLI file is group or world writable'); files.push(path); }
      else throw new Error('Cursor CLI directory contains a special file');
    }
  };
  walk(root);
  const hash = createHash('sha256');
  for (const file of files.sort()) hash.update(relative(root, file) + '\0' + createHash('sha256').update(readFileSync(file)).digest('hex') + '\n');
  return hash.digest('hex');
}
/** Pin the reviewed, unmodified installed build by canonical version directory and manifest digest. */
export function pinCursorCli(directory: string): CursorCli { return pinBuild(directory, REVIEWED_CURSOR_CLI); }
/** For conformance fakes only; production code must never call it. */
export function pinCursorConformanceCli(directory: string, build: ReviewedCursorBuild): CursorCli { return pinBuild(directory, build); }
function pinBuild(directory: string, build: ReviewedCursorBuild): CursorCli {
  if (!isAbsolute(directory) || realpathSync(directory) !== directory || basename(directory) !== build.version)
    throw new Error('Canonical Cursor CLI version directory required');
  const node = join(directory, 'node'), entry = join(directory, 'index.js');
  for (const file of [node, entry]) if (!lstatSync(file).isFile()) throw new Error('Cursor CLI entry point missing');
  if (!(lstatSync(node).mode & 0o111)) throw new Error('Cursor CLI runtime is not executable');
  const digest = cursorBuildManifest(directory);
  if (digest !== build.manifestSha256) throw new Error('Cursor CLI is not the reviewed build');
  const cli = Object.freeze({ directory, node, entry, version: build.version, manifestSha256: digest,
    reviewed: digest === REVIEWED_CURSOR_CLI.manifestSha256 });
  pinned.add(cli);
  return cli;
}
export function assertPinnedCursorCli(cli: unknown): asserts cli is CursorCli {
  if (!cli || typeof cli !== 'object' || !pinned.has(cli as CursorCli)) throw new Error('Untrusted Cursor CLI pin');
}

/** Every Cursor model tool denied (file read and write, shell, web, MCP). In Cursor's permission model deny wins
 * over allow, so this closes the ADR-0016 risk that ask mode's read tool can read the login in the profile. */
export const CURSOR_DENY_ALL: readonly string[] = Object.freeze(
  ['Read(**)', 'Read(/**)', 'Write(**)', 'Write(/**)', 'Shell(*)', 'WebFetch(*)', 'Mcp(*:*)']);

interface CheckedDirectory { readonly dir: string; readonly dev: number; readonly ino: number }
function cursorConfigDirectory(parent: string): CheckedDirectory {
  const dir = join(parent, '.cursor');
  let stat = lstatSync(dir, { throwIfNoEntry: false });
  if (!stat) { mkdirSync(dir, { mode: 0o700 }); stat = lstatSync(dir); }
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)
    throw new Error(`Cursor ${dir} (.cursor) must be a real directory owned by the current user`);
  return { dir, dev: stat.dev, ino: stat.ino };
}
function assertSameDirectory(checked: CheckedDirectory): void {
  const stat = lstatSync(checked.dir, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory() || stat.dev !== checked.dev || stat.ino !== checked.ino)
    throw new Error('Cursor .cursor directory changed while it was locked');
}
function replaceFile(dir: string, name: string, data: string): void {
  const tmp = join(dir, `.${name}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, data, { flag: 'wx', mode: 0o600 });
    renameSync(tmp, join(dir, name));
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw error;
  }
}
/** Write deny-all permission configs into the profile and work `.cursor` directories. The sandboxed CLI can write
 * in its profile, so the host never follows links: directories must be real, files are replaced by rename. */
export function lockCursorPermissions(profileDirectory: string, workDirectory: string): void {
  const profile = cursorConfigDirectory(profileDirectory), work = cursorConfigDirectory(workDirectory);
  replaceFile(profile.dir, 'cli-config.json', JSON.stringify({ version: 1, editor: { vimMode: false }, approvalMode: 'allowlist',
    permissions: { allow: [], deny: CURSOR_DENY_ALL } }, null, 2) + '\n');
  replaceFile(work.dir, 'cli.json', JSON.stringify({ permissions: { allow: [], deny: CURSOR_DENY_ALL } }, null, 2) + '\n');
  assertSameDirectory(profile);
  assertSameDirectory(work);
}

/** Deny-default profile from Phase 0: no fork, no Keychain (file credential store), reads of the system
 * and the pinned build only, writes to per-call scratch and the owner's Cursor profile. */
export function cursorProfile(cli: CursorCli, scratch: string, profileDirectory: string): string {
  return [
    '(version 1)', '(deny default)',
    `(allow process-exec ${literal(cli.node)})`,
    '(allow process-info* (target same-sandbox))', '(allow sysctl-read)', '(allow file-read-metadata)',
    `(allow file-read* (literal "/") ${['/usr/lib', '/usr/share', '/System', '/private/var/db/timezone', cli.directory].map(subpath).join(' ')} ${['/dev/null', '/dev/urandom', '/dev/random', '/private/etc/ssl/cert.pem', '/private/etc/hosts', '/private/etc/resolv.conf', '/private/var/run/resolv.conf'].map(literal).join(' ')})`,
    `(allow file-read* file-write* ${subpath(scratch)} ${subpath(profileDirectory)} ${literal('/dev/null')} ${literal('/dev/tty')})`,
    '(allow mach-lookup ' + ['com.apple.system.opendirectoryd.libinfo', 'com.apple.dnssd.service', 'com.apple.mDNSResponder', 'com.apple.trustd',
      'com.apple.trustd.agent', 'com.apple.SecurityServer', 'com.apple.cfprefsd.agent', 'com.apple.cfprefsd.daemon']
      .map(name => `(global-name ${JSON.stringify(name)})`).join(' ') + ')',
    '(allow network-outbound (remote tcp "*:443") (remote udp "*:53") (literal "/private/var/run/mDNSResponder"))', '(allow system-socket)',
  ].join('\n');
}

interface SessionState { readonly cli: CursorCli; readonly workspace: string; profileDirectory: string; tier: string; company: boolean; closed: boolean }
const sessions = new WeakMap<CursorSubscriptionSession, SessionState>();
let mint: (state: SessionState) => CursorSubscriptionSession;
/** Owner's own Cursor sign-in, made through Cursor's flow into a dedicated profile. Holds paths only, never tokens. */
export class CursorSubscriptionSession {
  private constructor() {}
  static { mint = state => { const session = new CursorSubscriptionSession(); sessions.set(session, state); return session; }; }
  get tier(): string { return this.#state().tier; }
  get company(): boolean { return this.#state().company; }
  /** Child launch for one invocation; the pinned build is re-verified and everything writable is per-call scratch or the profile. */
  launch(cli: CursorCli, scratch: string, args: string[], input: string, limits: { timeoutMs: number; maxOutputBytes: number },
    signal: AbortSignal, check: () => void): ProcessRequest {
    const state = this.#state();
    assertPinnedCursorCli(cli);
    if (cli !== state.cli) throw new Error("Cursor CLI differs from the session's pinned build");
    if (cursorBuildManifest(cli.directory) !== cli.manifestSha256) throw new Error('Cursor CLI changed since it was pinned');
    const tmp = join(scratch, 'tmp'), work = join(scratch, 'work');
    for (const directory of [tmp, work]) mkdirSync(directory, { mode: 0o700, recursive: true });
    lockCursorPermissions(state.profileDirectory, work);
    return {
      executable: cli.node, args: [cli.entry, ...args], dependencies: [cli.entry], cwd: work, input, signal, check, ...limits,
      profile: cursorProfile(cli, scratch, state.profileDirectory),
      env: {
        PATH: '/usr/bin:/bin', HOME: state.profileDirectory, USER: process.env.USER || String(process.getuid?.() ?? ''), LANG: 'en_US.UTF-8',
        TMPDIR: tmp, AGENT_CLI_CREDENTIAL_STORE: 'file', NO_OPEN_BROWSER: '1',
      },
    };
  }
  /** A session is bound to the workspace its plan tier and allowlist were checked for. */
  assertWorkspace(workspace: string): void {
    if (realpathSync(workspace) !== this.#state().workspace) throw new Error('Cursor session was opened for a different workspace');
  }
  assertActive(): void { this.#state(); }
  close(): void { const state = sessions.get(this); if (state) state.closed = true; }
  #state(): SessionState {
    const state = sessions.get(this);
    if (!state || state.closed) throw new Error('Cursor subscription session inactive');
    return state;
  }
}
export function assertCursorSession(value: unknown): asserts value is CursorSubscriptionSession {
  if (!(value instanceof CursorSubscriptionSession) || !sessions.has(value)) throw new Error('Untrusted Cursor session');
  value.assertActive();
}

/** Validate the owner-private profile, ask the sandboxed CLI whether it is signed in and on which plan,
 * and on a personal plan allow only owner-listed workspaces. Only the sign-in line and plan tier are read. */
export async function openCursorSubscriptionSession(options: {
  profileDirectory: string; cli: CursorCli; scratchRoot: string; workspace: string;
  /** Owner-listed workspaces a personal plan may run on; company code needs a company seat. */
  personalWorkspaces: readonly string[];
  separateFrom?: readonly string[]; signal?: AbortSignal; runner?: CursorRunner;
}): Promise<CursorSubscriptionSession> {
  const { profileDirectory, cli } = options;
  assertPinnedCursorCli(cli);
  for (const name of ['CURSOR_API_KEY', 'CURSOR_API_ENDPOINT'])
    if (process.env[name] !== undefined) throw new Error(`${name} is set; the Cursor route uses only the owner's own login`);
  if (!isAbsolute(profileDirectory) || realpathSync(profileDirectory) !== profileDirectory) throw new Error('Canonical Cursor profile directory required');
  const stat = lstatSync(profileDirectory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || stat.mode & 0o077) throw new Error('Cursor profile must be an owner-only directory');
  if (inside(profileDirectory, realpathSync(homedir())) || profileDirectory === realpathSync(homedir())) throw new Error('Cursor profile must not be the home directory');
  for (const root of [options.workspace, ...(options.separateFrom ?? [])])
    if (inside(root, profileDirectory) || inside(profileDirectory, root))
      throw new Error('Cursor profile must be separate from project source, run state and worktrees');
  const state: SessionState = { cli, workspace: realpathSync(options.workspace), profileDirectory, tier: 'unknown', company: false, closed: false };
  const session = mint(state);
  const scratch = mkdtempSync(join(options.scratchRoot, 'cursor-status-'));
  try {
    const run = (args: string[]) => (options.runner ?? supervised)(session.launch(cli, scratch, args, '',
      { timeoutMs: 60000, maxOutputBytes: 65536 }, options.signal ?? AbortSignal.timeout(60000), () => {}));
    const status = await run(['status']);
    if (status.code !== 0 || !/^\S*\s*Logged in as \S+/m.test(status.stdout))
      throw new Error('Cursor profile is not signed in; run `cursor-agent login` with this HOME and AGENT_CLI_CREDENTIAL_STORE=file yourself');
    const about = await run(['about']);
    const tier = /^Subscription Tier\s+([A-Za-z+ ]{1,30}?)\s*$/m.exec(about.stdout)?.[1];
    if (about.code !== 0 || !tier) throw new Error('Cursor plan tier unavailable');
    state.tier = tier; state.company = COMPANY_TIERS.has(tier);
    if (!state.company && !options.personalWorkspaces.includes(options.workspace))
      throw new Error(`Cursor ${tier} plan is personal; this workspace is not on the owner's personal allowlist`);
    return session;
  } catch (error) {
    session.close();
    throw error;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
