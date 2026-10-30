import { createServer, connect } from 'node:net';
import type { Socket, Server } from 'node:net';
import { Transform } from 'node:stream';
export interface NativeTunnel { readonly port: number; stop(): Promise<void> }
/** HTTPS CONNECT byte relay to an exact host allow-list on port 443. Never terminates TLS, parses Responses, or handles
 * tokens. `onRefused` hears each refused target, so a run can record what a CLI tried to reach. */
export async function createNativeTunnel(port: number, checkActive: () => void, hosts: readonly string[] = ['api.openai.com'],
  onRefused?: (target: string) => void): Promise<NativeTunnel> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid tunnel port');
  if (!hosts.length || hosts.some(host => !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host))) throw new Error('Invalid tunnel hosts');
  checkActive();
  const sockets = new Set<Socket>();
  let closed = false;
  const track = (s: Socket) => { sockets.add(s); s.on('error', () => s.destroy()); s.once('close', () => sockets.delete(s)); };
  const guard = () => { if (closed) throw new Error('Tunnel stopped'); checkActive(); };
  const server: Server = createServer({ allowHalfOpen: false }, client => {
    if (closed || sockets.size >= 16) { client.destroy(); return; }
    track(client); client.setTimeout(10000, () => client.destroy());
    let header = Buffer.alloc(0), upstream: Socket | undefined, accepted = false;
    const fail = () => { client.destroy(); upstream?.destroy(); };
    client.once('close', () => upstream?.destroy());
    const receive = (chunk: Buffer) => {
      try { guard(); } catch { fail(); return; }
      if (accepted) return;
      if (header.length + chunk.length > 8192) { fail(); return; }
      header = Buffer.concat([header, chunk]);
      const end = header.indexOf('\r\n\r\n');
      if (end < 0) return;
      const text = header.subarray(0, end).toString('ascii'), lines = text.split('\r\n');
      const host = /^CONNECT ([a-z0-9.-]+):443 HTTP\/1\.1$/.exec(lines[0] ?? '')?.[1];
      const refuse = () => { onRefused?.((lines[0] ?? '').replace(/[^\x20-\x7e]/g, '?').slice(0, 200)); fail(); };
      if (!host || !hosts.includes(host)) { refuse(); return; }
      if (
          !lines.slice(1).every(line => /^[A-Za-z0-9-]+: [\x20-\x7e]*$/.test(line)) ||
          lines.slice(1).some(line => /^(Content-Length|Transfer-Encoding|Proxy-Authorization):/i.test(line)) ||
          lines.filter(line => /^Host:/i.test(line)).length !== 1 ||
          !lines.includes(`Host: ${host}:443`)) { refuse(); return; }
      accepted = true; client.removeListener('data', receive); client.pause();
      upstream = connect({ host, port: 443 }); track(upstream);
      upstream.setTimeout(10000, fail); upstream.once('close', () => client.destroy());
      upstream.once('connect', () => {
        try { guard(); } catch { fail(); return; }
        client.setTimeout(0); upstream!.setTimeout(0);
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        // Only the already bounded prefix is held in memory; pipe backpressure bounds the relay.
        const prefix = header.subarray(end + 4); header = Buffer.alloc(0);
        if (prefix.length) upstream!.write(prefix);
        const forward = () => new Transform({ transform(chunk: Buffer, _encoding, callback) {
          try { guard(); callback(null, chunk); } catch (error) { fail(); callback(error as Error); }
        } });
        const outbound = forward(), inbound = forward();
        outbound.on('error', fail); inbound.on('error', fail);
        client.once('close', () => { outbound.destroy(); inbound.destroy(); });
        client.pipe(outbound).pipe(upstream!); upstream!.pipe(inbound).pipe(client); client.resume();
      });
    };
    client.on('data', receive);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing tunnel address');
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= new Promise<void>(resolve => {
    closed = true; clearInterval(poll); for (const socket of sockets) socket.destroy(); server.close(() => resolve());
  });
  const poll = setInterval(() => { try { guard(); } catch { void stop(); } }, 25);
  server.on('error', () => { void stop(); });
  return Object.freeze({ port: address.port, stop });
}
