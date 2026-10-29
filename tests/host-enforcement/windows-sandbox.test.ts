import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pinWindowsLauncher, protectedPaths, runContained, sweepWindowsSandbox } from '../../src/host-enforcement/windows-sandbox.js';
import type { ContainedCommand, WindowsLauncher } from '../../src/host-enforcement/windows-sandbox.js';

test('protected paths cover .git, .codex and .env files at any depth without following links', t => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'forgemind-protected-'))); t.after(() => rmSync(root, { recursive: true, force: true }));
  const outside = realpathSync.native(mkdtempSync(join(tmpdir(), 'forgemind-outside-'))); t.after(() => rmSync(outside, { recursive: true, force: true }));
  for (const dir of ['.git', '.codex', 'src/deep', 'pkg/.Codex']) mkdirSync(join(root, dir), { recursive: true });
  for (const file of ['.env', 'src/deep/.env.local', 'pkg/.ENV', '.envrc', 'src/env.ts', 'README.md']) writeFileSync(join(root, file), 'x');
  writeFileSync(join(outside, '.env'), 'x');
  symlinkSync(outside, join(root, 'linked'), 'junction');
  assert.deepEqual(protectedPaths(root), ['.codex', '.env', '.git', 'pkg/.Codex', 'pkg/.ENV', 'src/deep/.env.local'].map(path => join(root, path)).sort());
});

test('the Windows sandbox refuses to run anywhere but Windows', { skip: process.platform === 'win32' }, async () => {
  assert.throws(() => pinWindowsLauncher(process.execPath, 'a'.repeat(64)), /requires Windows/);
  await assert.rejects(runContained({ path: process.execPath, digest: 'a'.repeat(64) }, {} as ContainedCommand, tmpdir()), /requires Windows/);
});

// Needs an owner-built launcher (npm run build:windows-launcher) and an elevated shell, because setup grants
// read-attributes on the temporary folder's ancestors (C:\ and C:\Users) once.
const launcherPath = process.env.FORGEMIND_WINDOWS_LAUNCHER, launcherDigest = process.env.FORGEMIND_WINDOWS_LAUNCHER_SHA256;
const contained = { skip: process.platform !== 'win32' || !launcherPath || !launcherDigest, timeout: 120000 };

