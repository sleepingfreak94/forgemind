import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { supervised } from './process.js';
import { isPrivate, isTrusted } from '../host-enforcement/owner-acl.js';
import { windowsHost } from '../host-enforcement/windows-host.js';
import { pinFile } from '../host-enforcement/manifest.js';
import { createNativeTunnel } from './native-executor-tunnel.js';
import type { NativeTunnel } from './native-executor-tunnel.js';
import type { ProcessRequest } from './process.js';

/** Reviewed Cursor CLI build (docs/cursor-route-plan.md Phase 0): the whole version directory is pinned. */
export const REVIEWED_CURSOR_CLI = Object.freeze({
  version: '2026.10.22-27dcf5f',
  manifestSha256: '84d8f8c27a8e33e868e17c4c7ce82094fbf0e628e8d08d9e084915aa1803dd07',
});
/** Windows build, pinned 2026-10-30 from the owner's Windows 11 ARM VM (setup's private copy). Contained conformance
 * only (ADR-0017 phase 2b): the Phase 0 review is pending, so its receipts record reviewedBuild: false. */
export const PINNED_CURSOR_CLI_WINDOWS = Object.freeze({
  version: '2026.10.22-27dcf5f',
  manifestSha256: 'c5065b1088005cae7a92c6f25c75e7a1f02c46ab7684ebcdfbfb3ceece1befbf',
});
/** Hosts the contained Cursor CLI may reach through the host's allow-list proxy (Windows): the API and the agent backend. */
export const CURSOR_PROXY_HOSTS = Object.freeze(['api2.cursor.sh', 'agentn.global.api5.cursor.sh']);
const windows = process.platform === 'win32';
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
      // Windows has no mode bits; pinBuild checks the copy's ACL instead (setup keeps it in the owner-controlled runtime).
      else if (entry.isFile()) { if (!windows && lstatSync(path).mode & 0o022) throw new Error('Cursor CLI file is group or world writable'); files.push(path); }
      else throw new Error('Cursor CLI directory contains a special file');
    }
  };
  walk(root);
  const hash = createHash('sha256');
  for (const file of files.sort()) hash.update(relative(root, file) + '\0' + createHash('sha256').update(readFileSync(file)).digest('hex') + '\n');
  return hash.digest('hex');
}
/** Pin the reviewed, unmodified installed build by canonical version directory and manifest digest. */
export function pinCursorCli(directory: string): CursorCli { return pinBuild(directory, windows ? PINNED_CURSOR_CLI_WINDOWS : REVIEWED_CURSOR_CLI); }
/** For conformance fakes only; production code must never call it. */
export function pinCursorConformanceCli(directory: string, build: ReviewedCursorBuild): CursorCli { return pinBuild(directory, build); }
function pinBuild(directory: string, build: ReviewedCursorBuild): CursorCli {
  if (!isAbsolute(directory) || (windows ? realpathSync.native : realpathSync)(directory) !== directory || basename(directory) !== build.version)
    throw new Error('Canonical Cursor CLI version directory required');
  const node = join(directory, windows ? 'node.exe' : 'node'), entry = join(directory, 'index.js');
  for (const file of [node, entry]) if (!lstatSync(file).isFile()) throw new Error('Cursor CLI entry point missing');
  if (windows ? !isTrusted(directory, lstatSync(directory)) || !isTrusted(node, lstatSync(node)) : !(lstatSync(node).mode & 0o111))
    throw new Error(windows ? 'Cursor CLI copy must be owner-controlled' : 'Cursor CLI runtime is not executable');
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
/** The one MCP server Cursor may use in tools mode: the loopback ForgeMind host tools. */
export const CURSOR_MCP_SERVER = 'forgemind';
const MCP_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}\/mcp\/[A-Za-z0-9_-]{16,}$/, MCP_TOOL = /^[a-z_]{1,40}$/;
const CURSOR_DENY_ALL_BUT_MCP: readonly string[] = Object.freeze(CURSOR_DENY_ALL.filter(rule => rule !== 'Mcp(*:*)'));
function checkMcpGrant(mcp: unknown): { url: string; tools: string[] } {
  const grant = mcp as { url?: unknown; tools?: unknown } | null;
  if (!grant || typeof grant !== 'object' || typeof grant.url !== 'string' || !MCP_URL.test(grant.url)
    || !Array.isArray(grant.tools) || grant.tools.length < 1 || grant.tools.length > 16
    || !grant.tools.every(t => typeof t === 'string' && MCP_TOOL.test(t))) throw new Error('Invalid Cursor MCP grant');
  return { url: grant.url, tools: [...grant.tools] };
}

