// Synthetic source/model/report fixtures only; no browser, provider or authentication.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../../src/live-workflow/validation.js';
import type { RunOptions } from '../../src/live-workflow/orchestrator.js';
import type { BrowserQaRequest, BrowserQaReport } from '../../src/live-workflow/browser-qa.js';
export function report(request: Readonly<BrowserQaRequest>): BrowserQaReport {
  return { version: 1, phase: request.phase, workspace: request.workspace, taskId: request.task.taskId,
    scenarioId: request.scenarioId, baselineSource: request.baselineSource, currentSource: request.currentSource,
    requestId: request.requestId, startedAt: Date.now(), completedAt: Date.now(),
    checks: [375, 1280].map(viewportWidth => ({ id: 'value', viewportWidth, passed: request.phase === 'candidate',
      detail: 'Synthetic report fixture; no browser observation' })) };
}
export function browserQaFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fm-browser-qa-fixture-'))), workspace = join(root, 'repo');
  mkdirSync(workspace); mkdirSync(join(workspace, 'config')); mkdirSync(join(root, 'worktrees'));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: workspace, encoding: 'utf8' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('remote', 'add', 'origin', 'https://github.com/fixture/project.git');
  writeFileSync(join(workspace, 'config/forgemind-project.json'), JSON.stringify({ schemaVersion: 1, projectId: 'fixture', name: 'Fixture',
    documents: { prd: 'docs/PRD.md', srs: 'docs/SRS.md', adrs: 'docs/adr' },
    preferences: { askAt: 'project', draftPr: false, evidence: 'text', planReview: 'auto' } }));
  writeFileSync(join(workspace, 'value.txt'), 'before'); git('add', '.'); git('commit', '-m', 'synthetic fixture baseline');
  const options: RunOptions = { workspace, stateDirectory: join(root, 'state'), worktreeDirectory: join(root, 'worktrees'),
    codexExecutable: '/missing', confirmPlan: async () => false,
    task: { schemaVersion: 1, taskId: 'browser-fixture', objective: 'Change value to after', readPaths: ['value.txt'], writePaths: ['value.txt'],
      checks: [{ id: 'value', executable: realpathSync(process.execPath),
        args: ['-e', "process.exit(require('fs').readFileSync('value.txt','utf8')==='after'?0:1)"], timeoutMs: 5000 }],
      model: 'fixture', effort: 'low', maxModelRequests: 3, maxPromptBytes: 262144, maxOutputBytes: 65536, maxRuntimeMs: 60000, draftPr: false } };
  const outputs = [
    { objective: options.task.objective, paths: ['value.txt'], steps: ['Fix value'], acceptanceCriteria: ['Value is after'], risks: [] },
    { summary: 'Correct value', edits: [{ path: 'value.txt', beforeSha256: sha256('before'), content: 'after' }] },
    { verdict: 'pass', findings: [], acceptance: ['Value is after'] },
  ];
  return { root, workspace, options, outputs, git, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
