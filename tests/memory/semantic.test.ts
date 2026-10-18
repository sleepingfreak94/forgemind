import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest, serialize } from '../../src/context-engine/validation.js';
import { SemanticMemory, cosine, normalizeVector } from '../../src/memory/semantic.js';
import type { EmbeddingProvider, EmbeddingRequest } from '../../src/memory/semantic-contracts.js';
import type { MemoryRecord } from '../../src/memory/contracts.js';
import { fixture } from './fixture.js';

// Numeric fixtures exercise plumbing and math ONLY. They are not a production embedding model.
function fixtureProvider(encode: (request: Readonly<EmbeddingRequest>) => readonly number[] = request =>
  /tracing|latency/.test(request.text) ? [0, 1] : [1, 0]): EmbeddingProvider {
  return { identity: { model: 'numeric-test-fixture', version: 'fixture-v1', dimensions: 2 }, embed: async request => encode(request) };
}
function gate() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  return { enter, release, entered, pending };
}

test('known cosine math and strict vector validation', () => {
  assert.ok(Math.abs(cosine([3, 4], [4, 3]) - 0.96) < 1e-12);
  assert.equal(cosine([1, 0], [0, 1]), 0); assert.equal(cosine([1, 0], [-1, 0]), -1);
  assert.deepEqual(normalizeVector([3, 4], 2), [0.6, 0.8]);
  for (const vector of [[0, 0], [NaN, 1], [Infinity, 1], [Number.MAX_VALUE, 1], [Number.MIN_VALUE, 0], [1]]) {
    assert.throws(() => normalizeVector(vector, 2));
  }
  assert.throws(() => normalizeVector([1, 1], 4097));
  const getter = [1, 1]; let invoked = false;
  Object.defineProperty(getter, '0', { get() { invoked = true; return 1; } });
  assert.throws(() => normalizeVector(getter, 2)); assert.equal(invoked, false);
});

test('provider-needed is explicit and makes no embedding request', async () => {
  const f = fixture(); try {
    const id = f.memory.add(f.input()); f.memory.validate(id, id);
    const service = new SemanticMemory(f.memory);
    assert.equal(service.status().status, 'provider-needed');
    const packet = await service.search('persistence durability');
    assert.equal(packet.status, 'provider-needed'); assert.equal(packet.provider, null); assert.deepEqual(packet.entries, []);
    assert.equal(packet.trust, 'evidence-only'); assert.ok(Object.isFrozen(packet));
  } finally { f.dispose(); }
});

test('labeled fixture evaluation: lexical vs hybrid recall@1, source/model/index bound; no real-model quality claim', async t => {
  const f = fixture(); try {
    const storage = f.memory.add(f.input('Use SQLite transactions for durable decisions.'));
    const tracing = f.memory.add(f.input('Use tracing spans to diagnose slow requests.'));
    for (const id of [storage, tracing]) f.memory.validate(id, id);
    const service = new SemanticMemory(f.memory, fixtureProvider());
    const labels = [{ query: 'persistence durability', relevant: storage }, { query: 'latency bottleneck', relevant: tracing }];
    let lexicalHits = 0, hybridHits = 0;
    const bindings: string[] = [];
    for (const label of labels) {
      const lexical = f.memory.search(label.query, 1), hybrid = await service.search(label.query, 'hybrid', 1);
      lexicalHits += Number(lexical.some(hit => hit.id === label.relevant));
      hybridHits += Number(hybrid.entries.some(hit => hit.id === label.relevant));
      assert.equal(hybrid.entries[0]?.digest, label.relevant);
      assert.equal(hybrid.indexVersion, 'project-semantic-v1');
      assert.equal(hybrid.provider?.version, 'fixture-v1');
      assert.equal(hybrid.entries[0]?.sources[0]?.sha256, f.memory.get(label.relevant)?.sources[0]?.sha256);
      bindings.push(hybrid.entries[0]!.bindingDigest);
      assert.deepEqual(await service.search(label.query, 'hybrid', 1), hybrid);
      const { digest: stored, ...body } = hybrid; assert.equal(stored, digest(serialize(body)));
    }
    const report = { quality: 'fixture-only-not-production', metric: 'recall@1', lexical: lexicalHits / labels.length,
      hybrid: hybridHits / labels.length, model: 'numeric-test-fixture', version: 'fixture-v1', index: 'project-semantic-v1',
      labels, sourceBindings: bindings };
    assert.equal(report.lexical, 0); assert.equal(report.hybrid, 1); t.diagnostic(JSON.stringify(report));
    const changed = new SemanticMemory(f.memory, { ...fixtureProvider(), identity: { model: 'numeric-test-fixture', version: 'fixture-v2', dimensions: 2 } });
    assert.notEqual((await changed.search(labels[0]!.query)).entries[0]?.bindingDigest, bindings[0]);
  } finally { f.dispose(); }
});

