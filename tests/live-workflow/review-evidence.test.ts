import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { runTask } from '../../src/live-workflow/orchestrator.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../../src/live-workflow/validation.js';
import { snapshotCheckCommands, assertSameCheckCommands, checkEvidence, reviewInstructions } from '../../src/live-workflow/review-evidence.js';
import type { CheckCommand, LiveTask } from '../../src/live-workflow/contracts.js';
import type { CheckResult } from '../../src/live-workflow/checks.js';

const command = (id = 'check'): CheckCommand => ({
  id, executable: '/synthetic/node', args: ['--test', 'synthetic-private-token'], timeoutMs: 1000,
});
const result = (id = 'check'): CheckResult => ({
  id, passed: true, exitCode: 0, stdout: 'fixed synthetic output', stderr: '',
});
const artifact = (results: CheckResult[]) => Buffer.from(JSON.stringify(results, null, 2) + '\n');

test('executed command snapshot is detached and immutable, fingerprints omit raw argv', () => {
  const original = [command()], saved = snapshotCheckCommands(original);
  original[0]!.args[0] = '--changed'; original[0]!.timeoutMs = 5000;
  assert.equal(saved[0]!.args[0], '--test'); assert.equal(saved[0]!.timeoutMs, 1000);
  assert.ok(Object.isFrozen(saved)); assert.ok(Object.isFrozen(saved[0])); assert.ok(Object.isFrozen(saved[0]!.args));
  const evidence = checkEvidence('a'.repeat(64), saved, [result()], artifact([result()]));
  const text = JSON.stringify(evidence);
  assert.ok(!text.includes('synthetic-private-token')); assert.ok(!text.includes('/synthetic/node'));
  assert.ok(!text.includes('fixed synthetic output')); assert.equal(evidence.configuredChecks[0]!.id, 'check');
  assert.equal(evidence.configuredChecks[0]!.commandSha256, sha256(JSON.stringify(command())));
});

test('same check ID with changed args, executable or timeout is denied before candidate execution', () => {
  const baseline = snapshotCheckCommands([command()]);
  for (const patch of [{ args: ['--different'] }, { executable: '/different/node' }, { timeoutMs: 2000 }]) {
    let executed = false;
    assert.throws(() => {
      const candidate = snapshotCheckCommands([{ ...command(), ...patch }]);
      assertSameCheckCommands(baseline, candidate); executed = true;
    }, /commands changed/);
    assert.equal(executed, false);
  }
  assertSameCheckCommands(baseline, snapshotCheckCommands([command()]));
});

test('command order and count cannot be replaced by matching unordered IDs', () => {
  const before = snapshotCheckCommands([command('first'), command('second')]);
  assert.throws(() => assertSameCheckCommands(before, snapshotCheckCommands([command('second'), command('first')])), /commands changed/);
  assert.throws(() => assertSameCheckCommands(before, snapshotCheckCommands([command('first')])), /commands changed/);
});

test('source/result ID/order/count mismatch rejects evidence', () => {
  const commands = snapshotCheckCommands([command('first'), command('second')]);
  for (const results of [[result('second'), result('first')], [result('first')], [result('first'), result('wrong')]])
    assert.throws(() => checkEvidence('a'.repeat(64), commands, results, artifact(results)), /ordered result binding/);
  assert.throws(() => checkEvidence('invalid', [command()], [result()], artifact([result()])), /source/);
});

