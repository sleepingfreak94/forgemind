import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rpcFixture } from './fixture.js';

test('ACP requires JSON-RPC 2.0 on input and stamps requests, notifications and callback replies', async () => {
  const f = rpcFixture({ strictJsonrpc: true });
  const pending = f.rpc.request('initialize', {});
  f.receive({ jsonrpc: '2.0', id: 1, result: {} }); await pending;
  await f.rpc.notify('session/cancel', {});
  f.rpc.onRequest(async () => ({ result: { denied: true } }));
  f.receive({ jsonrpc: '2.0', id: 'callback', method: 'permission', params: {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sent.length, 3); assert.ok(f.sent.every(message => message.jsonrpc === '2.0')); f.close();
  for (const jsonrpc of [undefined, '1.0']) {
    const invalid = rpcFixture({ strictJsonrpc: true }), waiting = invalid.rpc.request('initialize', {});
    invalid.receive({ jsonrpc, id: 1, result: {} }); await assert.rejects(waiting, /protocol-error/); invalid.close();
  }
});

test('response boundary hook runs before later frames in the same chunk and failures close pending work', async () => {
  const f = rpcFixture({ strictJsonrpc: true }); let terminal = false, seen = false;
  f.rpc.onNotification(() => { seen = terminal; });
  const pending = f.rpc.request('prompt', {}, () => { terminal = true; });
  f.incoming.write('{"jsonrpc":"2.0","id":1,"result":{}}\n{"jsonrpc":"2.0","method":"late"}\n');
  await pending; assert.equal(seen, true); f.close();
  const invalid = rpcFixture(), failed = invalid.rpc.request('one', {}, () => { throw new Error('invalid configuration'); });
  const sibling = invalid.rpc.request('two', {});
  invalid.receive({ id: 1, result: {} });
  await assert.rejects(failed, /invalid configuration/); await assert.rejects(sibling, /protocol-error/); invalid.close();
});

test('JSONL handles split UTF-8 and multiple messages with exact response correlation', async () => {
  const f = rpcFixture(); const first = f.rpc.request('one', {}), second = f.rpc.request('two', {});
  const encoded = Buffer.from(JSON.stringify({ id: 2, result: 'café' }) + '\n' + JSON.stringify({ id: 1, result: 'first' }) + '\n');
  const split = encoded.indexOf(Buffer.from('é')) + 1;
  f.incoming.write(encoded.subarray(0, split)); f.incoming.write(encoded.subarray(split));
  assert.deepEqual(await Promise.all([first, second]), ['first', 'café']); f.close();
});

test('malformed JSON, unknown/duplicate IDs and ambiguous response frames fail closed', async () => {
  for (const bad of ['{invalid\n', '{"id":99,"result":{}}\n', '{"id":1,"result":{},"error":{}}\n', '[]\n']) {
    const f = rpcFixture(); const pending = f.rpc.request('test', {}); f.incoming.write(bad);
    await assert.rejects(pending, /protocol-error/); f.close();
  }
  const f = rpcFixture(); const first = f.rpc.request('test', {}); f.receive({ id: 1, result: {} }); await first;
  const next = f.rpc.request('next', {}); f.receive({ id: 1, result: {} }); await assert.rejects(next, /protocol-error/); f.close();
});

test('partial-line size and aggregate output limits reject pending work', async () => {
  for (const total of [false, true]) {
    const f = rpcFixture({ timeoutMs: 50, maxLineBytes: 128, maxTotalBytes: total ? 130 : 1024 });
    const pending = f.rpc.request('test', {});
    f.incoming.write(total ? '{"method":"ignored"}\n'.repeat(8) : 'x'.repeat(129));
    await assert.rejects(pending, /output-limit/); f.close();
  }
});

test('EOF, RPC error and timeout are distinct sanitized failures', async () => {
  for (const kind of ['eof', 'error', 'timeout']) {
    const f = rpcFixture(); const pending = f.rpc.request('test', {});
    if (kind === 'eof') f.incoming.end();
    if (kind === 'error') f.receive({ id: 1, error: { code: 123, message: 'secret provider details' } });
    await assert.rejects(pending, kind === 'eof' ? /disconnected/ : kind === 'error' ? /rpc-error/ : /timed-out/); f.close();
  }
});
