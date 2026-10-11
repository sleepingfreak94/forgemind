import assert from 'node:assert/strict';
import { appendFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { scanDocuments } from '../../src/memory/documents.js';
import { fixture } from './fixture.js';

type Execution = { sql: string; method: string; args: unknown[] };
function capture<T>(work: (executions: Execution[]) => T): T {
  const executions: Execution[] = [], sql = new WeakMap<object, string>();
  const patched = new Set<object>(), restorations: (() => void)[] = [];
  const prepare = DatabaseSync.prototype.prepare;
  const patch = (target: object, key: string, value: unknown) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key)!;
    restorations.push(() => { Object.defineProperty(target, key, descriptor); });
    Object.defineProperty(target, key, { ...descriptor, value });
  };
  try {
    patch(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, ...args: Parameters<typeof prepare>) {
      const statement = Reflect.apply(prepare, this, args) as ReturnType<typeof prepare>;
      sql.set(statement, args[0]);
      const prototype = Object.getPrototypeOf(statement);
      if (!patched.has(prototype)) {
        patched.add(prototype);
        for (const method of ['all', 'get', 'run']) {
          const original = prototype[method];
          patch(prototype, method, function (this: object, ...bound: unknown[]) {
            const text = sql.get(this);
            if (text !== undefined) executions.push({ sql: text, method, args: bound });
            return Reflect.apply(original, this, bound);
          });
        }
      }
      return statement;
    });
    return work(executions);
  } finally {
    for (const restore of restorations.reverse()) restore();
  }
}
const matches = (executions: Execution[]) => executions.filter(entry => /\bMATCH\b/i.test(entry.sql));

test('batched search executes one MATCH over eligible IDs and orders scores and ties', () => {
  const f = fixture();
  try {
    const expected: { id: string; score: number }[] = [];
    for (let i = 0; i < 40; i++) {
      const id = f.memory.add({ ...f.input(`SQLite durable decision ${i}.`),
        title: i < 6 ? `SQLite decision ${i}` : `Storage decision ${i}` });
      f.memory.validate(id, id);
      expected.push({ id, score: i < 6 ? 4 : 1 });
    }
    assert.equal(new Set(expected.map(item => item.id)).size, 40);
    expected.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    capture(executions => {
      const hits = f.memory.search('SQLite');
      assert.equal(hits.length, 10);
      assert.deepEqual(hits.map(hit => hit.id), expected.slice(0, 10).map(item => item.id));
      const fts = matches(executions);
      assert.equal(fts.length, 1);
      assert.ok(fts[0]);
      assert.equal(executions.filter(entry => /\bSELECT\b.*\bFROM\s+deleted_sources\b/i.test(entry.sql)).length, 1);
      assert.equal(executions.filter(entry => /\bSELECT\b.*\bFROM\s+records\b/i.test(entry.sql) && !/\bexpires_at\b/i.test(entry.sql)).length, 1);
      assert.equal(fts[0].method, 'all');
      assert.match(fts[0].sql, /\bMATCH\s+\?/i);
      assert.match(fts[0].sql, /\bjson_each\(\?\)/i);
      assert.equal(fts[0].args.length, 2);
      assert.equal(fts[0].args[0], '"sqlite"');
      assert.equal(typeof fts[0].args[1], 'string');
      assert.deepEqual(JSON.parse(fts[0].args[1] as string).sort(), expected.map(item => item.id).sort());
    });
  } finally { f.dispose(); }
});

test('ineligible and punctuation searches skip MATCH; invalid inputs execute no SQL', () => {
  for (const scenario of ['candidate', 'changed', 'punctuation']) {
    const f = fixture();
    try {
      const id = f.memory.add(f.input());
      if (scenario !== 'candidate') f.memory.validate(id, id);
      if (scenario === 'changed') appendFileSync(join(f.root, f.path), '\nChanged source bytes.\n');
      capture(executions => {
        assert.deepEqual(f.memory.search(scenario === 'punctuation' ? '!!! ... -- "" ()' : 'SQLite'), []);
        assert.equal(matches(executions).length, 0);
        if (scenario === 'punctuation') {
          for (const query of [undefined, null, 17, '', 'x'.repeat(2049)]) {
            executions.length = 0;
            assert.throws(() => f.memory.search(query as string));
            assert.equal(executions.length, 0);
          }
          for (const limit of [0, -1, 11, 1.5, NaN, Infinity, '1', null]) {
            executions.length = 0;
            assert.throws(() => f.memory.search('SQLite', limit as number));
            assert.equal(executions.length, 0);
          }
        }
      });
    } finally { f.dispose(); }
  }
});

test('mixed retrieval rejects stale citations and preserves record and source tombstones', () => {
  const f = fixture();
  try {
    const second = 'docs/adr/ADR-0002-secondary.md', retired = 'docs/adr/ADR-0003-retired.md';
    const retiredText = '# Retired storage\n\nStatus: Accepted\n\nSQLite retired source.\n';
    writeFileSync(join(f.root, second), '# Secondary storage\n\nStatus: Accepted\n\nSQLite secondary source.\n');
    writeFileSync(join(f.root, retired), retiredText);
    const documents = scanDocuments(f.root, f.projectId);
    const source = (path: string) => {
      const doc = documents.find(item => item.path === path)!;
      return { path: doc.path, sha256: doc.sha256, status: doc.status };
    };
    const addValidated = (text: string, sources = f.input().sources) => {
      const id = f.memory.add({ ...f.input(text), sources });
      f.memory.validate(id, id);
      return id;
    };
    const stable = addValidated('SQLite unchanged decision.');
    const candidate = f.memory.add(f.input('SQLite candidate decision.'));
    const multi = addValidated('SQLite multi-source decision.', [source(f.path), source(second)]);
    const removedInput = f.input('SQLite individually removed decision.');
    const removed = f.memory.add(removedInput);
    f.memory.validate(removed, removed);
    const dependent = addValidated('SQLite retired derivative.', [source(retired)]);
    const document = f.memory.ingest().imported.find(id =>
      f.memory.inspect(id)?.sources.some(item => item.path === retired))!;
    assert.ok(document);
    f.memory.validate(document, document);
    const expectHits = (ids: string[]) => {
      assert.deepEqual(f.memory.search('SQLite').map(hit => hit.id).sort(), [...ids].sort());
    };
    expectHits([stable, multi, removed, dependent, document]);
    appendFileSync(join(f.root, second), '\nOnly this citation changed.\n');
    expectHits([stable, removed, dependent, document]);
    f.memory.remove(removed, removed);
    expectHits([stable, dependent, document]);
    f.memory.remove(document, document);
    expectHits([stable]);
    assert.equal(f.memory.add(removedInput), removed);
    expectHits([stable]);
    rmSync(join(f.root, retired));
    f.memory.ingest();
    expectHits([stable]);
    writeFileSync(join(f.root, retired), retiredText);
    assert.ok(!f.memory.ingest().imported.includes(document));
    expectHits([stable]);
    f.memory.rebuildIndex();
    expectHits([stable]);
    f.reopen();
    expectHits([stable]);
    for (const id of [multi, removed, dependent, document]) assert.equal(f.memory.inspect(id), undefined);
    assert.equal(f.memory.inspect(candidate)?.state, 'candidate');
  } finally { f.dispose(); }
});
