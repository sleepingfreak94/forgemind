// One-time Windows owner setup (ADR-0017), run from an elevated PowerShell:
//   npm.cmd run windows:setup -- <owner folder outside the repo> [--claude <claude.exe>] [--cursor <cursor-agent version folder>]
//     [folder a contained run must stat]...
// Builds the sandbox launcher from this checkout's reviewed source with the in-box C# compiler, copies node.exe,
// makes the folder owner-only and writes windows-host.json, which runs pin. Each machine pins its own build.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile } from '../dist/src/host-enforcement/manifest.js';
import { LAUNCHER_SOURCE, launcherSourceDigest, WINDOWS_LOOPBACK_PORTS } from '../dist/src/host-enforcement/windows-host.js';
import { checkLoopbackLock } from './windows-loopback-check.mjs';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const fail = message => { process.stderr.write(`windows-setup: ${message}\n`); process.exit(2); };
const run = (file, args) => execFileSync(file, args, { encoding: 'utf8', windowsHide: true });
// Elevated: never resolve system tools through PATH.
const system32 = name => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', name);

if (process.platform !== 'win32') fail('run this on Windows');
const [target, ...extra] = process.argv.slice(2);
const option = name => {
  const at = extra.indexOf(name);
  if (at < 0) return undefined;
  const [, value] = extra.splice(at, 2);
  if (!value || !isAbsolute(value) || !existsSync(value)) fail(`${name} needs an absolute existing path`);
  return value;
};
const claudeSource = option('--claude'), cursorSource = option('--cursor');
if (cursorSource && (!existsSync(join(cursorSource, 'node.exe')) || !existsSync(join(cursorSource, 'index.js')))) fail('--cursor needs a cursor-agent version folder (node.exe, index.js)');
if (!target || !isAbsolute(target)) fail('pass an absolute owner folder');
mkdirSync(target, { recursive: true });
const folder = realpathSync.native(target), rest = relative(repository, folder);
if (rest === '' || (!rest.startsWith('..') && !isAbsolute(rest))) fail('the owner folder must be outside the repository');
for (const path of extra) if (!isAbsolute(path) || !existsSync(path)) fail(`not an existing absolute folder: ${path}`);

