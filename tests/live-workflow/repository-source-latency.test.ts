import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { sourceIdentity } from '../../src/live-workflow/repository.js';

const execute = childProcess.execFileSync;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
function git(root: string, ...args: string[]): Buffer {
  return execute('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root,
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: ['ignore', 'pipe', 'pipe'] });
}
function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'forgemind-source-check-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(root, '.gitignore'), 'ignored/\n');
  writeFileSync(join(root, 'tracked.txt'), 'initial\n');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'fixture');
  return root;
}
function observe(t: TestContext, rewrite?: (args: string[], bytes: Buffer) => Buffer) {
  const calls: string[][] = [];
  t.mock.method(childProcess, 'execFileSync', (executable: string, args: string[], options: unknown) => {
    if (!args[0]?.endsWith('/repository-supervisor.js')) return execute(executable, args, options as Parameters<typeof execute>[2]);
    const command = JSON.parse(Buffer.from(args[1]!, 'base64url').toString()) as { executable: string; args: string[] };
    if (command.executable !== 'git') return execute(executable, args, options as Parameters<typeof execute>[2]);
    calls.push(command.args);
    const bytes = execute(executable, args, options as Parameters<typeof execute>[2]);
    if (!Buffer.isBuffer(bytes)) throw new Error('Expected raw supervised Git bytes');
    return rewrite ? rewrite(command.args, bytes) : bytes;
  });
  return calls;
}
function staged(t: TestContext, bytes: Buffer) {
  return observe(t, (args, original) => args.includes('ls-files') && args.includes('--stage') ? bytes : original);
}
test('source snapshots use four supervised Git commands without cache or redundant tracked listing', t => {
  const root = fixture(t), calls = observe(t);
  const first = sourceIdentity(root); assert.equal(calls.length, 4);
  assert.ok(calls[0]!.includes('--show-toplevel') && calls[0]!.includes('--is-bare-repository'));
  assert.equal(calls.filter(args => args.includes('--stage')).length, 1);
  assert.ok(calls.find(args => args.includes('--stage'))!.includes('-v'));
  assert.ok(!calls.some(args => args.includes('--cached')));
  writeFileSync(join(root, 'tracked.txt'), 'changed\n');
  assert.notEqual(sourceIdentity(root), first); assert.equal(calls.length, 8);
});
test('framed identity preserves exact paths, raw bytes, executable modes, ignored and deleted semantics', t => {
  const root = fixture(t);
  writeFileSync(join(root, 'space λ.txt'), Buffer.from([0, 255, 127])); git(root, 'add', '--', 'space λ.txt');
  writeFileSync(join(root, 'untracked.txt'), 'new\n'); chmodSync(join(root, 'tracked.txt'), 0o755);
  mkdirSync(join(root, 'ignored')); writeFileSync(join(root, 'ignored', 'output'), 'ignored\n');
  const paths = ['.gitignore', 'space λ.txt', 'tracked.txt', 'untracked.txt'];
  const hash = createHash('sha256'), frame = (bytes: Buffer) => { hash.update(bytes.length + ':'); hash.update(bytes); };
  for (const path of paths) {
    frame(Buffer.from(path)); frame(Buffer.from(path === 'tracked.txt' ? '100755' : '100644')); frame(readFileSync(join(root, path)));
  }
  assert.equal(sourceIdentity(root), hash.digest('hex'));
  const baseline = sourceIdentity(root); rmSync(join(root, 'space λ.txt')); assert.notEqual(sourceIdentity(root), baseline);
  const deleted = sourceIdentity(root); writeFileSync(join(root, 'ignored', 'output'), 'different ignored\n'); assert.equal(sourceIdentity(root), deleted);
});
for (const flag of ['--assume-unchanged', '--skip-worktree']) {
  test('real hidden index flag rejects: ' + flag, t => {
    const root = fixture(t); git(root, 'update-index', flag, '--', 'tracked.txt');
    assert.throws(() => sourceIdentity(root), /Hidden index/);
  });
}
test('real conflict stages reject', t => {
  const root = fixture(t), blob = git(root, 'hash-object', 'tracked.txt').toString().trim();
  execute('git', ['update-index', '--index-info'], { cwd: root, env, input: '0 ' + '0'.repeat(40) + '\ttracked.txt\n100644 ' + blob + ' 1\ttracked.txt\n100644 ' + blob + ' 2\ttracked.txt\n' });
  assert.throws(() => sourceIdentity(root), /unresolved index/);
});
for (const metadata of ['H 120000', 'H 160000', 'H 100664', 'X 100644', 'H 100644']) {
  test('malformed stage/mode/tag rejected: ' + metadata, t => {
    const root = fixture(t), stage = metadata === 'H 100644' ? '2' : '0';
    staged(t, Buffer.from(metadata + ' ' + 'a'.repeat(40) + ' ' + stage + '\ttracked.txt\0'));
    assert.throws(() => sourceIdentity(root), /Symlink|unresolved index/);
  });
}
test('invalid UTF8 in staged paths fails before replacement-character alias can be read', t => {
  const root = fixture(t);
  writeFileSync(join(root, 'bad\uFFFD.txt'), 'would alias');
  staged(t, Buffer.concat([Buffer.from('H 100644 ' + 'a'.repeat(40) + ' 0\tbad'), Buffer.from([255]), Buffer.from('.txt\0')]));
  assert.throws(() => sourceIdentity(root), /non-UTF8/);
});
for (const path of ['../escape', '/absolute', 'a:b', 'line\nname', '.env.local']) {
  test('staged path boundary rejects: ' + JSON.stringify(path), t => {
    const root = fixture(t); staged(t, Buffer.from('H 100644 ' + 'a'.repeat(40) + ' 0\t' + path + '\0'));
    assert.throws(() => sourceIdentity(root), /Unsafe Git|Secret-bearing/);
  });
}
test('effective clean filters reject before index or source content inspection', t => {
  const root = fixture(t); git(root, 'config', 'filter.fixture.clean', 'never-execute');
  const calls = observe(t); assert.throws(() => sourceIdentity(root), /Git filters/);
  assert.ok(!calls.some(args => args.includes('ls-files')));
});
test('bare repositories remain unsupported', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'forgemind-bare-check-')));
  t.after(() => rmSync(root, { recursive: true, force: true })); git(root, 'init', '--bare');
  assert.throws(() => sourceIdentity(root));
});
test('snapshot npm allowlist and unsafe rejection remain intact', t => {
  const root = fixture(t); writeFileSync(join(root, '.npmrc'), 'ignore-scripts=true\naudit=true\n');
  const baseline = sourceIdentity(root); writeFileSync(join(root, '.npmrc'), 'audit=true\nignore-scripts=true\n');
  assert.notEqual(sourceIdentity(root), baseline);
  writeFileSync(join(root, '.npmrc'), 'registry=https://registry.npmjs.org/\n');
  assert.throws(() => sourceIdentity(root), /Unsafe public npm config/);
});
