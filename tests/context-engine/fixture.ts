import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TestContext } from 'node:test';
import { ContextBoundaryError } from '../../src/context-engine/contracts.js';
import type { EvidenceAccess, EvidenceAuthority, NetworkExecutor, NetworkIntent, OptimizationInput } from '../../src/context-engine/contracts.js';
import { MemoryOriginalStore } from '../../src/context-engine/originals.js';
import { digest, serialize } from '../../src/context-engine/validation.js';

export function input(): OptimizationInput {
  const content = Array.from({ length: 100 }, (_, i) => `INFO ${i} repeated build step passed`).join('\n') + '\nFATAL E42 failed compile';
  return { schemaVersion: 1, scope: { tenantId: 'local', principalId: 'owner', projectId: 'project',
    taskId: 'ticket-1', invocationId: 'coder', sessionId: 'session-1', policyVersion: 'local-v1', sourceSnapshot: 'snapshot-1' },
    protected: { objective: 'Fix compile', acceptanceCriteria: ['Keep error code E42'], policy: 'No release',
      permissions: ['src/example.ts:write'], checkpoint: 'Reproduction confirmed' },
    evidence: [{ id: 'log-1', sourceUri: 'artifact:build-log', sourceVersion: 'v1', content,
      contentDigest: digest(content), compressible: true }], budget: { maxBytes: 16384 }, expiresAt: 10000 };
}
/** Explicit test host. Production requires an actual policy/network executor, not this fixture. */
export function hostFixture(packet = input()) {
  let now = 1000;
  let live = true;
  let id = 0;
  let onAuthorize: ((access: EvidenceAccess) => void | Promise<void>) | undefined;
  const allowed = new Map(packet.evidence.map(e => [e.id, serialize({ id: e.id, contentDigest: e.contentDigest,
    sourceUri: e.sourceUri, sourceVersion: e.sourceVersion, compressible: e.compressible })]));
  const access: EvidenceAccess[] = [];
  const network: NetworkIntent[] = [];
  const verify = (scope: unknown) => {
    if (!live || serialize(scope) !== serialize(packet.scope)) throw new ContextBoundaryError('denied');
  };
  const authority: EvidenceAuthority = { async authorize(request, signal) {
    signal?.throwIfAborted();
    verify(request.scope);
    if (request.evidence.some(e => allowed.get(e.id) !== serialize(e))) return { allowed: false, receiptId: `denied-${++id}` };
    access.push(structuredClone(request));
    await onAuthorize?.(request);
    verify(request.scope);
    return { allowed: true, receiptId: `access-${++id}` };
  } };
  const executor: NetworkExecutor = { async execute<T>(intent: NetworkIntent, operation: () => Promise<T>, signal: AbortSignal) {
    signal.throwIfAborted(); verify(intent.scope);
    // The fixture records a reservation; only a real host can make it restart-durable.
    const receiptId = `network-${++id}`;
    network.push(structuredClone(intent));
    const value = await operation();
    signal.throwIfAborted(); verify(intent.scope);
    return { value, receiptId };
  } };
  const originals = new MemoryOriginalStore({ ttlMs: 60000, maxBytes: 1024 * 1024, clock: () => now });
  return { authority, executor, originals, clock: () => now, access, network,
    revoke() { live = false; },
    setTime(time: number) { now = time; }, onAuthorize(fn: typeof onAuthorize) { onAuthorize = fn; } };
}
export async function proxyFixture(t: TestContext, handler?: (request: IncomingMessage, response: ServerResponse, body: unknown) => void) {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body) as Record<string, unknown>;
      requests.push(parsed);
      if (handler) handler(req, res, parsed);
      else {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ messages: [{ role: 'tool', tool_call_id: 'evidence', content: 'FATAL E42 failed compile' }],
          tokens_before: 100000, tokens_after: 1, ccr_hashes: [] }));
      }
    } catch { res.statusCode = 500; res.end(); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/compress`;
  return { endpoint, requests };
}
