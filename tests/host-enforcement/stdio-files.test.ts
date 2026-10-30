import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The Windows Cursor stdio shim (ADR-0017 phase 2b) must keep every child_process contract Cursor relies on. It is plain
// Node, so it runs on every platform; inside an AppContainer it is what keeps spawn off libuv pipes.
const shim = fileURLToPath(new URL('../../../src/host-enforcement/windows/stdio-files.cjs', import.meta.url));
const child = (code: string) => JSON.stringify(code);

test('the stdio shim keeps spawn, execFile, exec and the sync calls working through files', t => {
  const node = JSON.stringify(process.execPath);
  const script = `const cp = require('child_process'), out = {};
    const run = (code) => [${node}, ['-e', code]];
    const s = cp.spawn(...run(${child("process.stdout.write('out'); process.stderr.write('err'); process.exit(3)")}));
    let so = '', se = ''; s.stdout.on('data', d => so += d); s.stderr.on('data', d => se += d);
    s.on('close', code => {
      out.spawn = [so, se, code];
      cp.execFile(...run(${child("console.log('via execFile')")}), { encoding: 'utf8' }, (error, stdout) => {
        out.execFile = [error, stdout];
        cp.execFile('forgemind-no-such-binary', [], error => {
          out.missing = error.code;
          out.execFileSync = cp.execFileSync(...run(${child("process.stdin.pipe(process.stdout)")}), { input: 'fed', encoding: 'utf8' });
          try { cp.execFileSync(...run(${child("process.stderr.write('bad'); process.exit(4)")}), { stdio: ['ignore', 'pipe', 'pipe'] }); }
          catch (e) { out.failed = [e.status, String(e.stderr)]; }
          const r = cp.spawnSync(...run(${child("console.log('a'); console.error('b')")}), { encoding: 'utf8' });
          out.spawnSync = [r.status, r.stdout, r.stderr];
          out.syncMissing = cp.spawnSync('forgemind-no-such-binary').error.code;
          try { cp.execFileSync('forgemind-no-such-binary'); } catch (e) { out.execSyncMissing = e.code; }
          try { cp.fork('x'); } catch (e) { out.fork = e.message.startsWith('stdio-files:'); }
          const lost = cp.spawn('forgemind-no-such-binary'); lost.on('error', e => { out.lostError = e.code; });
          lost.on('close', code => {
            out.lostClose = typeof code === 'number' && code < 0;
            const quiet = cp.spawn(...run('0')); quiet.on('close', code => { out.unread = code; console.log(JSON.stringify(out)); });
          });
        });
      });
    });`;
  // The shim writes to os.tmpdir() (in the container, Windows sets TEMP to its AC\\Temp); a private TEMP isolates this run.
  const scratch = mkdtempSync(join(tmpdir(), 'fm-stdio-test-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  // A leftover of a dead process (a killed run) is removed at preload.
  writeFileSync(join(scratch, 'fm-stdio-999999-0-00-1'), 'other run');
  // A file, not `-e`: Windows refuses to start a process whose long inline script looks like this one (EPERM).
  const program = join(mkdtempSync(join(tmpdir(), 'fm-stdio-program-')), 'probe.cjs');
  writeFileSync(program, script);
  t.after(() => rmSync(dirname(program), { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['-r', shim, program], { encoding: 'utf8', timeout: 60000,
    env: { ...process.env, TEMP: scratch, TMP: scratch, TMPDIR: scratch } });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  assert.deepEqual(JSON.parse(result.stdout), {
    spawn: ['out', 'err', 3], execFile: [null, 'via execFile\n'], missing: 'ENOENT', execFileSync: 'fed',
    failed: [4, 'bad'], spawnSync: [0, 'a\n', 'b\n'], syncMissing: 'ENOENT', execSyncMissing: 'ENOENT', fork: true, lostError: 'ENOENT', lostClose: true, unread: 0,
  });
  assert.deepEqual(readdirSync(scratch), [], 'temp files are removed');
});
