import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { DriverError } from './contracts.js';
import { bytes, positive, string } from '../context-engine/validation.js';

export type RpcId = string | number;
export interface RpcNotification { method: string; params: unknown }
export interface RpcRequest extends RpcNotification { id: RpcId }
export type RpcReply = { result: unknown } | { error: { code: number; message: string } };
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; onResult?: (value: unknown) => void };
const id = (value: unknown): value is RpcId => typeof value === 'string' ? value.length > 0 && value.length <= 128 : Number.isSafeInteger(value) && (value as number) >= 0;

/** Bounded JSONL transport over host-owned stdio. It never starts a process itself. */
export class JsonlRpc {
  readonly #input: Readable;
  readonly #output: Writable;
  readonly #options: { timeoutMs: number; maxLineBytes: number; maxTotalBytes: number; strictJsonrpc?: boolean };
  readonly #pending = new Map<RpcId, Pending>();
  readonly #notifications = new Set<(event: RpcNotification) => void>();
  readonly #failures = new Set<(error: DriverError) => void>();
  #requests?: (request: RpcRequest) => Promise<RpcReply>;
  #replied?: (request: RpcRequest) => void;
  #decoder = new StringDecoder('utf8');
  #buffer = '';
  #total = 0;
  #next = 0;
  #closed?: DriverError;
  #inflightRequests = 0;
  get strictJsonrpc(): boolean { return this.#options.strictJsonrpc === true; }
  constructor(input: Readable, output: Writable, options: { timeoutMs: number; maxLineBytes: number; maxTotalBytes: number; strictJsonrpc?: boolean }) {
    positive(options.timeoutMs, 60000); positive(options.maxLineBytes, 8 * 1024 * 1024); positive(options.maxTotalBytes, 32 * 1024 * 1024);
    this.#input = input; this.#output = output; this.#options = { ...options };
    input.on('data', this.#data); input.on('end', this.#end); input.on('error', this.#error);
    output.on('error', this.#error);
  }
  readonly #error = () => this.close(new DriverError('disconnected'));
  readonly #end = () => this.close(new DriverError(this.#buffer.length ? 'protocol-error' : 'disconnected'));
  readonly #data = (chunk: Buffer | string) => {
    if (this.#closed) return;
    const raw = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    this.#total += raw.byteLength;
    if (this.#total > this.#options.maxTotalBytes) { this.close(new DriverError('output-limit')); return; }
    this.#buffer += this.#decoder.write(raw);
    for (;;) {
      const end = this.#buffer.indexOf('\n');
      if (end < 0) break;
      const line = this.#buffer.slice(0, end); this.#buffer = this.#buffer.slice(end + 1);
      if (bytes(line) > this.#options.maxLineBytes) { this.close(new DriverError('output-limit')); return; }
      try { this.#message(JSON.parse(line)); }
      catch { this.close(new DriverError('protocol-error')); return; }
      if (this.#closed) return;
    }
    if (bytes(this.#buffer) > this.#options.maxLineBytes) this.close(new DriverError('output-limit'));
  };
  #message(raw: unknown): void {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DriverError('protocol-error');
    const message = raw as Record<string, unknown>;
    if ((this.#options.strictJsonrpc && message.jsonrpc !== '2.0') || (message.jsonrpc !== undefined && message.jsonrpc !== '2.0')) throw new DriverError('protocol-error');
    if (typeof message.method === 'string') {
      string(message.method, 256);
      if ('result' in message || 'error' in message) throw new DriverError('protocol-error');
      const event = { method: message.method, params: message.params ?? null };
      if ('id' in message) {
        if (!id(message.id) || ++this.#inflightRequests > 16) throw new DriverError('protocol-error');
        const request = { ...event, id: message.id };
        const response = this.#requests?.(request) ?? Promise.resolve<RpcReply>({ error: { code: -32601, message: 'Unsupported request' } });
        void response.then(async reply => { await this.#send({ id: request.id, ...reply }); this.#replied?.(request); })
          .catch(() => this.close(new DriverError('protocol-error'))).finally(() => { this.#inflightRequests--; });
      } else this.#notifications.forEach(listener => listener(event));
      return;
    }
    if (!id(message.id) || ('result' in message) === ('error' in message)) throw new DriverError('protocol-error');
    const pending = this.#pending.get(message.id);
    if (!pending) throw new DriverError('protocol-error');
    this.#pending.delete(message.id); clearTimeout(pending.timer);
    if ('error' in message) pending.reject(new DriverError('rpc-error'));
    else {
      try { pending.onResult?.(message.result); pending.resolve(message.result); }
      catch (error) { pending.reject(error as Error); throw error; }
    }
  }
  async #send(message: unknown): Promise<void> {
    if (this.#closed) throw this.#closed;
    const encoded = JSON.stringify(this.#options.strictJsonrpc ? { jsonrpc: '2.0', ...(message as Record<string, unknown>) } : message) + '\n';
    if (bytes(encoded) > this.#options.maxLineBytes) throw new DriverError('output-limit');
    await new Promise<void>((resolve, reject) => this.#output.write(encoded, error => error ? reject(new DriverError('disconnected')) : resolve()));
  }
  request(method: string, params: unknown, onResult?: (value: unknown) => void): Promise<unknown> {
    if (this.#closed) return Promise.reject(this.#closed);
    if (this.#pending.size >= 16) return Promise.reject(new DriverError('protocol-error'));
    const requestId = ++this.#next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(requestId); reject(new DriverError('timed-out')); }, this.#options.timeoutMs);
      this.#pending.set(requestId, { resolve, reject, timer, ...(onResult ? { onResult } : {}) });
      void this.#send({ id: requestId, method, params }).catch(error => {
        clearTimeout(timer); this.#pending.delete(requestId); reject(error);
      });
    });
  }
  notify(method: string, params: unknown): Promise<void> { return this.#send({ method, params }); }
  onNotification(listener: (event: RpcNotification) => void): () => void { this.#notifications.add(listener); return () => { this.#notifications.delete(listener); }; }
  onFailure(listener: (error: DriverError) => void): () => void {
    if (this.#closed) listener(this.#closed); else this.#failures.add(listener);
    return () => { this.#failures.delete(listener); };
  }
  onRequest(handler: (request: RpcRequest) => Promise<RpcReply>, afterReply?: (request: RpcRequest) => void): void {
    if (this.#requests) throw new DriverError('busy'); this.#requests = handler;
    if (afterReply) this.#replied = afterReply;
  }
  close(error = new DriverError('disconnected')): void {
    if (this.#closed) return; this.#closed = error;
    this.#input.off('data', this.#data); this.#input.off('end', this.#end);
    this.#pending.forEach(p => { clearTimeout(p.timer); p.reject(error); }); this.#pending.clear();
    this.#failures.forEach(listener => listener(error)); this.#failures.clear(); this.#notifications.clear();
    this.#buffer = ''; // Error listeners remain to absorb late stream failures during host teardown.
  }
}
