import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repositoryProcess, withRepositoryBudget } from '../../src/live-workflow/repository-process.js';

for (const detached of [false, true]) test(`repository supervisor bounds inherited output pipe: escaped=${detached}`,
  { timeout: 15000 }, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'fm-repository-pipe-'))), bin = join(root, 'bin');
    mkdirSync(bin, { mode: 0o700 });
    // Independent ten-second fixture deadline contains a failed owner/test cleanup.
    const childCode = 'setTimeout(()=>process.exit(0),10000)';
    const fixture = `#!${realpathSync(process.execPath)}\nconst fs=require('fs');const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{detached:${detached},stdio:['ignore',process.stdout,process.stderr]});fs.writeFileSync('holder.pid',String(c.pid));process.stdout.write('fixture-command-completed\\n');process.exit(0);\n`;
    writeFileSync(join(bin, 'gh'), fixture, { mode: 0o700 });
    let holder: number | undefined;
    try {
      const start = Date.now();
      let result: Buffer | undefined, failure: unknown;
      try { result = withRepositoryBudget({ deadline: start + 3000 }, () => repositoryProcess('gh', [], root, { PATH: bin })); }
      catch (error) { failure = error; }
      holder = Number(readFileSync(join(root, 'holder.pid'), 'utf8'));
      assert.ok(Number.isSafeInteger(holder) && holder > 0);
      assert.ok(Date.now() - start < 4500, 'supervisor terminates before the outer cleanup watchdog');
      if (!detached) {
        assert.equal(failure, undefined);
        assert.equal(result?.toString(), 'fixture-command-completed\n');
      } else {
        assert.ok(failure instanceof Error);
        const error = failure as Error & { code?: string; status?: number; stdout?: Buffer; stderr?: Buffer };
        assert.notEqual(error.code, 'ETIMEDOUT', 'owner watchdog must not be the terminal mechanism');
        assert.equal(error.status, 124);
        assert.equal(error.stdout?.toString(), 'fixture-command-completed\n');
        const diagnostic = error.stderr?.toString().split('\n').find(line => line.startsWith('Repository diagnostic: '));
        assert.ok(diagnostic);
        assert.deepEqual(JSON.parse(diagnostic.slice('Repository diagnostic: '.length)),
          { reason: 'deadline', childExited: true, outputBytes: 26 });
        // Fixture ownership comes from our spawned script and private PID artifact,
        // never from a production task PID or a grant inferred from this number.
        assert.doesNotThrow(() => process.kill(holder!, 0));
      }
    } finally {
      if (detached && holder) {
        try { process.kill(-holder, 'SIGKILL'); }
        catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH'); }
        for (let i = 0; i < 50; i++) {
          try { process.kill(holder, 0); }
          catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH'); break; }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
