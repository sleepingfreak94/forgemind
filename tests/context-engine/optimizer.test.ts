import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PacketContextOptimizer, PassThroughContextOptimizer } from '../../src/context-engine/optimizer.js';
import { HeadroomCompressor } from '../../src/context-engine/headroom.js';
import { MemoryOriginalStore } from '../../src/context-engine/originals.js';
import { digest, serialize } from '../../src/context-engine/validation.js';
import { hostFixture, input, proxyFixture } from './fixture.js';

test('pass-through preserves all protected content/evidence with stable digests and no network', async () => {
  const packet = input(); const host = hostFixture(packet);
  const optimizer = new PassThroughContextOptimizer(host);
  const result = await optimizer.optimize(packet);
  assert.deepEqual(result.view.protected, packet.protected);
  assert.deepEqual(result.view.scope, packet.scope);
  assert.equal(result.view.evidence[0]?.content, packet.evidence[0]?.content);
  assert.equal(result.beforeBytes, result.afterBytes);
  assert.equal(result.viewDigest, digest(serialize(result.view)));
  assert.equal(result.view.canonicalPacketDigest, digest(serialize(packet)));
  assert.equal(result.optimizerId, 'pass-through-v1');
  assert.equal(host.network.length, 0);
  assert.deepEqual(await optimizer.recover(packet.scope, result.view.evidence[0]!.originalReference), packet.evidence[0]);
  assert.equal(Object.isFrozen(result.view.protected.permissions), true);
});

test('malformed packets, bad hashes and duplicate IDs fail before authorization', async () => {
  for (const mutate of [
    (p: ReturnType<typeof input>) => { p.evidence[0]!.contentDigest = 'bad'; },
    (p: ReturnType<typeof input>) => { p.evidence.push({ ...p.evidence[0]! }); },
    (p: ReturnType<typeof input>) => { p.budget.maxBytes = 0; },
    (p: ReturnType<typeof input>) => { (p as unknown as Record<string, unknown>).approved = true; },
  ]) {
    const packet = input(); const host = hostFixture(packet); mutate(packet);
    await assert.rejects(new PassThroughContextOptimizer(host).optimize(packet), /invalid-input/);
    assert.equal(host.access.length, 0);
  }
});

test('array accessors cannot substitute content or protected instructions between validation and cloning', async () => {
  for (const target of ['evidence', 'permissions', 'acceptanceCriteria'] as const) {
    const packet = input(); const host = hostFixture(packet); let reads = 0;
    const original = structuredClone(packet.evidence[0]!);
    const array = target === 'evidence' ? packet.evidence : packet.protected[target];
    Object.defineProperty(array, '0', { enumerable: true, configurable: true, get() {
      reads++;
      return target === 'evidence' ? (reads < 3 ? original : { ...original, content: 'UNAUTHORIZED CONTENT WITH STALE DIGEST' }) : 'release allowed';
    } });
    await assert.rejects(new PassThroughContextOptimizer(host).optimize(packet), /invalid-input/);
    assert.equal(reads, 0); assert.equal(host.access.length, 0);
  }
});

test('source provenance and compression eligibility cannot be relabeled under an authorized content hash', async () => {
  for (const key of ['sourceUri', 'sourceVersion', 'compressible'] as const) {
    const packet = input(); const host = hostFixture(packet);
    if (key === 'compressible') packet.evidence[0]!.compressible = false;
    else packet.evidence[0]![key] = 'forged';
    await assert.rejects(new PassThroughContextOptimizer(host).optimize(packet), /denied/);
  }
});

test('unauthorized evidence rejects the packet with zero proxy requests', async t => {
  const packet = input(); const host = hostFixture(packet); const proxy = await proxyFixture(t);
  const unauthorized = { ...packet.evidence[0]!, id: 'secret' }; packet.evidence.push(unauthorized);
  const compressor = new HeadroomCompressor({ endpoint: proxy.endpoint, model: 'test-model', timeoutMs: 1000, maxResponseBytes: 8192, executor: host.executor });
  await assert.rejects(new PacketContextOptimizer({ ...host, compressor }).optimize(packet), /denied/);
  assert.equal(proxy.requests.length, 0); assert.equal(host.network.length, 0);
});