test('embedding requests are scoped, immutable and exclude candidates, superseded and expired records', async () => {
  const f = fixture(); try {
    const old = f.memory.add(f.input('Old validated decision')); f.memory.validate(old, old);
    const fresh = f.memory.add({ ...f.input('Current validated decision'), supersedes: old }); f.memory.validate(fresh, fresh);
    f.memory.add(f.input('Candidate never embedded'));
    const expiring = f.memory.add({ ...f.input('Expired never embedded'), expiresAt: 1100 }); f.memory.validate(expiring, expiring); f.setNow(1100);
    const requests: Readonly<EmbeddingRequest>[] = [];
    const service = new SemanticMemory(f.memory, fixtureProvider(request => { requests.push(request); return [1, 0]; }));
    const packet = await service.search('decision');
    assert.deepEqual(packet.entries.map(hit => hit.id), [fresh]);
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(request.projectId, f.projectId); assert.equal(request.workspaceRoot, f.root);
      assert.ok(Object.isFrozen(request)); assert.ok(Object.isFrozen(request.provider));
    }
    assert.match(requests[1]!.text, /Current validated/);
  } finally { f.dispose(); }
});

test('in-flight source mutation/removal/deregistration/deletion/expiry suppresses evidence after record await', async () => {
  for (const mutation of ['change', 'remove', 'registration', 'delete', 'expire'] as const) {
    const f = fixture(); try {
      const id = f.memory.add({ ...f.input(), expiresAt: 2000 }); f.memory.validate(id, id);
      const wait = gate();
      const provider: EmbeddingProvider = { identity: fixtureProvider().identity, embed: async request => {
        if (request.purpose === 'record') { wait.enter(); await wait.pending; }
        return [1, 0];
      } };
      const result = new SemanticMemory(f.memory, provider).search('durability'); await wait.entered;
      if (mutation === 'change') writeFileSync(join(f.root, f.path), '# Different\nStatus: Accepted\nChanged source');
      if (mutation === 'remove') rmSync(join(f.root, f.path));
      if (mutation === 'delete') f.memory.remove(id, id);
      if (mutation === 'expire') f.setNow(2000);
      if (mutation === 'registration') {
        const path = join(f.root, 'config/forgemind-project.json'), profile = JSON.parse(readFileSync(path, 'utf8'));
        profile.documents.adrs = 'docs/other'; writeFileSync(path, JSON.stringify(profile));
      }
      wait.release(); assert.deepEqual((await result).entries, [], mutation);
    } finally { f.dispose(); }
  }
});

test('revocation while query awaits prevents even sending record text to provider', async () => {
  const f = fixture(); try {
    const id = f.memory.add(f.input()); f.memory.validate(id, id);
    const wait = gate(); let recordCalls = 0;
    const provider: EmbeddingProvider = { identity: fixtureProvider().identity, embed: async request => {
      if (request.purpose === 'query') { wait.enter(); await wait.pending; } else recordCalls++;
      return [1, 0];
    } };
    const result = new SemanticMemory(f.memory, provider).search('durability'); await wait.entered;
    f.memory.remove(id, id); wait.release();
    assert.deepEqual((await result).entries, []); assert.equal(recordCalls, 0);
  } finally { f.dispose(); }
});

