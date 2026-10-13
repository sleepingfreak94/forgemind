import { Transform } from 'node:stream';
import type { Readable, Writable } from 'node:stream';
import { JsonlRpc } from '../agent-drivers/jsonl-rpc.js';
import type { ActionAuthority } from './contracts.js';
import type { RpcNotification, RpcReply, RpcRequest } from '../agent-drivers/jsonl-rpc.js';
export interface NativeRpc {
  request(method: string, params: unknown, onResult?: (value: unknown) => void): Promise<unknown>;
  notify(method: string, params: unknown): Promise<void>;
  onRequest(handler: (request: RpcRequest) => Promise<RpcReply>): void;
  onNotification(listener: (event: RpcNotification) => void): () => void;
  onFailure(listener: (error: Error) => void): () => void;
  onWire(listener: (bytes: number) => void): () => void;
  close(): void;
}
const trusted = new WeakSet<object>();
/** Offline test seam. This port NEVER qualifies for live inference. */
export class FixtureNativeHost {
  readonly qualification = 'offline-fixture' as const;
  constructor(readonly rpc: NativeRpc, readonly authority: ActionAuthority,
    readonly boundary: () => void, readonly stop: () => Promise<void>,
    readonly source: () => string, readonly check: (id: string, signal: AbortSignal) => Promise<unknown>) {
    trusted.add(this);
  }
}
export function assertNativeHost(host: FixtureNativeHost): void {
  if (!trusted.has(host)) throw new Error('Trusted host port required; serialized configuration cannot qualify a host');
}

/** Counts both raw stdio directions before transport acceptance. Owner supplied streams only. */
export function fixtureStdioRpc(input: Readable, output: Writable): NativeRpc {
  const listeners = new Set<(bytes: number) => void>();
  const meter = () => new Transform({ transform(chunk: Buffer, _encoding, callback) {
    try { listeners.forEach(f => f(chunk.byteLength)); callback(null, chunk); }
    catch (e) { callback(e as Error); }
  } });
  const incoming = meter(), outgoing = meter();
  input.on('error',()=>incoming.destroy(new Error('Native input disconnected')));
  output.on('error',()=>incoming.destroy(new Error('Native output disconnected')));
  input.pipe(incoming); outgoing.pipe(output);
  const rpc = new JsonlRpc(incoming, outgoing, { timeoutMs: 1000, maxLineBytes: 1048576, maxTotalBytes: 32 * 1024 * 1024 });
  return {
    request: (method, params, onResult) => rpc.request(method, params, onResult), notify: (method, params) => rpc.notify(method, params),
    onRequest: handler => rpc.onRequest(handler), onNotification: handler => rpc.onNotification(handler), onFailure: handler => rpc.onFailure(handler),
    onWire: handler => { listeners.add(handler); return () => { listeners.delete(handler); }; },
    close: () => { rpc.close(); input.unpipe(incoming); outgoing.unpipe(output); incoming.destroy(); outgoing.destroy(); },
  };
}
