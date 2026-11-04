import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPrivate, isTrusted } from '../../src/host-enforcement/owner-acl.js';
import { launcherSourceDigest, loadWindowsHost } from '../../src/host-enforcement/windows-host.js';
import { RunAuthority } from '../../src/live-workflow/authority.js';
import { runChecks, windowsCheckPolicy } from '../../src/live-workflow/checks.js';
import type { ActionAuthority, LiveTask } from '../../src/live-workflow/contracts.js';

test('the Windows check policy reads the tree, writes scratch and never grants protected paths', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fm-win-policy-'))); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.git')); writeFileSync(join(root, '.env'), 'x'); writeFileSync(join(root, 'a.ts'), 'x');
  assert.deepEqual(windowsCheckPolicy(root, '/scratch'),
    { readPaths: [root], writePaths: ['/scratch'], denyPaths: [join(root, '.env'), join(root, '.git')], activeProcessLimit: 1 });
});

test('the launcher source digest covers every .cs file and its name', t => {
  const dir = mkdtempSync(join(tmpdir(), 'fm-win-source-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'a.cs'), 'one'); writeFileSync(join(dir, 'notes.txt'), 'ignored');
  const first = launcherSourceDigest(dir);
  writeFileSync(join(dir, 'notes.txt'), 'changed'); assert.equal(launcherSourceDigest(dir), first);
  writeFileSync(join(dir, 'b.cs'), ''); assert.notEqual(launcherSourceDigest(dir), first);
  rmSync(join(dir, 'b.cs')); writeFileSync(join(dir, 'a.cs'), 'two'); assert.notEqual(launcherSourceDigest(dir), first);
});

test('the Windows host loads only on Windows', { skip: process.platform === 'win32' }, async () => {
  await assert.rejects(loadWindowsHost(tmpdir()), /requires Windows/);
});

// Needs `npm run windows:setup -- <folder>` and an elevated shell, because each test grants read-attributes on its
// temporary folder's ancestors.
const hostFolder = process.env.FORGEMIND_WINDOWS_HOST;
const windows = { skip: process.platform !== 'win32' || !hostFolder, timeout: 180000 };
const task: LiveTask = { schemaVersion: 1, taskId: 'windows-fixture', objective: 'Fixture', readPaths: ['a'], writePaths: ['a'], checks: [],
  model: 'fixture', effort: 'low', maxModelRequests: 1, maxPromptBytes: 100, maxOutputBytes: 100, maxRuntimeMs: 120000, draftPr: false };

async function fixture(t: test.TestContext) {
  const host = await loadWindowsHost(hostFolder!);
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'fm-win-checks-'))); t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, 'repo'), runs = join(base, 'runs');
  mkdirSync(join(repo, '.git'), { recursive: true }); mkdirSync(runs);
  writeFileSync(join(repo, 'value.txt'), 'original'); writeFileSync(join(repo, '.env'), 'fixture-secret'); writeFileSync(join(repo, '.git', 'config'), 'x');
  assert.equal(spawnSync(host.launcher.path, ['setup', repo, runs]).status, 0);
  return { host, base, repo, runs };
}

test('Windows ownership checks accept owner-only state and refuse anything others can reach or change', windows, async t => {
  const { host, base } = await fixture(t);
  assert.equal(isPrivate(host.folder, lstatSync(host.folder)), true);
  assert.equal(isTrusted(host.node.path, lstatSync(host.node.path)), true);
  const shared = join(base, 'shared'), writable = join(base, 'writable.exe');
  mkdirSync(shared); copyFileSync(host.node.path, writable);
  assert.equal(isPrivate(shared, lstatSync(shared)), true);
  execFileSync('icacls.exe', [shared, '/grant', '*S-1-5-32-545:R']);
  assert.equal(isPrivate(shared, lstatSync(shared)), false, 'Users can read it');
  const inheriting = join(base, 'inheriting'); mkdirSync(inheriting);
  execFileSync('icacls.exe', [inheriting, '/grant', '*S-1-5-32-545:(OI)(CI)(IO)F']);
  assert.equal(isPrivate(inheriting, lstatSync(inheriting)), false, 'files created in it would be shared with Users');
  assert.equal(isTrusted(writable, lstatSync(writable)), true);
  execFileSync('icacls.exe', [writable, '/grant', '*S-1-5-32-545:M']);
  assert.equal(isTrusted(writable, lstatSync(writable)), false, 'Users can change it');
});

test('a Windows check runs contained under a real run authority', windows, async t => {
  const { host, repo, runs } = await fixture(t);
  const authority = new RunAuthority(join(runs, 'state'), repo, 'fixture/windows', task, 'a'.repeat(64));
  // Spawn with stdio 'ignore': a spawn with pipes hangs in an AppContainer instead of failing (ADR-0017).
  const code = `const fs=require('fs'),assert=require('assert/strict');assert.equal(process.env.FORGEMIND_SECRET,undefined);
    assert.equal(fs.readFileSync('value.txt','utf8'),'original');assert.throws(()=>fs.readFileSync('.env'));assert.throws(()=>fs.readdirSync('.git'));
    assert.throws(()=>fs.writeFileSync('value.txt','bad'));fs.writeFileSync(process.env.TEMP+'\\\\allowed','ok');fs.writeFileSync(process.env.HOME+'\\\\allowed','ok');
    assert.ok(require('child_process').spawnSync(process.execPath,['-e','0'],{stdio:'ignore'}).error);`;
  process.env.FORGEMIND_SECRET = 'fixture';
  try {
    const [result] = await runChecks(repo, 'a'.repeat(64), [{ id: 'contained', executable: host.node.path, args: ['-e', code], timeoutMs: 30000 }],
      runs, authority, AbortSignal.timeout(120000));
    assert.equal(result?.passed, true, result?.stderr ?? 'no check result');
    assert.equal(readFileSync(join(repo, 'value.txt'), 'utf8'), 'original');
  } finally { delete process.env.FORGEMIND_SECRET; authority.close(); } // closed before the fixture folder is removed
});

test('Windows checks refuse other executables and node-project, and a deadline rejects', windows, async t => {
  const { host, repo, runs } = await fixture(t);
  const statuses: string[] = [];
  const authority: ActionAuthority = { reserve: () => ({ check: () => {}, finish: status => { statuses.push(status); } }) };
  await assert.rejects(runChecks(repo, 'a'.repeat(64), [{ id: 'foreign', executable: process.execPath, args: ['-e', '0'], timeoutMs: 5000 }],
    runs, authority, AbortSignal.timeout(60000)), /node.exe that windows:setup pinned/);
  await assert.rejects(runChecks(repo, 'a'.repeat(64), [{ id: 'np', executable: host.node.path, args: [], timeoutMs: 5000, profile: 'node-project' }],
    runs, authority, AbortSignal.timeout(60000)), /not supported on Windows/);
  await assert.rejects(runChecks(repo, 'a'.repeat(64), [{ id: 'loop', executable: host.node.path, args: ['-e', 'setInterval(()=>{},100)'], timeoutMs: 2000 }],
    runs, authority, AbortSignal.timeout(60000)), /deadline/);
  assert.deepEqual(statuses, ['indeterminate']);
  const cancel = new AbortController(); setTimeout(() => cancel.abort(), 8000);
  await assert.rejects(runChecks(repo, 'a'.repeat(64), [{ id: 'cancel', executable: host.node.path, args: ['-e', 'setInterval(()=>{},100)'], timeoutMs: 60000 }],
    runs, authority, cancel.signal), /cancelled/);
  assert.deepEqual(readdirSync(host.stateRoot), [], 'cancelling swept the grants and left no journal or report');
});
