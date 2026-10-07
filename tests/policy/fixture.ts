import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { LocalPolicyRuntime } from '../../src/policy/runtime.js';
import type { ActionRequest, GrantInput } from '../../src/policy/contracts.js';

export function fixture(t: TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'forgemind-policy-')));
  const workspaceRoot = join(base, 'workspace');
  mkdirSync(workspaceRoot);
  mkdirSync(join(workspaceRoot, 'src'));
  let time = 1000;
  let snapshot = 'sha256:fixture-v1';
  let id = 0;
  const options = {
    stateDirectory: join(base, 'state'), workspaceRoot, repositoryId: 'repo:fixture',
    clock: () => time, newId: () => `id-${++id}`, sourceSnapshot: () => snapshot,
  };
  let runtime = LocalPolicyRuntime.open(options);
  t.after(() => { runtime.close(); rmSync(base, { recursive: true, force: true }); });
  const grant = (overrides: Partial<GrantInput> = {}) => runtime.issueGrant({
    taskId: 'ticket-1', invocationId: 'coder-1', role: 'coder',
    capabilities: [{ action: 'file.write', resource: 'src/example.ts' }],
    expiresAt: 10000, remainingDepth: 2, maxActions: 10, maxChildren: 4, ...overrides,
  });
  const request = (overrides: Partial<ActionRequest> = {}): ActionRequest => ({
    requestId: `request-${++id}`, action: 'file.write', resource: 'src/example.ts',
    sourceSnapshot: snapshot, content: 'export const value = 1;', ...overrides,
  });
  return {
    base, workspaceRoot, options, grant, request,
    get runtime() { return runtime; },
    setTime(value: number) { time = value; },
    setSnapshot(value: string) { snapshot = value; },
    reopen() { runtime.close(); runtime = LocalPolicyRuntime.open(options); return runtime; },
  };
}
