import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWindowsHost } from '../../src/host-enforcement/windows-host.js';
import { runContained } from '../../src/host-enforcement/windows-sandbox.js';
import { createNativeTunnel } from '../../src/live-workflow/native-executor-tunnel.js';
import { CLAUDE_PROXY_HOSTS, openClaudeSubscriptionSession, pinClaudeCli } from '../../src/live-workflow/claude-session.js';

// Needs `npm run windows:setup -- <folder> --claude <claude.exe>` and an elevated shell. The sign-in test also needs
// FORGEMIND_WINDOWS_CLAUDE_PROFILE, a Claude config folder the owner signed in to; it makes no provider request.
const hostFolder = process.env.FORGEMIND_WINDOWS_HOST, profile = process.env.FORGEMIND_WINDOWS_CLAUDE_PROFILE;
const windows = { skip: process.platform !== 'win32' || !hostFolder, timeout: 180000 };

async function fixture(t: test.TestContext) {
  const host = await loadWindowsHost(hostFolder!);
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'fm-win-claude-'))); t.after(() => rmSync(base, { recursive: true, force: true }));
  const work = join(base, 'work'); mkdirSync(work);
  assert.equal(spawnSync(host.launcher.path, ['setup', base, work]).status, 0);
  return { host, base, work };
}

test('the Claude container reaches only the proxy, and the proxy only the allowed hosts', windows, async t => {
  const { host, work } = await fixture(t);
  const refused: string[] = [];
  const tunnel = await createNativeTunnel(0, () => {}, CLAUDE_PROXY_HOSTS, target => refused.push(target));
  const other = createServer(socket => socket.end('reached'));
  await new Promise<void>(resolve => other.listen(0, '127.0.0.1', resolve));
  const otherPort = (other.address() as { port: number }).port;
  t.after(async () => { await tunnel.stop(); await new Promise<void>(resolve => other.close(() => resolve())); });
  const script = `const net = require('net'), out = {}, done = () => { console.log(JSON.stringify(out)); process.exit(0); };
    const probe = (key, connect, write) => new Promise(resolve => { const s = connect(); let data = '';
      s.on('connect', () => write && s.write(write)); s.on('data', d => { data += d; });
      const settle = fallback => { out[key] ??= data ? 'reached: ' + data.split('\\r\\n')[0] : fallback; s.destroy(); resolve(); };
      s.on('error', e => settle(e.code || 'error')); s.on('close', () => settle('closed')); setTimeout(() => settle('timeout'), 8000); });
    (async () => {
      await probe('direct', () => net.connect(443, '1.1.1.1'));
      await probe('allowed', () => net.connect(${tunnel.port}, '127.0.0.1'), 'CONNECT api.anthropic.com:443 HTTP/1.1\\r\\nHost: api.anthropic.com:443\\r\\n\\r\\n');
      await probe('otherHost', () => net.connect(${tunnel.port}, '127.0.0.1'), 'CONNECT example.com:443 HTTP/1.1\\r\\nHost: example.com:443\\r\\n\\r\\n');
      await probe('otherLoopback', () => net.connect(${otherPort}, '127.0.0.1'));
      done();
    })();`;
  const result = await runContained(host.launcher, { executable: host.node.path, args: ['-e', script], cwd: work,
    env: { SystemRoot: process.env.SystemRoot!, LOCALAPPDATA: process.env.LOCALAPPDATA! }, readPaths: [], writePaths: [work], denyPaths: [],
    timeoutMs: 60000, activeProcessLimit: 1, maxOutputBytes: 65536, container: 'forgemind.claude' }, host.stateRoot);
  assert.equal(result.status, 'reaped', result.stderr);
  const out = JSON.parse(result.stdout) as Record<string, string>;
  assert.notEqual(out.direct, 'closed', 'no internet capability, so a direct connection fails');
  assert.ok(!String(out.direct).startsWith('reached'));
  assert.equal(out.allowed, 'reached: HTTP/1.1 200 Connection Established');
  assert.ok(!String(out.otherHost).startsWith('reached'));
  assert.deepEqual(refused, ['CONNECT example.com:443 HTTP/1.1']);
  // Setup's WFP loopback lock: the exemption would reach every 127.0.0.1 listener, the lock only ForgeMind's range.
  assert.ok(!String(out.otherLoopback).startsWith('reached'), `other loopback listener: ${out.otherLoopback}`);
});

test('two runs on the same fixed container take turns and both finish cleanly', windows, async t => {
  const { host, base, work } = await fixture(t);
  const run = (marker: string) => runContained(host.launcher, { executable: host.node.path,
    args: ['-e', `require('fs').writeFileSync(${JSON.stringify(join(work, marker))}, String(Date.now())); setTimeout(() => {}, 3000)`], cwd: work,
    env: { SystemRoot: process.env.SystemRoot!, LOCALAPPDATA: process.env.LOCALAPPDATA! }, readPaths: [], writePaths: [work], denyPaths: [],
    timeoutMs: 20000, activeProcessLimit: 1, maxOutputBytes: 65536, container: 'forgemind.claude' }, host.stateRoot);
  const [first, second] = await Promise.all([run('a'), run('b')]);
  assert.equal(first.status, 'reaped', first.message); assert.equal(second.status, 'reaped', second.message);
  const starts = ['a', 'b'].map(name => Number(readFileSync(join(work, name), 'utf8'))).sort();
  assert.ok(starts[1]! - starts[0]! >= 2900, 'the second run started only after the first had finished');
  assert.deepEqual(readdirSync(host.stateRoot), [], 'no journal or report left');
  void base;
});

test('the contained Claude CLI reports the owner sign-in without network', { ...windows, skip: windows.skip || !profile }, async t => {
  const { host, base } = await fixture(t);
  assert.ok(host.claude, 'setup was run with --claude');
  const session = await openClaudeSubscriptionSession({ profileDirectory: profile!, cli: pinClaudeCli(host.claude.path), scratchRoot: base, separateFrom: [base] });
  try { assert.match(session.subscriptionType, /^[A-Za-z0-9_-]+$/); } finally { session.close(); }
});
