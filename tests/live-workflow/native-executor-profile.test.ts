import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { runtimeFiles } from '../../src/live-workflow/process.js';
import { nativeInferenceProfile } from '../../src/live-workflow/native-executor-profile.js';
test('actual macOS Seatbelt denies project reads/writes and fork', { skip: process.platform !== 'darwin' }, () => {
  const root = realpathSync(mkdtempSync(tmpdir() + '/fm-native-profile-'));
  const home = root + '/home', tmp = root + '/tmp'; mkdirSync(home, { mode: 0o700 }); mkdirSync(tmp, { mode: 0o700 });
  const forbidden = root + '/project'; writeFileSync(forbidden, 'project-secret');
  try {
    const cat = realpathSync('/bin/cat'), profile = nativeInferenceProfile(cat, home, tmp, 12345, []);
    for (const permission of ['com.apple.cfprefsd.agent', 'com.apple.cfprefsd.daemon',
      `apple.cfprefs.${process.getuid!()}v1`, 'apple.cfprefs.daemonv1', 'preference-domain "com.openai.codex"',
      '/private/etc/codex/requirements.toml', '/private/etc/codex/managed_config.toml', '/private/etc/codex/config.toml'])
      assert.ok(profile.includes(permission));
    const denied = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, cat, forbidden], { encoding: 'utf8' });
    assert.notEqual(denied.status, 0); assert.equal(denied.stdout, '');
    writeFileSync(home + '/allowed', 'private');
    assert.equal(execFileSync('/usr/bin/sandbox-exec', ['-p', profile, cat, home + '/allowed'], { encoding: 'utf8' }), 'private');
    const sh = realpathSync('/bin/sh'), shellProfile = nativeInferenceProfile(sh, home, tmp, 12345, []);
    const write = spawnSync('/usr/bin/sandbox-exec', ['-p', shellProfile, sh, '-c', 'echo denied > "$1"', 'probe', forbidden], { encoding: 'utf8' });
    assert.notEqual(write.status, 0);
    const fork = spawnSync('/usr/bin/sandbox-exec', ['-p', shellProfile, sh, '-c', '(echo child) & wait'], { encoding: 'utf8' });
    assert.notEqual(fork.status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('actual Seatbelt permits only designated loopback port and forbids spawning descendants',
  { skip: process.platform !== 'darwin', timeout: 10000 }, async () => {
  const root = realpathSync(mkdtempSync(tmpdir() + '/fm-native-network-'));
  const home = root + '/home', tmp = root + '/tmp'; mkdirSync(home, { mode: 0o700 }); mkdirSync(tmp, { mode: 0o700 });
  const server = createServer(socket => socket.end('fixture'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const node = realpathSync(process.execPath);
  const profile = nativeInferenceProfile(node, home, tmp, address.port, runtimeFiles(node));
  const run = (script: string) => new Promise<{ code: number | null; stdout: string }>(resolve => {
    const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, node, '-e', script], { cwd: home, env: { HOME: home, TMPDIR: tmp, OPENSSL_CONF: '/dev/null' } });
    let stdout = ''; child.stdout.on('data', b => { stdout += b.toString(); }); child.stderr.resume();
    child.once('close', code => resolve({ code, stdout }));
  });
  try {
    const allowed = await run(`const n=require('node:net'); const s=n.connect(${address.port},'127.0.0.1');s.on('data',b=>process.stdout.write(b));s.on('error',()=>process.exit(3));`);
    assert.deepEqual(allowed, { code: 0, stdout: 'fixture' });
    const denied = await run(`try { const s=require('node:net').connect(443,'1.1.1.1');s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(3));setTimeout(()=>process.exit(4),1000); } catch { process.exit(3); }`);
    assert.equal(denied.code, 3);
    const wrongPort = await run(`try { const s=require('node:net').connect(${address.port === 65535 ? 65534 : address.port + 1},'127.0.0.1');s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(3)); } catch { process.exit(3); }`);
    assert.equal(wrongPort.code, 3);
    const child = await run(`try { const c=require('node:child_process').spawn(${JSON.stringify(node)},['-e','']);c.on('error',()=>process.exit(3));c.on('spawn',()=>process.exit(0)); } catch { process.exit(3); }`);
    assert.equal(child.code, 3);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
});