function workspace(t: test.TestContext) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'forgemind-sandbox-')));
  const root = join(base, 'root'), scratch = join(base, 'scratch'), runtime = join(base, 'runtime'), state = join(base, 'state');
  for (const dir of [root, scratch, runtime, state, join(root, '.git')]) mkdirSync(dir);
  writeFileSync(join(root, 'value.txt'), 'source'); writeFileSync(join(root, '.env'), 'TOKEN=leak'); writeFileSync(join(root, '.git', 'config'), 'x');
  // Node's MSI install grants no AppContainer read, so contained runs use an owner-private copy of node.exe.
  const node = join(runtime, 'node.exe'); copyFileSync(process.execPath, node);
  const launcher = pinWindowsLauncher(launcherPath!, launcherDigest!);
  assert.equal(spawnSync(launcher.path, ['setup', root, scratch, runtime, state]).status, 0);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const command = (script: string, extra: Partial<ContainedCommand> = {}): ContainedCommand => ({
    executable: node, args: ['-e', script], cwd: root, env: { SystemRoot: process.env.SystemRoot!, LOCALAPPDATA: process.env.LOCALAPPDATA!, TEMP: scratch, TMP: scratch },
    readPaths: [root, runtime], writePaths: [scratch], denyPaths: protectedPaths(root), timeoutMs: 20000, activeProcessLimit: 1, maxOutputBytes: 1 << 20, ...extra });
  return { base, root, scratch, runtime, state, node, launcher, command };
}
const sddl = (path: string) => spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Acl -LiteralPath '${path}').Sddl`], { encoding: 'utf8' }).stdout;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('a contained check reads source and writes scratch, and nothing else', contained, async t => {
  const w = workspace(t), secretDir = join(process.env.USERPROFILE!, `forgemind-secret-${process.pid}`);
  mkdirSync(secretDir); writeFileSync(join(secretDir, 'secret.txt'), 'user-secret'); t.after(() => rmSync(secretDir, { recursive: true, force: true }));
  symlinkSync(secretDir, join(w.scratch, 'escape'), 'junction');
  const targets = { root: w.root, scratch: w.scratch, state: w.state, secret: join(secretDir, 'secret.txt'), escape: join(w.scratch, 'escape', 'secret.txt'),
    public: `C:\\Users\\Public\\forgemind-${process.pid}.txt`, parent: join(w.base, 'parent.txt') };
  const script = `const fs = require('fs'), net = require('net'), dns = require('dns'), cp = require('child_process'), p = ${JSON.stringify(targets)}, out = {};
    const probe = (k, f) => { try { f(); out[k] = 'allowed'; } catch (e) { out[k] = e.code || 'denied'; } };
    probe('readSource', () => fs.readFileSync(p.root + '\\\\value.txt')); probe('readEnv', () => fs.readFileSync(p.root + '\\\\.env'));
    probe('readGit', () => fs.readdirSync(p.root + '\\\\.git')); probe('writeSource', () => fs.writeFileSync(p.root + '\\\\value.txt', 'x'));
    probe('writeStream', () => fs.writeFileSync(p.root + '\\\\value.txt:ads', 'x')); probe('writeScratch', () => fs.writeFileSync(p.scratch + '\\\\ok.txt', 'ok'));
    probe('readSecret', () => fs.readFileSync(p.secret)); probe('readEscape', () => fs.readFileSync(p.escape));
    probe('writePublic', () => fs.writeFileSync(p.public, 'x')); probe('writeParent', () => fs.writeFileSync(p.parent, 'x'));
    probe('forgeReport', () => fs.writeFileSync(p.state + '\\\\forged.report', '{}'));
    probe('spawn', () => { const r = cp.spawnSync(process.execPath, ['-e', '1'], { stdio: 'ignore' }); if (r.error) throw r.error; });
    out.secretEnv = process.env.FORGEMIND_SECRET ? 'present' : 'absent';
    let pending = 2; const done = () => { if (!--pending) console.log(JSON.stringify(out)); };
    const s = net.connect(443, '1.1.1.1'); s.setTimeout(3000); s.on('connect', () => { out.net = 'allowed'; s.destroy(); done(); });
    s.on('error', e => { out.net = e.code; done(); }); s.on('timeout', () => { out.net = 'timeout'; s.destroy(); done(); });
    dns.lookup('example.com', e => { out.dns = e ? e.code : 'allowed'; done(); });`;
  process.env.FORGEMIND_SECRET = 'leak'; t.after(() => { delete process.env.FORGEMIND_SECRET; });
  // A host listener on loopback must see no connection from the container.
  let accepted = 0;
  const server = createServer(socket => { accepted++; socket.destroy(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const loopback = `const l = require('net').connect(${port}, '127.0.0.1'); l.setTimeout(3000);
    const say = v => { console.error('loopback=' + v); l.destroy(); }; l.on('connect', () => say('allowed')); l.on('error', e => say(e.code)); l.on('timeout', () => say('timeout'));`;
  const result = await runContained(w.launcher, w.command(script + loopback), w.state);
  assert.equal(result.status, 'reaped', result.stderr); assert.equal(result.exitCode, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.readSource, 'allowed'); assert.equal(out.writeScratch, 'allowed'); assert.equal(out.secretEnv, 'absent');
  for (const key of ['readEnv', 'readGit', 'writeSource', 'writeStream', 'readSecret', 'readEscape', 'writePublic', 'writeParent', 'forgeReport'])
    assert.equal(out[key], 'EPERM', `${key}: ${out[key]}`);
  assert.notEqual(out.spawn, 'allowed'); assert.notEqual(out.net, 'allowed'); assert.notEqual(out.dns, 'allowed');
  assert.match(result.stderr, /loopback=/); assert.doesNotMatch(result.stderr, /loopback=allowed/); assert.equal(accepted, 0);
  assert.equal(readFileSync(join(w.root, 'value.txt'), 'utf8'), 'source');
  assert.ok(!existsSync(targets.public) && !existsSync(targets.parent) && !existsSync(join(w.state, 'forged.report')));
  assert.deepEqual(readdirSync(w.state), []);
  assert.doesNotMatch(sddl(w.root) + sddl(w.scratch) + sddl(join(w.root, 'value.txt')), /S-1-15-2-/);
});

test('the deadline ends the command and every descendant, including one that outlives its parent', contained, async t => {
  const w = workspace(t), marker = join(w.scratch, 'late.txt');
  const loop = await runContained(w.launcher, w.command('for (;;) {}', { timeoutMs: 1500 }), w.state);
  assert.equal(loop.status, 'deadline');
  const grandchild = `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 4000)`;
  const parent = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore', detached: true }).unref()`;
  const started = Date.now();
  const orphan = await runContained(w.launcher, w.command(parent, { timeoutMs: 2000, activeProcessLimit: 4 }), w.state);
  assert.equal(orphan.status, 'deadline'); assert.ok(Date.now() - started >= 2000, 'the launcher waits for the whole job, not just the first process');
  await wait(4000);
  assert.equal(existsSync(marker), false);
});

