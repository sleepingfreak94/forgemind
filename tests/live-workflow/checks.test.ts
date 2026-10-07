import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { runChecks } from '../../src/live-workflow/checks.js';
import type { ActionAuthority } from '../../src/live-workflow/contracts.js';

test(
  'checks deny secrets, source writes, process forks and local network; scratch remains writable',
  { skip: process.platform !== 'darwin', timeout: 30000 },
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'fm-checks-'))),
      repo = join(root, 'repo');
    mkdirSync(repo);
    writeFileSync(join(repo, '.env'), 'fixture-secret');
    writeFileSync(join(repo, 'value.txt'), 'original');
    const statuses: string[] = [];
    const authority: ActionAuthority = {
      reserve: () => ({
        check: () => {},
        finish: (status) => {
          statuses.push(status);
        },
      }),
    };
    const server = createServer((socket) => socket.end());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const code = `const fs=require('fs'),assert=require('assert/strict');assert.equal(process.env.FORGEMIND_SECRET,undefined);assert.throws(()=>fs.readFileSync('.env'));assert.throws(()=>fs.writeFileSync('value.txt','bad'));fs.writeFileSync(process.env.HOME+'/allowed','ok');assert.throws(()=>require('child_process').execFileSync('/usr/bin/true'));const s=require('net').connect(${address.port},'127.0.0.1');s.on('connect',()=>process.exit(9));s.on('error',()=>process.exit(0));setTimeout(()=>process.exit(8),2000);`;
    process.env.FORGEMIND_SECRET = 'fixture';
    try {
      const [result] = await runChecks(
        repo,
        'a'.repeat(64),
        [{ id: 'deny', executable: realpathSync(process.execPath), args: ['-e', code], timeoutMs: 6000 }],
        root,
        authority,
        AbortSignal.timeout(20000),
      );
      assert.equal(result?.passed, true, result?.stderr ?? 'no check result');
      assert.equal(readFileSync(join(repo, 'value.txt'), 'utf8'), 'original');
      assert.deepEqual(statuses, ['completed']);
    } finally {
      delete process.env.FORGEMIND_SECRET;
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'check timeout reaps the worker and records indeterminate completion',
  { skip: process.platform !== 'darwin', timeout: 15000 },
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'fm-check-timeout-'))),
      repo = join(root, 'repo');
    mkdirSync(repo);
    const statuses: string[] = [];
    try {
      await assert.rejects(
        runChecks(
          repo,
          'a'.repeat(64),
          [
            {
              id: 'timeout',
              executable: realpathSync(process.execPath),
              args: ['-e', 'setInterval(()=>{},100)'],
              timeoutMs: 150,
            },
          ],
          root,
          {
            reserve: () => ({
              check: () => {},
              finish: (s) => {
                statuses.push(s);
              },
            }),
          },
          AbortSignal.timeout(10000),
        ),
        /Deadline|deadline/,
      );
      assert.deepEqual(statuses, ['indeterminate']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
