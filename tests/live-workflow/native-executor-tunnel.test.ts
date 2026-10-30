import test from 'node:test';
import assert from 'node:assert/strict';
import net, { connect, createServer } from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { createNativeTunnel } from '../../src/live-workflow/native-executor-tunnel.js';
const rejected = async (port: number, frame: string) => {
  const s = connect(port, '127.0.0.1');
  let response = ''; s.on('data', chunk => { response += chunk.toString(); }); s.on('error', () => {});
  await new Promise<void>(resolve => { s.once('close', () => resolve()); s.once('connect', () => s.write(frame)); });
  assert.equal(response, '');
};
test('CONNECT tunnel denies alternate hosts, HTTP, credentials and oversized input offline', async () => {
  const tunnel = await createNativeTunnel(0, () => {});
  try {
    for (const frame of ['GET https://api.openai.com/v1 HTTP/1.1\r\nHost: api.openai.com\r\n\r\n',
      'CONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example:443\r\n\r\n',
      'CONNECT api.openai.com:443 HTTP/1.1\r\nHost: api.openai.com:443\r\nProxy-Authorization: secret\r\n\r\n',
      'x'.repeat(8193)]) await rejected(tunnel.port, frame);
  } finally { await tunnel.stop(); }
});
test('CONNECT relay is byte transparent and targets only api.openai.com:443 (offline dial fixture)', async () => {
  const echo = createServer(socket => socket.pipe(socket));
  await new Promise<void>(resolve => echo.listen(0, '127.0.0.1', resolve));
  const address = echo.address(); assert.ok(address && typeof address !== 'string');
  const original = net.connect;
  let dials = 0;
  const mock = test.mock.method(net, 'connect', (...args: unknown[]) => {
    if (typeof args[0] === 'object') {
      assert.deepEqual(args[0], { host: 'api.openai.com', port: 443 }); dials++;
      return original(address.port, '127.0.0.1');
    }
    return original(args[0] as number, args[1] as string);
  });
  syncBuiltinESMExports();
  const tunnel = await createNativeTunnel(0, () => {});
  try {
    const client = connect(tunnel.port, '127.0.0.1'); client.on('error', () => {});
    const payload = Buffer.from([0x16, 3, 3, 0, 7, 0, 255, 128, 64, 32, 1, 0]);
    const received = await new Promise<Buffer>((resolve, reject) => {
      let bytes = Buffer.alloc(0);
      const timer = setTimeout(() => reject(new Error('Relay timeout')), 2000);
      client.on('data', (chunk: Buffer) => {
        bytes = Buffer.concat([bytes, chunk]);
        const end = bytes.indexOf('\r\n\r\n');
        if (end >= 0 && bytes.length >= end + 4 + payload.length) {
          assert.equal(bytes.subarray(0, end).toString(), 'HTTP/1.1 200 Connection Established');
          clearTimeout(timer); resolve(bytes.subarray(end + 4));
        }
      });
      client.once('connect', () => client.write(Buffer.concat([
        Buffer.from('CONNECT api.openai.com:443 HTTP/1.1\r\nHost: api.openai.com:443\r\n\r\n'), payload])));
    });
    assert.deepEqual(received, payload); assert.equal(dials, 1); client.destroy();
  } finally {
    await tunnel.stop(); mock.mock.restore(); syncBuiltinESMExports();
    await new Promise<void>(resolve => echo.close(() => resolve()));
  }
});
test('revocation closes all idle tunnels and idempotent stop closes listener', async () => {
  let revoked = false;
  const tunnel = await createNativeTunnel(0, () => { if (revoked) throw new Error('revoked'); });
  const s = connect(tunnel.port, '127.0.0.1'); s.on('error', () => {});
  await new Promise<void>(resolve => s.once('connect', () => resolve()));
  const closed = new Promise<void>(resolve => s.once('close', () => resolve()));
  revoked = true; await closed; await tunnel.stop(); await tunnel.stop();
  assert.equal(s.destroyed, true);
});
test('CONNECT tunnel takes an exact host allow-list and reports refused targets', async () => {
  await assert.rejects(createNativeTunnel(0, () => {}, []), /Invalid tunnel hosts/);
  await assert.rejects(createNativeTunnel(0, () => {}, ['*.anthropic.com']), /Invalid tunnel hosts/);
  const refused: string[] = [];
  const tunnel = await createNativeTunnel(0, () => {}, ['api.anthropic.com'], target => refused.push(target));
  try {
    for (const frame of ['CONNECT api.openai.com:443 HTTP/1.1\r\nHost: api.openai.com:443\r\n\r\n',
      'CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: evil.example:443\r\n\r\n',
      'CONNECT api.anthropic.com:80 HTTP/1.1\r\nHost: api.anthropic.com:80\r\n\r\n',
      'CONNECT api.\u0007openai.com:443 HTTP/1.1\r\nHost: x:443\r\n\r\n']) await rejected(tunnel.port, frame);
    // The mismatched Host header is reported too; the CONNECT line itself was allowed.
    assert.deepEqual(refused, ['CONNECT api.openai.com:443 HTTP/1.1', 'CONNECT api.anthropic.com:443 HTTP/1.1', 'CONNECT api.anthropic.com:80 HTTP/1.1', 'CONNECT api.?openai.com:443 HTTP/1.1']);
  } finally { await tunnel.stop(); }
});