const compiler = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', process.arch === 'arm64' ? 'FrameworkArm64' : 'Framework64', 'v4.0.30319', 'csc.exe');
if (!existsSync(compiler)) fail(`no C# compiler at ${compiler}`);
// Lock the folder before anything is written or run in it: setup runs elevated, so a binary another user could swap
// would run as administrator. The SID comes from Windows, not from the launcher we are about to build.
const user = /"(S-1-5-21-[0-9-]+)"/.exec(run(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh']))?.[1];
if (!user) fail('could not read the user SID');
// Someone else may have created the folder (even empty): take ownership of it and everything below, drop every
// explicit ACE, then grant only the user, SYSTEM and Administrators.
run(system32('icacls.exe'), [folder, '/setowner', `*${user}`, '/T', '/C', '/Q']);
run(system32('icacls.exe'), [folder, '/reset', '/T', '/C', '/Q']);
run(system32('icacls.exe'), [folder, '/inheritance:r', '/grant:r', `*${user}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F']);
const bin = join(folder, 'bin'), runtime = join(folder, 'runtime'), stateRoot = join(folder, 'sandbox-state');
for (const path of [bin, runtime]) rmSync(path, { recursive: true, force: true });
for (const path of [bin, runtime, stateRoot]) mkdirSync(path, { recursive: true });
const sources = readdirSync(LAUNCHER_SOURCE).filter(name => name.endsWith('.cs')).sort().map(name => join(LAUNCHER_SOURCE, name));
const launcher = join(bin, 'forgemind-sandbox.exe');
const built = spawnSync(compiler, ['/nologo', '/optimize', '/target:exe', '/r:System.Web.Extensions.dll', `/out:${launcher}`, ...sources],
  { stdio: 'inherit', shell: false, windowsHide: true });
if (built.status !== 0) fail('compilation failed');

// Windows stamps a new executable when it first runs (ctime moves), which would trip a run's drift check, so run each
// copy until its change time holds still before pinning.
const settle = (exe, args) => {
  const changeTime = () => lstatSync(exe, { bigint: true }).ctimeNs;
  for (let settled = 0, before = changeTime(), tries = 0; settled < 2; tries++) {
    if (tries > 10) fail(`${exe} keeps changing after it runs`);
    run(exe, args);
    const after = changeTime();
    settled = after === before ? settled + 1 : 0; before = after;
  }
};
const node = join(runtime, 'node.exe');
copyFileSync(process.execPath, node);
settle(node, ['-e', '0']);
// Claude Code is one executable; the private copy is what runs pin (the installer's copy updates itself).
const claude = claudeSource ? join(runtime, 'claude', 'claude.exe') : undefined;
if (claude) { mkdirSync(dirname(claude)); copyFileSync(claudeSource, claude); settle(claude, ['--version']); }
// Cursor is a version folder (its own node.exe, index.js, rg.exe); the copy is pinned by manifest at session open.
// The stdio shim it preloads sits beside it, outside the manifest (ADR-0017 phase 2b).
const cursor = cursorSource ? join(runtime, 'cursor', basename(cursorSource)) : undefined, shim = cursor ? join(runtime, 'cursor', 'stdio-files.cjs') : undefined;
if (cursor) {
  cpSync(cursorSource, cursor, { recursive: true, dereference: false, errorOnExist: true });
  copyFileSync(join(LAUNCHER_SOURCE, 'stdio-files.cjs'), shim);
  settle(join(cursor, 'node.exe'), ['-e', '0']);
}
// Contained Node stats every ancestor of the paths it opens; this grants read-attributes only, never contents.
const { capability } = JSON.parse(run(launcher, ['setup', runtime, stateRoot, ...extra.map(path => realpathSync.native(path))]));
if (!/^S-1-15-3-[0-9-]+$/.test(capability)) fail('unexpected capability SID');
// Every contained run may read and execute the node.exe copy. Granting it once, here, means runs never edit the ACLs
// above a pinned file, which would change its identity mid-run.
run(system32('icacls.exe'), [runtime, '/grant', `*${capability}:(OI)(CI)RX`]);
// Only the fixed provider containers may reach loopback, where the host runs the allow-list proxy (ADR-0017 phase 2).
for (const name of ['forgemind.claude', 'forgemind.cursor']) {
  const { sid } = JSON.parse(run(launcher, ['sid', name]));
  if (!/^S-1-15-2-[0-9-]+$/.test(sid)) fail('unexpected container SID');
  run(system32('CheckNetIsolation.exe'), ['LoopbackExempt', '-a', `-p=${sid}`]);
}
// The exemption reaches every 127.0.0.1 listener; persistent WFP filters narrow it to ForgeMind's own port range.
run(launcher, ['loopback', String(WINDOWS_LOOPBACK_PORTS.first), String(WINDOWS_LOOPBACK_PORTS.last)]);
for (const [mode, path] of [['private', folder], ['private', bin], ['private', launcher], ['private', stateRoot], ['trusted', runtime], ['trusted', node],
  ...(claude ? [['trusted', claude]] : []), ...(cursor ? [['trusted', cursor], ['trusted', join(cursor, 'node.exe')], ['trusted', shim]] : [])]) {
  const check = JSON.parse(run(launcher, ['acl', mode, path]));
  if (check.ok !== true) fail(`${path} is not ${mode}: ${check.reason}`);
}

// Prove the lock before recording the host: a contained probe must reach the range and nothing else on loopback.
for (const name of ['forgemind.claude', 'forgemind.cursor']) {
  const problem = await checkLoopbackLock({ launcher, node, stateRoot, folder, container: name });
  if (problem) fail(`loopback lock for ${name}: ${problem}`);
}

const host = { version: 1, launcher: { path: launcher, sha256: hashFile(launcher) }, sourceSha256: launcherSourceDigest(),
  node: { path: node, sha256: hashFile(node) }, ...(claude ? { claude: { path: claude, sha256: hashFile(claude) } } : {}),
  ...(cursor ? { cursor: { directory: cursor, shim: { path: shim, sha256: hashFile(shim) } } } : {}), stateRoot };
writeFileSync(join(folder, 'windows-host.json'), JSON.stringify(host, null, 2) + '\n');
process.stdout.write(`${JSON.stringify({ windowsHost: folder, ...host }, null, 2)}\n`);