test('evidence hashes exact saved bytes, distinguishes sources/results, preserves artifact formatting hash', () => {
  const directory = mkdtempSync(join(tmpdir(), 'review-check-evidence-'));
  try {
    const commands = snapshotCheckCommands([command()]);
    const before = [{ ...result(), passed: false, exitCode: 1 }], after = [result()];
    const beforePath = join(directory, 'before-checks.json'), afterPath = join(directory, 'after-checks.json');
    writeFileSync(beforePath, artifact(before)); writeFileSync(afterPath, artifact(after));
    const b = checkEvidence('a'.repeat(64), commands, before, readFileSync(beforePath));
    const a = checkEvidence('b'.repeat(64), commands, after, readFileSync(afterPath));
    assert.equal(b.artifactSha256, sha256(readFileSync(beforePath)));
    assert.equal(a.artifactSha256, sha256(readFileSync(afterPath)));
    assert.notEqual(b.source, a.source); assert.notEqual(b.artifactSha256, a.artifactSha256);
    assert.equal(b.configuredChecks[0]!.commandSha256, a.configuredChecks[0]!.commandSha256);
    assert.notEqual(b.configuredChecks[0]!.resultSha256, a.configuredChecks[0]!.resultSha256);
    const compact = Buffer.from(JSON.stringify(after));
    assert.notEqual(checkEvidence(a.source, commands, after, compact).artifactSha256, a.artifactSha256);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('replaced artifact, malformed JSON or mismatching output is denied', () => {
  const commands = [command()], results = [result()];
  for (const bytes of [Buffer.from('not-json'), artifact([{ ...result(), stdout: 'changed' }]), artifact([])])
    assert.throws(() => checkEvidence('a'.repeat(64), commands, results, bytes), /Saved check artifact/);
});

test('draftPr:true review instruction remains byte-for-byte unchanged', () => {
  assert.equal(reviewInstructions(true),
    'You are the independent reviewer. You did not implement this candidate. Assess correctness, regressions, security, maintainability, policy and evidence. Return pass only if criteria are met; do not repair files. Report blocking findings as revise/blocked.');
});
test('local review explicitly keeps pending owner gates and candidate defect denials', () => {
  const instructions = reviewInstructions(false);
  assert.match(instructions, /pending mandatory ticket-completion gates/);
  assert.match(instructions, /Do not claim those gates passed, waive them/);
  assert.match(instructions, /blocking candidate defects/);
  assert.match(instructions, /use revise\/blocked when it is missing/);
  assert.match(instructions, /cannot require a prior verdict from itself/);
});


function pipelineFixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'review-evidence-pipeline-'))), repo = join(directory, 'repo');
  mkdirSync(repo); mkdirSync(join(directory, 'worktrees')); mkdirSync(join(repo, 'config'));
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: repo, encoding: 'utf8',
  });
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid'); git('remote', 'add', 'origin', 'https://github.com/fixture/project.git');
  writeFileSync(join(repo, 'config/forgemind-project.json'), JSON.stringify({
    schemaVersion: 1, projectId: 'fixture', name: 'Fixture',
    documents: { prd: 'docs/PRD.md', srs: 'docs/SRS.md', adrs: 'docs/adr' },
    preferences: { askAt: 'project', draftPr: false, evidence: 'text', planReview: 'show' },
  }));
  writeFileSync(join(repo, 'value.txt'), 'before'); git('add', '.'); git('commit', '-m', 'fixture');
  const task: LiveTask = {
    schemaVersion: 1, taskId: 'review-proof', objective: 'Change value to after', readPaths: ['value.txt'],
    writePaths: ['value.txt'], checks: [{ id: 'value', executable: realpathSync(process.execPath),
      args: ['-e', "const fs=require('fs');process.exit(fs.readFileSync('value.txt','utf8')==='after'?0:1)"], timeoutMs: 5000 }],
    model: 'fixture-model', effort: 'low', maxModelRequests: 3, maxPromptBytes: 65536,
    maxOutputBytes: 65536, maxRuntimeMs: 60000, draftPr: false,
  };
  return { directory, repo, task };
}
for (const decision of ['pass', 'revise', 'candidate-fails'] as const)
  test('actual fixture pipeline evidence and fail-closed gates / ' + decision, {
    skip: process.platform !== 'darwin', timeout: 90000,
  }, async () => {
    const f = pipelineFixture(); let calls = 0, reviewSeen = false;
    try {
      const running = runTask({
        workspace: f.repo, task: f.task, stateDirectory: join(f.directory, 'state'),
        worktreeDirectory: join(f.directory, 'worktrees'), codexExecutable: '/missing',
        confirmPlan: async () => true, modelFactory: () => ({ complete: async (instructions, rawInput) => {
          calls++;
          if (calls === 1) return { objective: f.task.objective, paths: ['value.txt'], steps: ['Change value'],
            acceptanceCriteria: ['Value is after'], risks: [] };
          if (calls === 2) return { summary: 'Change value', edits: [{ path: 'value.txt',
            beforeSha256: sha256('before'), content: decision === 'candidate-fails' ? 'wrong' : 'after' }] };
          reviewSeen = true;
          assert.match(instructions, /pending mandatory ticket-completion gates/);
          const input = rawInput as {
            baseline: string; candidate: string;
            checkEvidence: {
              baseline: ReturnType<typeof checkEvidence>; candidate: ReturnType<typeof checkEvidence>;
              baselineFiles: { path: string; sha256: string | null }[];
              candidateFiles: { path: string; sha256: string | null }[];
            };
          };
          const e = input.checkEvidence;
          assert.equal(e.baseline.source, input.baseline); assert.equal(e.candidate.source, input.candidate);
          assert.equal(e.baseline.configuredChecks[0]!.commandSha256, e.candidate.configuredChecks[0]!.commandSha256);
          assert.equal(e.baseline.artifactSha256, sha256(readFileSync(join(f.directory, 'state/artifacts/before-checks.json'))));
          assert.equal(e.candidate.artifactSha256, sha256(readFileSync(join(f.directory, 'state/artifacts/after-checks.json'))));
          assert.deepEqual(e.baselineFiles, [{ path: 'value.txt', sha256: sha256('before') }]);
          assert.deepEqual(e.candidateFiles, [{ path: 'value.txt', sha256: sha256('after') }]);
          return { verdict: decision, findings: decision === 'revise' ? ['Synthetic blocking finding'] : [], acceptance: ['Value checked'] };
        } }),
      });
      if (decision === 'pass') assert.equal((await running).status, 'completed-local');
      else await assert.rejects(running, decision === 'revise' ? /requires revision/ : /Candidate checks failed/);
      assert.equal(calls, decision === 'candidate-fails' ? 2 : 3);
      assert.equal(reviewSeen, decision !== 'candidate-fails');
      assert.equal(readFileSync(join(f.repo, 'value.txt'), 'utf8'), 'before');
    } finally { rmSync(f.directory, { recursive: true, force: true }); }
  });