interface CheckedDirectory { readonly dir: string; readonly dev: number; readonly ino: number }
function cursorConfigDirectory(parent: string): CheckedDirectory {
  const dir = join(parent, '.cursor');
  let stat = lstatSync(dir, { throwIfNoEntry: false });
  if (!stat) { mkdirSync(dir, { mode: 0o700 }); stat = lstatSync(dir); }
  if (!stat.isDirectory() || (windows ? !isPrivate(dir, stat) : stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0))
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
export function lockCursorPermissions(profileDirectory: string, workDirectory: string, mcp?: { url: string; tools: readonly string[] }): void {
  const grant = mcp === undefined ? undefined : checkMcpGrant(mcp);
  const profile = cursorConfigDirectory(profileDirectory), work = cursorConfigDirectory(workDirectory);
  const allow = grant ? grant.tools.map(t => `Mcp(${CURSOR_MCP_SERVER}:${t})`) : [];
  const deny = grant ? CURSOR_DENY_ALL_BUT_MCP : CURSOR_DENY_ALL;
  replaceFile(profile.dir, 'cli-config.json', JSON.stringify({ version: 1, editor: { vimMode: false }, approvalMode: 'allowlist',
    permissions: { allow, deny } }, null, 2) + '\n');
  replaceFile(work.dir, 'cli.json', JSON.stringify({ permissions: { allow, deny } }, null, 2) + '\n');
  // The profile can never add MCP servers; only the per-call work directory names the granted one.
  replaceFile(profile.dir, 'mcp.json', JSON.stringify({ mcpServers: {} }, null, 2) + '\n');
  // Cursor syncs account and team plugins into .cursor/plugins, and a plugin brings its own MCP servers (Figma's
  // mcp.figma.com) outside mcp.json. Remove them before every call; rm never follows a link, it removes the link itself.
  for (const dir of [profile.dir, work.dir]) rmSync(join(dir, 'plugins'), { recursive: true, force: true });
  if (grant) replaceFile(work.dir, 'mcp.json', JSON.stringify({ mcpServers: { [CURSOR_MCP_SERVER]: { url: grant.url } } }, null, 2) + '\n');
  assertSameDirectory(profile);
  assertSameDirectory(work);
}

/** Deny-default profile from Phase 0: no fork, no Keychain (file credential store), reads of the system
 * and the pinned build only, writes to per-call scratch and the owner's Cursor profile. */
export function cursorProfile(cli: CursorCli, scratch: string, profileDirectory: string, mcpPort?: number): string {
  if (mcpPort !== undefined && (!Number.isSafeInteger(mcpPort) || mcpPort < 1024 || mcpPort > 65535)) throw new Error('Invalid MCP port');
  return [
    '(version 1)', '(deny default)',
    `(allow process-exec ${literal(cli.node)})`,
    '(allow process-info* (target same-sandbox))', '(allow sysctl-read)', '(allow file-read-metadata)',
    `(allow file-read* (literal "/") ${['/usr/lib', '/usr/share', '/System', '/private/var/db/timezone', cli.directory].map(subpath).join(' ')} ${['/dev/null', '/dev/urandom', '/dev/random', '/private/etc/ssl/cert.pem', '/private/etc/hosts', '/private/etc/resolv.conf', '/private/var/run/resolv.conf'].map(literal).join(' ')})`,
    `(allow file-read* file-write* ${subpath(scratch)} ${subpath(profileDirectory)} ${literal('/dev/null')} ${literal('/dev/tty')})`,
    '(allow mach-lookup ' + ['com.apple.system.opendirectoryd.libinfo', 'com.apple.dnssd.service', 'com.apple.mDNSResponder', 'com.apple.trustd',
      'com.apple.trustd.agent', 'com.apple.SecurityServer', 'com.apple.cfprefsd.agent', 'com.apple.cfprefsd.daemon']
      .map(name => `(global-name ${JSON.stringify(name)})`).join(' ') + ')',
    `(allow network-outbound (remote tcp "*:443") (remote udp "*:53") (literal "/private/var/run/mDNSResponder")${mcpPort ? ` (remote ip "localhost:${mcpPort}")` : ''})`, '(allow system-socket)',
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
    signal: AbortSignal, check: () => void, mcp?: { url: string; port: number; tools: readonly string[] }, proxyPort?: number): ProcessRequest {
    const state = this.#state();
    assertPinnedCursorCli(cli);
    if (cli !== state.cli) throw new Error("Cursor CLI differs from the session's pinned build");
    if (cursorBuildManifest(cli.directory) !== cli.manifestSha256) throw new Error('Cursor CLI changed since it was pinned');
    if (mcp !== undefined && (typeof mcp.url !== 'string' || !mcp.url.startsWith(`http://127.0.0.1:${mcp.port}/mcp/`))) throw new Error('Invalid Cursor MCP grant');
    const tmp = join(scratch, 'tmp'), work = join(scratch, 'work');
    for (const directory of windows ? [work] : [tmp, work]) mkdirSync(directory, { mode: 0o700, recursive: true });
    lockCursorPermissions(state.profileDirectory, work, mcp && { url: mcp.url, tools: mcp.tools });
    if (windows) {
      // ADR-0017: the fixed forgemind.cursor container reaches only loopback (the host proxy for CURSOR_PROXY_HOSTS and
      // the MCP port, inside setup's loopback lock). The CLI copy is readable through the runtime capability.
      if (proxyPort !== undefined && (!Number.isSafeInteger(proxyPort) || proxyPort < 1024 || proxyPort > 65535)) throw new Error('Invalid proxy port');
      const shim = windowsHost().cursorShim;
      if (!shim) throw new Error('Windows Cursor runs need npm run windows:setup with --cursor');
      if (pinFile(shim.path).digest !== shim.digest) throw new Error('The Cursor stdio shim changed since setup');
      // Cursor starts rg, git and reg; a worker server and helpers stay within this limit.
      const containment = { readPaths: [], writePaths: [scratch, state.profileDirectory], denyPaths: [], activeProcessLimit: 8, container: 'forgemind.cursor' as const };
      return {
        // The shim keeps child stdio off libuv pipes, which loop forever inside an AppContainer before libuv 1.53.
        executable: cli.node, args: ['-r', shim.path, cli.entry, ...args], dependencies: [cli.entry, shim.path], cwd: work, input, signal, check, ...limits,
        containment, profile: JSON.stringify({ ...containment, mcpPort: mcp?.port ?? null, proxyPort: proxyPort ?? null, shimSha256: shim.digest }),
        env: {
          SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', PATH: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
          // Windows points the container's TEMP at its own AC\Temp (under the real LOCALAPPDATA); the shim writes there.
          LOCALAPPDATA: process.env.LOCALAPPDATA ?? '', USERPROFILE: state.profileDirectory, HOME: state.profileDirectory,
          APPDATA: join(state.profileDirectory, 'AppData', 'Roaming'), CI: '1', AGENT_CLI_CREDENTIAL_STORE: 'file', NO_OPEN_BROWSER: '1',
          // Without a proxy the container has no route out at all (no internet capability), so a missing port fails closed.
          ...(proxyPort ? { NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`, HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
            NO_PROXY: '127.0.0.1,localhost' } : {}),
        },
      };
    }
    return {
      executable: cli.node, args: [cli.entry, ...args], dependencies: [cli.entry], cwd: work, input, signal, check, ...limits,
      profile: cursorProfile(cli, scratch, state.profileDirectory, mcp?.port),
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
/** Windows: the per-call allow-list relay the contained CLI reaches its hosts through (ADR-0017). */
export async function openCursorTunnel(real: boolean, check: () => void, onRefused?: (target: string) => void): Promise<NativeTunnel | undefined> {
  return windows && real ? createNativeTunnel(0, check, CURSOR_PROXY_HOSTS, onRefused) : undefined;
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
  if (!isAbsolute(profileDirectory) || (windows ? realpathSync.native : realpathSync)(profileDirectory) !== profileDirectory) throw new Error('Canonical Cursor profile directory required');
  const stat = lstatSync(profileDirectory);
  if (!stat.isDirectory() || !isPrivate(profileDirectory, stat)) throw new Error('Cursor profile must be an owner-only directory');
  const home = (windows ? realpathSync.native : realpathSync)(homedir());
  if (inside(profileDirectory, home) || profileDirectory === home) throw new Error('Cursor profile must not be the home directory');
  for (const root of [options.workspace, ...(options.separateFrom ?? [])])
    if (inside(root, profileDirectory) || inside(profileDirectory, root))
      throw new Error('Cursor profile must be separate from project source, run state and worktrees');
  const state: SessionState = { cli, workspace: realpathSync(options.workspace), profileDirectory, tier: 'unknown', company: false, closed: false };
  const session = mint(state);
  const scratch = mkdtempSync(join(options.scratchRoot, 'cursor-status-'));
  try {
    const run = async (args: string[]) => {
      const tunnel = await openCursorTunnel(!options.runner, () => {});
      try {
        return await (options.runner ?? supervised)(session.launch(cli, scratch, args, '',
          { timeoutMs: 60000, maxOutputBytes: 65536 }, options.signal ?? AbortSignal.timeout(60000), () => {}, undefined, tunnel?.port));
      } finally { await tunnel?.stop(); }
    };
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