test('provider identity drift in flight fails closed and invalid provider vectors reject', async () => {
  const f = fixture(); try {
    const id = f.memory.add(f.input()); f.memory.validate(id, id);
    const mutable = { model: 'numeric-test-fixture', version: 'fixture-v1', dimensions: 2 }, wait = gate();
    const provider: EmbeddingProvider = { identity: mutable, embed: async () => { wait.enter(); await wait.pending; return [1, 0]; } };
    const result = new SemanticMemory(f.memory, provider).search('durability'); await wait.entered;
    mutable.version = 'changed'; wait.release(); await assert.rejects(result, /identity drift/);
    for (const vector of [[0, 0], [1], [NaN, 1], [Infinity, 1], [Number.MAX_VALUE, 1]]) {
      await assert.rejects(new SemanticMemory(f.memory, fixtureProvider(() => vector)).search('durability'));
    }
    assert.throws(() => new SemanticMemory(f.memory, { ...fixtureProvider(), identity: { model: 'bad', version: 'v1', dimensions: 4097 } }));
  } finally { f.dispose(); }
});

test('foreign scope suppressed even if a faulty public adapter returns another project record', async () => {
  const f = fixture(); try {
    const id = f.memory.add(f.input()); f.memory.validate(id, id);
    const original = f.memory.get.bind(f.memory); let calls = 0;
    f.memory.get = (value: string): Readonly<MemoryRecord> | undefined => {
      const record = original(value); return record ? { ...record, workspaceRoot: '/foreign', projectId: 'foreign' } : undefined;
    };
    const packet = await new SemanticMemory(f.memory, fixtureProvider(() => { calls++; return [1, 0]; })).search('durability');
    assert.deepEqual(packet.entries, []); assert.equal(calls, 0);
  } finally { f.dispose(); }
});

test('record/query/corpus/result budgets reject before embedding; ties and packets are bounded immutable', async () => {
  const f = fixture(); try {
    const id = f.memory.add(f.input('文'.repeat(11000))); f.memory.validate(id, id); let calls = 0;
    const service = new SemanticMemory(f.memory, fixtureProvider(() => { calls++; return [1, 0]; }));
    await assert.rejects(service.search('query'), /text|input/); assert.equal(calls, 0);
    await assert.rejects(service.search('文'.repeat(700))); await assert.rejects(service.search('query', 'hybrid', 11));
    f.memory.remove(id, id);
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) { const item = f.memory.add(f.input(`文${'x'.repeat(1800)}${i}`)); f.memory.validate(item, item); ids.push(item); }
    const packet = await service.search('unmatched', 'semantic');
    assert.deepEqual(packet.entries.map(hit => hit.id), ids.sort().slice(0, packet.entries.length));
    assert.ok(packet.entries.length > 0 && packet.entries.length <= 10);
    assert.ok(Buffer.byteLength(serialize(packet)) <= 24000);
    assert.ok(Object.isFrozen(packet.entries)); assert.ok(Object.isFrozen(packet.entries[0]!.sources));
    const originalList = f.memory.list.bind(f.memory), summary = originalList().find(item => item.state === 'validated')!;
    f.memory.list = () => Array.from({ length: 257 }, () => summary);
    calls = 0; await assert.rejects(service.search('query'), /record budget/); assert.equal(calls, 0);
  } finally { f.dispose(); }
});

test('aggregate UTF8 corpus budget rejects rather than silently indexing a subset', async () => {
  const f = fixture(); try {
    for (let i = 0; i < 9; i++) { const id = f.memory.add(f.input(`${i}${'x'.repeat(30000)}`)); f.memory.validate(id, id); }
    let calls = 0;
    await assert.rejects(new SemanticMemory(f.memory, fixtureProvider(() => { calls++; return [1, 0]; })).search('query'), /corpus byte budget/);
    assert.equal(calls, 0);
  } finally { f.dispose(); }
});
