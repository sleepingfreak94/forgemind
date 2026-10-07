import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, symlinkSync, linkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { createSocket } from 'node:dgram';
import { join } from 'node:path';

const denied = (operation: () => unknown) => { try { operation(); return false; } catch { return true; } };
const tcp = (options: { host: string; port: number } | { path: string }) => new Promise<boolean>(resolve => {
  const socket = createConnection(options); const timeout = setTimeout(() => { socket.destroy(); resolve(false); }, 500);
  socket.on('connect', () => { clearTimeout(timeout); socket.destroy(); resolve(false); });
  socket.on('error', () => { clearTimeout(timeout); socket.destroy(); resolve(true); });
});
createInterface({ input: process.stdin }).on('line', async line => {
  const request = JSON.parse(line) as { id: number; method: string; params: { port?: number; socket?: string } };
  let result: unknown;
  if (request.method === 'inspect') {
    const udp = await new Promise<boolean>(resolve => {
      const socket = createSocket('udp4'); socket.on('error', () => { socket.close(); resolve(true); });
      socket.send('test', request.params.port!, '127.0.0.1', error => { socket.close(); resolve(!!error); });
    });
    const child = spawnSync(process.execPath, ['--version']);
    result = { allowedRead: readFileSync('allowed.txt', 'utf8'),
      projectWriteDenied: denied(() => writeFileSync('allowed.txt', 'changed')),
      secretReadDenied: denied(() => readFileSync(process.argv[2]!, 'utf8')),
      scratchWriteAllowed: !denied(() => writeFileSync(join(process.env.TMPDIR!, 'scratch.txt'), 'okay')),
      symlinkEscapeDenied: denied(() => { const path = join(process.env.TMPDIR!, 'escape'); symlinkSync(process.argv[2]!, path); readFileSync(path); }),
      hardlinkEscapeDenied: denied(() => { const path = join(process.env.TMPDIR!, 'hardlink'); linkSync(process.argv[2]!, path); readFileSync(path); }),
      forkDenied: !!child.error, tcpDenied: await tcp({ host: '127.0.0.1', port: request.params.port! }),
      unixDenied: await tcp({ path: request.params.socket! }), udpDenied: udp,
      credentialEnvironmentAbsent: Object.keys(process.env).sort().join(',') === 'CODEX_HOME,HOME,LANG,LC_ALL,OPENSSL_CONF,TMPDIR',
      homePrivate: process.env.CODEX_HOME === `${process.env.HOME}/codex` && process.env.TMPDIR === `${process.env.HOME}/tmp` &&
        process.env.HOME!.startsWith(join(process.argv[2]!, '..', 'scratch', 'attempt-')),
    };
  } else if (request.method === 'flood') { process.stdout.write('x'.repeat(100000)); return; }
  else if (request.method === 'hold') return;
  else result = { ready: true };
  process.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
});