test('caller mutation during await cannot change the validated packet', async () => {
  const packet = input(); const original = structuredClone(packet); const host = hostFixture(original);
  host.onAuthorize(access => {
    if (access.phase === 'read') { packet.protected.policy = 'release allowed'; packet.evidence[0]!.content = 'changed'; }
  });
  const result = await new PassThroughContextOptimizer(host).optimize(packet);
  assert.deepEqual(result.view.protected, original.protected);
  assert.equal(result.view.evidence[0]?.content, original.evidence[0]?.content);
});

test('revocation at packing blocks disclosure and does not retain originals', async () => {
  const packet = input(); const host = hostFixture(packet);
  host.onAuthorize(access => { if (access.phase === 'pack') host.revoke(); });
  const optimizer = new PassThroughContextOptimizer(host);
  await assert.rejects(optimizer.optimize(packet), /denied/);
  const reference = host.originals.reference(packet.scope, packet.evidence[0]!);
  assert.throws(() => host.originals.get(packet.scope, reference), /original-unavailable/);
});

test('byte and injected token budgets fail visibly without truncation', async () => {
  const packet = input(); const host = hostFixture(packet);
  packet.budget.maxBytes = 100;
  await assert.rejects(new PassThroughContextOptimizer(host).optimize(packet), /budget-exceeded/);
  packet.budget.maxBytes = 16384; packet.budget.maxTokens = 10;
  await assert.rejects(new PassThroughContextOptimizer(host).optimize(packet), /invalid-input/);
  await assert.rejects(new PassThroughContextOptimizer({ ...host, tokenCounter: { id: 'test-counter', count: () => 11 } }).optimize(packet), /budget-exceeded/);
});

test('original retrieval isolates every scope field and rechecks live authority', async () => {
  const packet = input(); const host = hostFixture(packet); const optimizer = new PassThroughContextOptimizer(host);
  const result = await optimizer.optimize(packet); const ref = result.view.evidence[0]!.originalReference;
  for (const key of Object.keys(packet.scope) as (keyof typeof packet.scope)[]) {
    await assert.rejects(optimizer.recover({ ...packet.scope, [key]: 'other' }, ref), /original-unavailable/);
  }
  host.revoke(); await assert.rejects(optimizer.recover(packet.scope, ref), /denied/);
});

test('original expiry and deletion are visible, including deletion during authorization', async () => {
  const packet = input(); const host = hostFixture(packet); const optimizer = new PassThroughContextOptimizer(host);
  const result = await optimizer.optimize(packet); const ref = result.view.evidence[0]!.originalReference;
  host.setTime(10000); await assert.rejects(optimizer.recover(packet.scope, ref), /original-unavailable/);
  host.setTime(1000); await optimizer.optimize(packet);
  host.onAuthorize(access => { if (access.phase === 'recover') host.originals.deleteScope(packet.scope); });
  await assert.rejects(optimizer.recover(packet.scope, ref), /original-unavailable/);
});

test('insufficient original-store capacity blocks a packet instead of exposing unusable references', async () => {
  const packet = input(); const host = hostFixture(packet);
  const originals = new MemoryOriginalStore({ ttlMs: 60000, maxBytes: 100, clock: host.clock });
  await assert.rejects(new PassThroughContextOptimizer({ ...host, originals }).optimize(packet), /original-unavailable/);
});

test('cancellation and expired inputs never produce an agent view', async () => {
  const packet = input(); const host = hostFixture(packet); const optimizer = new PassThroughContextOptimizer(host);
  await assert.rejects(optimizer.optimize(packet, AbortSignal.abort()), /cancelled/);
  host.setTime(10000); await assert.rejects(optimizer.optimize(packet), /expired/);
  assert.equal(host.access.length, 0);
});
