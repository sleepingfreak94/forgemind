import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { profilePath } from '../../src/project-workflow/project.js';
import { fixture } from './fixture.js';

test('CLI onboarding remembers choices; preview shows plan and cannot approve or execute it', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'forgemind-cli-'))); t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = fixture(), config = join(root, 'preferences.json'), input = join(root, 'plan.json');
  writeFileSync(config, JSON.stringify(f.profile.preferences)); writeFileSync(input, JSON.stringify(f.plan));
  const script = fileURLToPath(new URL('../../src/local-runtime/project-cli.js', import.meta.url));
  const run = (args: string[], stdin = '') => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', input: stdin, timeout: 2000,
    env: process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {} });
  const setup = run(['init', '--workspace', root, '--project-id', f.profile.projectId, '--preferences', config, '--new']); assert.equal(setup.status, 0, setup.stderr);
  const saved = readFileSync(join(root, profilePath), 'utf8');
  const again = run(['init', '--workspace', root]); assert.equal(again.status, 0); assert.equal(JSON.parse(again.stdout).reused, true);
  assert.equal(readFileSync(join(root, profilePath), 'utf8'), saved);
  const args = ['plan', '--workspace', root, '--task-id', 'ticket', '--source-snapshot', 'a'.repeat(64), '--plan', input];
  const preview = run([...args, '--preview']); assert.equal(preview.status, 2); assert.match(preview.stdout, /Implementation plan/); assert.match(preview.stdout, /needs-plan-approval/);
  assert.match(preview.stdout, /"liveCodingEnabled": false/);
  const show = run([...args, '--preview', '--plan-review', 'show', '--draft-pr', 'no', '--evidence', 'text']);
  assert.equal(show.status, 0, show.stderr); assert.match(show.stdout, /ready-for-policy/); assert.match(show.stdout, /"liveCodingEnabled": false/);
  assert.equal(readFileSync(join(root, profilePath), 'utf8'), saved);
  const eof = run(args); assert.equal(eof.status, 2); assert.ok(!eof.stdout.includes('ready-for-policy'));
  const approved = run(args, 'approve\n'); assert.equal(approved.status, 0, approved.stderr); assert.match(approved.stdout, /local-plan-review-/);
  const denied = run(args, 'no\n'); assert.equal(denied.status, 2); assert.match(denied.stdout, /needs-plan-approval/);
  assert.equal(existsSync(join(root, 'src', 'example.ts')), false);
});

test('every-task prompts preserve explicit flags and ask only unanswered choices', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'forgemind-task-prompts-'))); t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = fixture(); f.profile.preferences.askAt = 'task';
  const config = join(root, 'preferences.json'), input = join(root, 'plan.json'); writeFileSync(config, JSON.stringify(f.profile.preferences)); writeFileSync(input, JSON.stringify(f.plan));
  const script = fileURLToPath(new URL('../../src/local-runtime/project-cli.js', import.meta.url));
  const run = (args: string[], answer = '') => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', input: answer, timeout: 2000,
    env: process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {} });
  assert.equal(run(['init', '--workspace', root, '--project-id', f.profile.projectId, '--preferences', config]).status, 0);
  const result = run(['plan', '--workspace', root, '--task-id', 'ticket', '--source-snapshot', 'a'.repeat(64), '--plan', input, '--draft-pr', 'no', '--evidence', 'text'], 'show\n');
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /"draftPr":false/);
  assert.ok(!result.stdout.includes('Create a draft PR when complete?')); assert.ok(!result.stdout.includes('Before/after evidence ('));
  assert.equal(JSON.parse(readFileSync(join(root, profilePath), 'utf8')).preferences.draftPr, true);
});

test('prepare onboards an unfamiliar project and auto mode keeps only that plan quiet', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'forgemind-auto-project-'))); t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = fixture(), config = join(root, 'preferences.json'), input = join(root, 'plan.json');
  writeFileSync(config, JSON.stringify({ ...f.profile.preferences, planReview: 'auto' })); writeFileSync(input, JSON.stringify(f.plan));
  const script = fileURLToPath(new URL('../../src/local-runtime/project-cli.js', import.meta.url));
  const run = (extra: string[]) => spawnSync(process.execPath, [script, 'prepare', '--workspace', root, '--project-id', f.profile.projectId, '--task-id', 'ticket',
    '--source-snapshot', 'a'.repeat(64), '--plan', input, ...extra], { encoding: 'utf8', input: '', timeout: 2000,
    env: process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {} });
  const invalid = run(['--preferences', config, '--new', '--evidence', 'invalid']); assert.equal(invalid.status, 2); assert.equal(existsSync(join(root, profilePath)), false);
  const first = run(['--preferences', config, '--new']); assert.equal(first.status, 0, first.stderr); assert.match(first.stdout, /"planVisible": false/);
  assert.ok(!first.stdout.includes(f.plan.objective)); assert.match(first.stdout, /"liveCodingEnabled": false/); assert.match(first.stdout, /ready-for-policy/);
  const reused = run([]); assert.equal(reused.status, 0, reused.stderr); assert.match(reused.stdout, /"reused": true/);
  const preview = run(['--preview']); assert.equal(preview.status, 0); assert.ok(preview.stdout.includes(f.plan.objective));
});
