import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { readPublicNpmConfig } from '../../src/live-workflow/npm-config.js';
import { captureTicketDiff, createTaskWorktree, discoverRepository, sourceIdentity } from '../../src/live-workflow/repository.js';

function fixture(t: TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'fm-public-npm-'))), root = join(base, 'source');
  mkdirSync(root); mkdirSync(join(root, 'backend'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: root, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('remote', 'add', 'origin', 'https://github.com/fixture/project.git');
  writeFileSync(join(root, 'source.txt'), 'baseline\n');
  writeFileSync(join(root, 'backend/.npmrc'), 'ignore-scripts=true\naudit=true\n');
  git('add', '.'); git('commit', '-m', 'baseline');
  return { base, root, git, config: join(root, 'backend/.npmrc') };
}

test('REBOS boolean npm config is included in source identity and isolated checkout, without enabling config edits', t => {
  const f = fixture(t), identity = sourceIdentity(f.root), info = discoverRepository(f.root);
  const actions: string[] = [];
  const checkout = createTaskWorktree(info, 'npm-config', f.base, action => { actions.push(action.args.join(' ')); });
  assert.equal(sourceIdentity(checkout.root), identity);
  assert.equal(readFileSync(join(checkout.root, 'backend/.npmrc'), 'utf8'), 'ignore-scripts=true\naudit=true\n');
  assert.equal(actions.length, 1);
  writeFileSync(join(checkout.root, 'source.txt'), 'candidate\n');
  assert.deepEqual(captureTicketDiff(checkout.root, info.head, ['source.txt']).paths, ['source.txt']);
  assert.throws(() => captureTicketDiff(checkout.root, info.head, ['backend/.npmrc']), /Secret-bearing/);
  writeFileSync(f.config, 'audit=true\n');
  assert.notEqual(sourceIdentity(f.root), identity, 'config bytes must remain source-bound');
});

test('unsafe npm config fails before worktree authorization and never exposes its contents', t => {
  const f = fixture(t);
  writeFileSync(f.config, '//registry.npmjs.org/:_authToken=fixture-secret\n');
  f.git('add', '.'); f.git('commit', '-m', 'unsafe fixture');
  let authorized = false;
  assert.throws(() => createTaskWorktree(discoverRepository(f.root), 'blocked', f.base, () => { authorized = true; }),
    error => error instanceof Error && /npm config/.test(error.message) && !error.message.includes('fixture-secret'));
  assert.equal(authorized, false);
});

test('npm config exception cannot admit secret parent directories, symlinks or hardlinks', t => {
  const f = fixture(t);
  rmSync(f.config); symlinkSync('../source.txt', f.config);
  assert.throws(() => sourceIdentity(f.root), /Symlink/);
  rmSync(f.config); linkSync(join(f.root, 'source.txt'), f.config);
  assert.throws(() => sourceIdentity(f.root), /npm config/);
  rmSync(f.config); writeFileSync(f.config, 'audit=true\n');
  mkdirSync(join(f.root, '.aws')); writeFileSync(join(f.root, '.aws/.npmrc'), 'audit=true\n');
  assert.throws(() => sourceIdentity(f.root), /Secret-bearing/);
});

test('public npm config accepts only bounded, unique security settings and preserves exact bytes', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fm-npm-parser-'))), path = join(root, '.npmrc');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const content of ['ignore-scripts=true\naudit=true\n', '\t audit = true \r\n', 'audit=true\n' + ' '.repeat(4085)]) {
    writeFileSync(path, content); assert.deepEqual(readPublicNpmConfig(path), Buffer.from(content));
  }
  for (const content of ['', 'audit=false\n', 'ignore-scripts=false\n', 'audit=true\naudit=true\n',
    'fund=true\n', 'registry=https://example.invalid\n', '//example.invalid/:_authToken=fixture-secret\n',
    '_auth=fixture-secret\n', 'audit=${TOKEN}\n', '# fixture-secret\naudit=true\n',
    'audit=true #comment\n', 'AUDIT=true\n', '\ufeffaudit=true\n', 'audit=true\u0000\n',
    'audit=true\n' + ' '.repeat(4086), Buffer.from([0xff])]) {
    writeFileSync(path, content);
    assert.throws(() => readPublicNpmConfig(path), /^Error: Unsafe public npm config$/);
  }
});
