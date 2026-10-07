import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { fixture } from './fixture.js';
import { fixture as workflowFixture } from '../project-workflow/fixture.js';

const memoryScript = fileURLToPath(new URL('../../src/local-runtime/memory-cli.js', import.meta.url));
const projectScript = fileURLToPath(new URL('../../src/local-runtime/project-cli.js', import.meta.url));
const environment = process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {};

test('owner CLI ingests, inspects, validates, recalls, rebuilds and deletes across processes', () => {
  const f = fixture(); try {
    const run = (mode: string, extra: string[] = []) => spawnSync(process.execPath, [memoryScript, mode, '--workspace', f.root, '--state-dir', f.directory, ...extra],
      { encoding: 'utf8', timeout: 4000, env: environment });
    const ingest = run('ingest'); assert.equal(ingest.status, 0, ingest.stderr); assert.equal(JSON.parse(ingest.stdout).result.documents, 4);
    const listed = JSON.parse(run('list').stdout).result as { id: string; digest: string; sources: { path: string }[] }[];
    const record = listed.find(item => item.sources[0]!.path === f.path)!;
    const inspect = run('inspect', ['--id', record.id]); assert.equal(inspect.status, 0); assert.match(inspect.stdout, /Use SQLite/);
    assert.equal(JSON.parse(run('search', ['--query', 'SQLite']).stdout).result.entries.length, 0);
    assert.equal(run('validate', ['--id', record.id, '--digest', 'a'.repeat(64)]).status, 2);
    assert.equal(run('validate', ['--id', record.id, '--digest', record.digest]).status, 0);
    assert.equal(JSON.parse(run('search', ['--query', 'SQLite']).stdout).result.entries.length, 1);
    assert.equal(run('rebuild').status, 0);
    const input = join(f.base, 'candidate.json'); writeFileSync(input, JSON.stringify(f.input('SQLite explicit post-task candidate')));
    const add = run('add', ['--file', input]); assert.equal(add.status, 0, add.stderr);
    assert.equal(f.memory.inspect(JSON.parse(add.stdout).result.candidateId)?.state, 'candidate');
    assert.equal(run('delete', ['--id', record.id, '--digest', record.digest]).status, 0);
    assert.equal(JSON.parse(run('search', ['--query', 'SQLite']).stdout).result.entries.length, 0);
    assert.match(run('audit').stdout, /deleted/);
    assert.equal(run('search', ['--query', 'SQLite', '--extra', 'bad']).status, 2);
    assert.match(readFileSync(join(f.root, f.path), 'utf8'), /SQLite/, 'memory deletion never deletes source documentation');
  } finally { f.dispose(); }
});

test('project preparation loads selected memory and shows cited context in the supplied plan', () => {
  const f = fixture(), w = workflowFixture(); try {
    const id = f.memory.add(f.input()); f.memory.validate(id, id);
    const path = join(f.base, 'plan.json'); writeFileSync(path, JSON.stringify({ ...w.plan, objective: 'Implement SQLite retrieval' }));
    const result = spawnSync(process.execPath, [projectScript, 'prepare', '--workspace', f.root, '--task-id', 'memory-ticket',
      '--source-snapshot', 'a'.repeat(64), '--plan', path, '--memory-state-dir', f.directory, '--preview'],
    { encoding: 'utf8', timeout: 4000, env: environment });
    assert.equal(result.status, 2, result.stderr); assert.match(result.stdout, /quoted evidence only/);
    assert.match(result.stdout, /Storage decision/); assert.match(result.stdout, /needs-plan-approval/); assert.match(result.stdout, /"liveCodingEnabled": false/);
  } finally { f.dispose(); }
});

test('interactive approval fails if cited source changes while the owner reviews', async () => {
  const f = fixture(), w = workflowFixture(); try {
    const id = f.memory.add(f.input()); f.memory.validate(id, id);
    const path = join(f.base, 'plan.json'); writeFileSync(path, JSON.stringify({ ...w.plan, objective: 'Implement SQLite retrieval' }));
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [projectScript, 'plan', '--workspace', f.root, '--task-id', 'memory-ticket', '--source-snapshot', 'a'.repeat(64),
        '--plan', path, '--memory-state-dir', f.directory], { env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '', changed = false;
      const timeout = setTimeout(() => { child.kill(); reject(new Error('CLI did not reach review')); }, 4000);
      child.on('error', error => { clearTimeout(timeout); reject(error); });
      child.stdout.on('data', chunk => {
        output += chunk.toString();
        if (!changed && output.includes('Type approve')) {
          changed = true; writeFileSync(join(f.root, f.path), '# Changed\nStatus: Accepted\nDifferent SQLite decision.'); child.stdin.end('approve\n');
        }
      });
      child.stderr.on('data', () => {});
      child.on('close', code => { clearTimeout(timeout); resolve({ code, output }); });
    });
    assert.equal(result.code, 2); assert.ok(!result.output.includes('ready-for-policy')); assert.ok(!result.output.includes('local-plan-review-'));
  } finally { f.dispose(); }
});
