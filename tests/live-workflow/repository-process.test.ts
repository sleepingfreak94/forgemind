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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  const originalRead = fs.default.readFileSync;
  let invalid = false, launches = 0, dispatches = 0, checks = 0;
  t.mock.method(fs.default, 'readFileSync', (...args: Parameters<typeof originalRead>) => {
    const result = Reflect.apply(originalRead, fs.default, args);
    if (String(args[0]) === realpathSync(process.execPath)) invalid = true;
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
