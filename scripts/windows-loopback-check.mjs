// Setup self-test for the Windows loopback lock (ADR-0017 phase 2b): a contained probe in each provider container must
// reach a listener inside WINDOWS_LOOPBACK_PORTS and be refused by one outside it, through 127.0.0.1, ::1 and every
// address of the host's own interfaces (Windows treats those as loopback too). Returns a problem, or undefined.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { hashFile } from '../dist/src/host-enforcement/manifest.js';
import { pinWindowsLauncher, runContained } from '../dist/src/host-enforcement/windows-sandbox.js';
import { listenLoopback } from '../dist/src/live-workflow/loopback.js';
import { WINDOWS_LOOPBACK_PORTS } from '../dist/src/host-enforcement/windows-host.js';

export async function checkLoopbackLock({ launcher, node, stateRoot, folder, container }) {
  const pinned = pinWindowsLauncher(launcher, hashFile(launcher));
  const work = mkdtempSync(join(folder, 'loopback-check-'));
  const inside = createServer(socket => socket.end('reached')), outside = createServer(socket => socket.end('reached'));
  try {
    execFileSync(launcher, ['setup', work, work], { windowsHide: true });
    await listenLoopback(inside);
    await new Promise((resolve, reject) => { outside.once('error', reject); outside.listen(0, '::', resolve); });
    const [allowed, other] = [inside, outside].map(server => server.address().port);
    if (other >= WINDOWS_LOOPBACK_PORTS.first && other <= WINDOWS_LOOPBACK_PORTS.last) return 'the OS picked an outside port inside the range; run setup again';
    const own = Object.values(networkInterfaces()).flat().filter(a => !a.internal).map(a => a.address + (a.scopeid ? `%${a.scopeid}` : ''));
    const targets = ['127.0.0.1', '::1', ...own];
    const script = `const net = require('net'), out = {};
      const probe = (key, port, host = '127.0.0.1') => new Promise(resolve => { const s = net.connect({ port, host }); let data = '';
        const settle = value => { out[key] ??= data || value; s.destroy(); resolve(); };
        s.on('data', d => { data += d; }); s.on('error', e => settle(e.code || 'error')); s.on('close', () => settle('closed')); setTimeout(() => settle('timeout'), 5000); });
      (async () => { await probe('allowed', ${allowed});
        for (const host of ${JSON.stringify(targets)}) await probe('other ' + host, ${other}, host);
        console.log(JSON.stringify(out)); process.exit(0); })();`;
    const result = await runContained(pinned, { executable: node, args: ['-e', script], cwd: work,
      env: { SystemRoot: process.env.SystemRoot, LOCALAPPDATA: process.env.LOCALAPPDATA }, readPaths: [], writePaths: [work], denyPaths: [],
      timeoutMs: 120000, activeProcessLimit: 1, maxOutputBytes: 4096, container }, stateRoot);
    if (result.status !== 'reaped') return `probe did not finish (${result.status}: ${result.message})`;
    const out = JSON.parse(result.stdout);
    if (out.allowed !== 'reached') return `the proxy range is unreachable (${out.allowed})`;
    const reached = targets.filter(host => out[`other ${host}`] === 'reached');
    if (reached.length) return `a port outside the range is reachable through ${reached.join(', ')}`;
    return undefined;
  } finally {
    inside.close(); outside.close();
    rmSync(work, { recursive: true, force: true });
  }
}
