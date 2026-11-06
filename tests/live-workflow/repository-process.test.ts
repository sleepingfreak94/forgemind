import test from 'node:test';
import childProcess from 'node:child_process';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryProcess, authorizedRepositoryProcess, withRepositoryBudget } from '../../src/live-workflow/repository-process.js';

test(
  'repository command deadline terminates a hung executable and its descendant',
  { timeout: 10000 },
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'fm-git-timeout-'))),
      bin = join(root, 'bin');
    mkdirSync(bin);
    const fixture = `#!${realpathSync(process.execPath)}\nconst fs=require('fs');fs.writeFileSync('parent.pid',String(process.pid));const c=require('child_process').spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},100)'],{stdio:'ignore'});fs.writeFileSync('child.pid',String(c.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},100);\n`;
    writeFileSync(join(bin, 'gh'), fixture, { mode: 0o700 });
    try {
      // Allow process startup under the full parallel suite, then verify the
      // supervisor still kills the intentionally hung process tree within its bound.
      const start = Date.now();
      assert.throws(
        () =>
          withRepositoryBudget({ deadline: start + 3000 }, () =>
            repositoryProcess('gh', [], root, { PATH: bin }),
          ),
        /timed out|Command failed/,
      );
      assert.ok(Date.now() - start < 6500);
      assert.ok(existsSync(join(root, 'child.pid')), 'fixture reached descendant creation');
      for (const file of ['parent.pid', 'child.pid']) {
        const pid = Number(readFileSync(join(root, file), 'utf8'));
        let alive = true;
        for (let i = 0; i < 50; i++) {
          try {
            process.kill(pid, 0);
          } catch (error) {
            assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH');
            alive = false;
            break;
          }
          await new Promise((r) => setTimeout(r, 20));
        }
        assert.equal(alive, false, 'process must be reaped: ' + file);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
test('exhausted repository scope refuses launch', () => {
  assert.throws(
    () =>
      withRepositoryBudget({ deadline: Date.now() - 1 }, () =>
        repositoryProcess('gh', [], process.cwd(), {}),
      ),
    /deadline exhausted/,
  );
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () =>
      withRepositoryBudget({ deadline: Date.now() + 1000, signal: controller.signal }, () =>
        repositoryProcess('gh', [], process.cwd(), {}),
      ),
    /abort/i,
  );
});

test('deadline consumed by executable validation prevents launch instead of extending the grant', t => {
  const times=[1000,1000,1200];
  t.mock.method(Date,'now',()=>times.shift()??1200);
  let launches=0;
  t.mock.method(childProcess,'execFileSync',()=>{launches++;throw new Error('must not launch');});
  assert.throws(()=>withRepositoryBudget({deadline:1100},()=>repositoryProcess('gh',[],process.cwd(),{})),/deadline exhausted during executable validation/);
  assert.equal(launches,0);
});

for (const failure of ['expired', 'revoked', 'fenced']) test(`protected repository launch rechecks async authority after pinning: ${failure}`, async t => {
  const fs = await import('node:fs');
  const { syncBuiltinESMExports } = await import('node:module');
  // The runtime pin is cached, but its identity is re-checked (realpath + lstat) before every command.
  const originalRealpath = fs.default.realpathSync;
  let invalid = false, launches = 0, dispatches = 0, checks = 0;
  t.mock.method(fs.default, 'realpathSync', (...args: Parameters<typeof originalRealpath>) => {
    const result = Reflect.apply(originalRealpath, fs.default, args);
    if (String(args[0]) === process.execPath) invalid = true;
    return result;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  t.mock.method(childProcess, 'execFileSync', () => { launches++; return Buffer.from('unexpected'); });
  await assert.rejects(withRepositoryBudget({ deadline: Date.now() + 5000 }, () =>
    authorizedRepositoryProcess('git', ['push'], process.cwd(), {}, async () => {
      checks++; await Promise.resolve(); if (invalid) throw new Error(failure);
    }, () => { dispatches++; })), new RegExp(failure));
  assert.equal(checks, 1); assert.equal(invalid, true);
  assert.equal(launches, 0); assert.equal(dispatches, 0);
});

test('a pinned runner whose identity changes is pinned afresh instead of refusing every later command', async t => {
  const fs = await import('node:fs');
  const { syncBuiltinESMExports } = await import('node:module');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fm-repository-pin-')));
  const runner = realpathSync(fileURLToPath(new URL('../../src/live-workflow/repository-supervisor.js', import.meta.url)));
  const env = { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  assert.match(repositoryProcess('git', ['--version'], root, env).toString(), /^git version/);
  // Report one changed mtime for the runner in-process; touching the shared file would race other test processes.
  const originalLstat = fs.default.lstatSync, originalRead = fs.default.readFileSync;
  let changed = false, hashes = 0;
  t.mock.method(fs.default, 'lstatSync', (...args: Parameters<typeof originalLstat>) => {
    const stat = Reflect.apply(originalLstat, fs.default, args) as BigIntStats;
    if (changed || String(args[0]) !== runner || !(args[1] as { bigint?: boolean } | undefined)?.bigint) return stat;
    changed = true;
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { mtimeNs: stat.mtimeNs + 1n });
  });
  t.mock.method(fs.default, 'readFileSync', (...args: Parameters<typeof originalRead>) => {
    if (String(args[0]) === runner) hashes++;
    return Reflect.apply(originalRead, fs.default, args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true }); });
  assert.match(repositoryProcess('git', ['--version'], root, env).toString(), /^git version/);
  assert.equal(changed, true);
  assert.equal(hashes, 1, 'the changed runner is hashed again once');
});

test('a pinned command path runs instead of a PATH lookup, and only for a file named like the command', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fm-repository-path-')));
  try {
    const git = realpathSync(childProcess.execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim());
    assert.match(repositoryProcess('git', ['--version'], root, { PATH: '/nonexistent' }, git).toString(), /^git version/);
    assert.throws(() => repositoryProcess('git', ['--version'], root, { PATH: '/usr/bin:/bin' }, '/bin/ls'), /Invalid repository command/);
    assert.throws(() => repositoryProcess('git', ['--version'], root, { PATH: '/usr/bin:/bin' }, 'git'), /Invalid repository command/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('protected repository launch rechecks budget after awaited authority decision', async t => {
  let now = 1000, launches = 0, dispatches = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(childProcess, 'execFileSync', () => { launches++; return Buffer.from('unexpected'); });
  await assert.rejects(withRepositoryBudget({ deadline: 2000 }, () =>
    authorizedRepositoryProcess('git', ['push'], process.cwd(), {}, async () => {
      await Promise.resolve(); now = 2001;
    }, () => { dispatches++; })), /deadline exhausted/);
  assert.equal(launches, 0); assert.equal(dispatches, 0);
});
