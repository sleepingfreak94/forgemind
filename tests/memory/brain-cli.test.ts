import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBrainCli } from '../../src/local-runtime/brain-cli.js';
import { BrainStore } from '../../src/memory/brain.js';
import { brainSpaceFor, mapBrainSpace } from '../../src/memory/brain-spaces.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'brain-cli-')));
after(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
function setup() {
  const base = join(root, `case${counter++}`);
  const brain = join(base, 'brain'), ws = join(base, 'ws'), ws2 = join(base, 'ws2');
  mkdirSync(ws, { recursive: true }); mkdirSync(ws2);
  return { base, brain, ws, ws2 };
}
function run(brain: string, args: string[]) {
  let out = '';
  let code = -1;
  assert.doesNotThrow(() => { code = runBrainCli([...args, '--brain-dir', brain], { write: t => { out += t; } }); });
  assert.equal(out.split('\n').filter(Boolean).length, 1);
  assert.ok(out.endsWith('\n'));
  return { code, json: JSON.parse(out) as Record<string, any>, out };
}

test('unmapped project is refused', () => {
  const { brain, ws } = setup();
  const r = run(brain, ['list', '--workspace', ws]);
  assert.equal(r.code, 1);
  assert.equal(r.json.error, 'Project is not mapped to a brain space; run brain map');
});

test('map writes private canonical file and refuses switching', () => {
  const { brain, ws, base } = setup();
  const link = join(base, 'link'); symlinkSync(ws, link);
  const r = run(brain, ['map', '--workspace', link, '--space', 'personal']);
  assert.equal(r.code, 0); assert.deepEqual(r.json, { ok: true });
  const file = join(brain, 'spaces.json');
  assert.equal(lstatSync(file).mode & 0o777, 0o600);
  assert.equal(lstatSync(brain).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { schemaVersion: 1, projects: { [ws]: 'personal' } });
  assert.equal(run(brain, ['map', '--workspace', ws, '--space', 'personal']).code, 0);
  const before = readFileSync(file, 'utf8');
  const other = run(brain, ['map', '--workspace', ws, '--space', 'company']);
  assert.notEqual(other.code, 0); assert.match(other.json.error, /already mapped/);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.deepEqual(readdirSync(brain).filter(n => n.endsWith('.tmp')), []);
});

test('add, list, lifecycle', () => {
  const { brain, ws } = setup();
  run(brain, ['map', '--workspace', ws, '--space', 'personal']);
  const a = run(brain, ['add', '--workspace', ws, '--kind', 'convention', '--text', 'Use tabs.', '--reason', 'owner']);
  const b = run(brain, ['add', '--workspace', ws, '--kind', 'lesson', '--text', 'Wide lesson.', '--reason', 'owner', '--scope', 'space']);
  assert.match(a.json.id, /^[0-9a-f]{16}$/); assert.match(b.json.id, /^[0-9a-f]{16}$/);
  const list = run(brain, ['list', '--workspace', ws]);
  assert.equal(list.json.space, 'personal'); assert.equal(list.json.entries.length, 2);
  const byId = new Map(list.json.entries.map((e: any) => [e.id, e]));
  assert.equal((byId.get(a.json.id) as any).project, ws);
  assert.equal((byId.get(b.json.id) as any).project, null);
  assert.equal(run(brain, ['list', '--workspace', ws, '--status', 'approved']).json.entries.length, 0);
  const store = new BrainStore(brain, 'personal');
  assert.equal(store.approved(ws).length, 0);
  store.close();
  assert.equal(run(brain, ['approve', '--workspace', ws, '--id', a.json.id]).code, 0);
  assert.equal(run(brain, ['show', '--workspace', ws, '--id', a.json.id]).json.entry.status, 'approved');
  assert.equal(run(brain, ['retire', '--workspace', ws, '--id', a.json.id]).code, 0);
  assert.equal(run(brain, ['reject', '--workspace', ws, '--id', b.json.id, '--note', 'no']).code, 0);
  assert.equal(run(brain, ['show', '--workspace', ws, '--id', b.json.id]).json.entry.reviewNote, 'no');
  assert.equal(run(brain, ['approve', '--workspace', ws, '--id', b.json.id]).code, 1);
});

test('spaces are walled', () => {
  const { brain, ws, ws2 } = setup();
  run(brain, ['map', '--workspace', ws, '--space', 'personal']);
  run(brain, ['map', '--workspace', ws2, '--space', 'company']);
  const a = run(brain, ['add', '--workspace', ws, '--kind', 'decision', '--text', 'Private.', '--reason', 'r']);
  assert.equal(run(brain, ['list', '--workspace', ws2]).json.entries.length, 0);
  assert.equal(run(brain, ['show', '--workspace', ws2, '--id', a.json.id]).code, 1);
});

test('usage errors exit 2', () => {
  const { brain, ws } = setup();
  const cases: string[][] = [[], ['bogus'], ['list', '--workspace', ws, '--bogus', '1'], ['list', '--workspace', ws, '--workspace', ws],
    ['list', '--workspace'], ['map', '--workspace', ws, '--space', 'bogus'],
    ['add', '--workspace', ws, '--kind', 'lesson', '--text', 'x', '--reason', 'r', '--scope', 'bogus']];
  for (const c of cases) {
    let out = ''; let code = -1;
    assert.doesNotThrow(() => { code = runBrainCli(c.length ? [...c, '--brain-dir', brain] : c, { write: t => { out += t; } }); });
    assert.equal(code, 2); assert.ok('error' in JSON.parse(out));
  }
});

test('secrets refused without echo', () => {
  const { brain, ws } = setup();
  run(brain, ['map', '--workspace', ws, '--space', 'personal']);
  const r = run(brain, ['add', '--workspace', ws, '--kind', 'lesson', '--text', 'password=hunter2', '--reason', 'r']);
  assert.notEqual(r.code, 0); assert.ok(!r.out.includes('hunter2'));
});

test('map file validation', () => {
  const { brain, ws, base } = setup();
  mapBrainSpace(ws, 'personal', brain);
  const file = join(brain, 'spaces.json');
  const good = readFileSync(file, 'utf8');
  const reset = () => { rmSync(file, { force: true }); writeFileSync(file, good, { mode: 0o600 }); chmodSync(file, 0o600); };
  chmodSync(file, 0o644);
  assert.throws(() => brainSpaceFor(ws, brain), /owner-only/);
  assert.notEqual(run(brain, ['list', '--workspace', ws]).code, 0);
  reset(); assert.equal(brainSpaceFor(ws, brain), 'personal');
  const real = join(base, 'real.json'); writeFileSync(real, good, { mode: 0o600 });
  rmSync(file); symlinkSync(real, file);
  assert.throws(() => brainSpaceFor(ws, brain), /owner-only/);
  assert.notEqual(run(brain, ['list', '--workspace', ws]).code, 0);
  rmSync(file); reset();
  linkSync(file, join(base, 'hard'));
  assert.throws(() => brainSpaceFor(ws, brain), /owner-only/);
  rmSync(join(base, 'hard')); reset();
  writeFileSync(file, '{bad', { mode: 0o600 });
  assert.throws(() => brainSpaceFor(ws, brain), /Invalid brain space map/);
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, projects: {}, extra: 1 }), { mode: 0o600 });
  assert.throws(() => brainSpaceFor(ws, brain), /Invalid brain space map/);
});
