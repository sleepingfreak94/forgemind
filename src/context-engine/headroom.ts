import { CompressionUnavailable, ContextBoundaryError } from './contracts.js';
import type { ContextEvidence, ContextScope, NetworkExecutor } from './contracts.js';
import { bytes, digest, positive, string } from './validation.js';

export interface HeadroomOptions {
  /** Exact compression-only URL. Literal loopback only; no DNS or redirects. */
  endpoint: string;
  model: string;
  timeoutMs: number;
  maxResponseBytes: number;
  executor: NetworkExecutor;
  /** Local proxy auth only. Never a provider credential; no ambient env lookup. */
  proxyToken?: string;
}
export class HeadroomCompressor {
  readonly id: string;
  readonly #options: HeadroomOptions;
  constructor(options: HeadroomOptions) {
    const url = new URL(options.endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/v1/compress' ||
      url.href !== options.endpoint) throw new ContextBoundaryError('invalid-input');
    string(options.model, 128); positive(options.timeoutMs, 60000); positive(options.maxResponseBytes, 2 * 1024 * 1024);
    if (!options.executor || typeof options.executor.execute !== 'function') throw new ContextBoundaryError('invalid-input');
    if (options.proxyToken !== undefined) {
      string(options.proxyToken, 4096);
      if (/[\r\n]/.test(options.proxyToken)) throw new ContextBoundaryError('invalid-input');
    }
    this.#options = Object.freeze({ ...options });
    this.id = `headroom-http-v1:${digest(JSON.stringify({ endpoint: options.endpoint, model: options.model }))}`;
  }
  async compress(scope: ContextScope, evidence: ContextEvidence, signal?: AbortSignal): Promise<{ content: string; receiptId: string }> {
    signal?.throwIfAborted();
    const active = signal ? AbortSignal.any([signal, AbortSignal.timeout(this.#options.timeoutMs)]) : AbortSignal.timeout(this.#options.timeoutMs);
    const body = JSON.stringify({ model: this.#options.model, messages: [{ role: 'tool', tool_call_id: 'evidence', content: evidence.content }] });
    try {
      const result = await this.#options.executor.execute({ scope, endpoint: this.#options.endpoint,
        bodyDigest: digest(body), evidenceId: evidence.id }, async () => {
        try {
          active.throwIfAborted();
          const headers: Record<string, string> = { 'content-type': 'application/json' };
          if (this.#options.proxyToken) headers['X-Headroom-Proxy-Token'] = this.#options.proxyToken;
          const response = await fetch(this.#options.endpoint, { method: 'POST', body, headers, signal: active, redirect: 'error' });
          if (!response.ok || !response.headers.get('content-type')?.includes('application/json') || !response.body) {
            await response.body?.cancel(); throw new CompressionUnavailable();
          }
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            for (;;) {
              const part = await reader.read();
              if (part.done) break;
              size += part.value.byteLength;
              if (size > this.#options.maxResponseBytes) throw new CompressionUnavailable();
              chunks.push(part.value);
            }
          } finally { await reader.cancel(); reader.releaseLock(); }
          active.throwIfAborted();
          const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!data || typeof data !== 'object') throw new CompressionUnavailable();
          const record = data as Record<string, unknown>;
          if (!Array.isArray(record.messages) || record.messages.length !== 1 ||
              (record.ccr_hashes !== undefined && (!Array.isArray(record.ccr_hashes) || record.ccr_hashes.length))) throw new CompressionUnavailable();
          const message = record.messages[0] as Record<string, unknown>;
          if (!message || Object.keys(message).some(k => !['role', 'tool_call_id', 'content'].includes(k)) ||
              message.role !== 'tool' || message.tool_call_id !== 'evidence' || typeof message.content !== 'string' ||
              message.content.includes('\0') || bytes(message.content) > bytes(evidence.content)) throw new CompressionUnavailable();
          return message.content;
        } catch { throw new CompressionUnavailable(); }
      }, active);
      if (active.aborted) throw new CompressionUnavailable();
      string(result.receiptId, 256);
      return { content: result.value, receiptId: result.receiptId };
    } catch (error) {
      if (signal?.aborted) throw new ContextBoundaryError('cancelled');
      if (error instanceof ContextBoundaryError) throw error;
      if (error instanceof CompressionUnavailable) throw error;
      // Native transport/protocol errors are classified inside the operation above.
      // An unknown error from the privileged executor must fail closed, never fall back.
      throw new ContextBoundaryError('denied');
    }
  }
}