test('a killed launcher takes its processes with it and leaves a journal that sweep undoes', contained, async t => {
  const w = workspace(t), marker = join(w.scratch, 'survivor.txt'), id = 'killed';
  const script = `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 3000)`;
  const policy = { ...w.command(script), reportPath: join(w.state, `${id}.report`), journalPath: join(w.state, `${id}.journal`) };
  const launcher = spawn(w.launcher.path, ['run', Buffer.from(JSON.stringify(policy)).toString('base64url')], { stdio: 'ignore' });
  const journal = join(w.state, `${id}.journal`);
  for (let i = 0; i < 400 && !existsSync(journal); i++) await wait(50);
  await wait(1000);
  launcher.kill(); await new Promise(resolve => launcher.on('close', resolve));
  await wait(3500);
  assert.equal(existsSync(marker), false);
  const sid = (JSON.parse(readFileSync(journal, 'utf8')) as { sid: string }).sid;
  assert.match(sddl(w.root), new RegExp(sid));
  assert.equal(await sweepWindowsSandbox(w.launcher, w.state), 0);
  assert.equal(existsSync(journal), false); assert.doesNotMatch(sddl(w.root) + sddl(w.scratch), new RegExp(sid));
});

test('a changed launcher, a reachable state root or a missing grant target is refused before anything runs', contained, async t => {
  const w = workspace(t);
  assert.throws(() => pinWindowsLauncher(w.launcher.path, 'b'.repeat(64)), /digest mismatch/);
  const copy = join(w.base, 'launcher-copy.exe'); copyFileSync(w.launcher.path, copy);
  const tampered: WindowsLauncher = { path: copy, digest: w.launcher.digest };
  writeFileSync(copy, Buffer.concat([readFileSync(copy), Buffer.from([0])]));
  await assert.rejects(runContained(tampered, w.command('1'), w.state), /digest mismatch/);
  await assert.rejects(runContained(w.launcher, w.command('1'), w.scratch), /separate/);
  await assert.rejects(runContained(w.launcher, w.command('1', { readPaths: [w.root, join(w.base, 'missing')] }), w.state));
  assert.deepEqual(readdirSync(w.state), []);
  linkSync(join(w.root, '.env'), join(w.root, 'alias.txt'));
  await assert.rejects(runContained(w.launcher, w.command('1'), w.state), /hardlinked/);
  rmSync(join(w.root, 'alias.txt'));
});

test('a state root that any AppContainer can write is refused, so a child cannot plant its own report', contained, async t => {
  const w = workspace(t), marker = join(w.scratch, 'ran.txt');
  // S-1-15-2-1 is ALL APPLICATION PACKAGES.
  assert.equal(spawnSync('icacls', [w.state, '/grant', '*S-1-15-2-1:(OI)(CI)M']).status, 0);
  const result = await runContained(w.launcher, w.command(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`), w.state);
  assert.notEqual(result.status, 'reaped'); assert.match(result.stderr, /reachable from AppContainers/);
  assert.equal(existsSync(marker), false); assert.deepEqual(readdirSync(w.state), []);
});
