import type { Server } from 'node:net';
import { WINDOWS_LOOPBACK_PORTS } from '../host-enforcement/windows-host.js';

/** Binds `server` to 127.0.0.1. On Windows the provider containers can reach only WINDOWS_LOOPBACK_PORTS (setup's
 * loopback lock, ADR-0017), so port 0 takes the first free port in that range; elsewhere the OS picks one. */
export async function listenLoopback(server: Server, port = 0): Promise<void> {
  const { first, last } = WINDOWS_LOOPBACK_PORTS;
  if (process.platform === 'win32' && port !== 0 && (port < first || port > last)) throw new Error('Windows loopback ports must be inside the sandbox loopback range');
  const ports = port === 0 && process.platform === 'win32' ? Array.from({ length: last - first + 1 }, (_, i) => first + i) : [port];
  for (const [index, candidate] of ports.entries()) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(candidate, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
      });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || index === ports.length - 1) throw error;
    }
  }
}
