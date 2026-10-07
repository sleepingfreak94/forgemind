import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import type { CodexIntent } from '../../src/agent-drivers/contracts.js';
import { LocalPolicyRuntime } from '../../src/policy/runtime.js';
import { prepareHostPlan, hostResource } from '../../src/host-enforcement/manifest.js';
import { OfflineSeatbeltHost } from '../../src/host-enforcement/host.js';
import { snapshotWorkspace } from '../../src/host-enforcement/workspace.js';

/** Test-only discovery of exact Node dylibs. Production plans supply explicit files. */
let cachedRuntimeFiles: string[] | undefined;
export function nodeRuntimeFiles(): string[] {
  if (cachedRuntimeFiles) return [...cachedRuntimeFiles];
  const found = new Set<string>();
  const visit = (file: string) => {
    const canonical = realpathSync(file);
    if (found.has(canonical) || canonical.startsWith('/usr/lib/') || canonical.startsWith('/System/Library/')) return;
    found.add(canonical);
    const lines = execFileSync('/usr/bin/otool', ['-L', canonical], { encoding: 'utf8' }).split('\n').slice(1);
    for (const line of lines) {
      let dependency = line.trim().split(' (')[0];
      if (!dependency || dependency.startsWith('/usr/lib/') || dependency.startsWith('/System/Library/')) continue;
      if (dependency.startsWith('@rpath/')) {
        const nearby = join(dirname(canonical), dependency.slice(7));
        dependency = existsSync(nearby) ? nearby : resolve(dirname(realpathSync(process.execPath)), '../lib', dependency.slice(7));
      }
      if (dependency.startsWith('@loader_path/')) dependency = resolve(dirname(canonical), dependency.slice(13));
      visit(dependency);
    }
  };
  visit(process.execPath); cachedRuntimeFiles = [...found]; return [...found];
}
export function hostFixture(t: TestContext, overrides: Partial<CodexIntent> = {}, options: { script?: string; executable?: string; args?: string[]; runtimeFiles?: string[] } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'forgemind-host-')));
  const source = join(base, 'source'), stage = join(base, 'stage'), scratch = join(base, 'scratch');
  for (const dir of [source, stage, scratch]) mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(source, 'allowed.txt'), 'allowed source'); writeFileSync(join(base, 'secret.txt'), 'synthetic credential');
  const workspace = snapshotWorkspace(source, stage, ['allowed.txt']);
  const runtime = LocalPolicyRuntime.open({ stateDirectory: join(base, 'policy'), workspaceRoot: workspace.workspaceRoot,
    repositoryId: 'project-a', sourceSnapshot: () => workspace.sourceSnapshot });
  const intent: CodexIntent = { driver: 'codex', scope: { tenantId: 'local', projectId: 'project-a', principalId: runtime.principal.id, taskId: 'ticket', invocationId: 'worker',
    sessionId: runtime.sessionId, policyVersion: 'local-v1', sourceSnapshot: workspace.sourceSnapshot }, expiresAt: Date.now() + 10000,
    workspaceRoot: workspace.workspaceRoot, model: 'fixture-model', provider: 'openai', effort: 'high', cliVersion: '0.160.0', mode: 'read-only', ephemeral: true,
    viewDigest: 'a'.repeat(64), maxRuntimeMs: 5000, maxOutputBytes: 65536, ...overrides };
  const script = options.script ?? fileURLToPath(new URL('./worker.js', import.meta.url));
  const plan = prepareHostPlan({ intent, executable: options.executable ?? process.execPath, args: options.args ?? [script, join(base, 'secret.txt')],
    readFiles: [...workspace.readFiles, ...(options.runtimeFiles ?? nodeRuntimeFiles()), ...(options.executable ? [] : [script])],
    supervisor: fileURLToPath(new URL('../../src/host-enforcement/supervisor.js', import.meta.url)) });
  const grant = runtime.issueGrant({ taskId: 'ticket', invocationId: 'worker', role: 'coder', capabilities: [{ action: 'command.run', resource: hostResource(plan) }],
    expiresAt: intent.expiresAt, remainingDepth: 0, maxActions: 1, maxChildren: 0 });
  const host = new OfflineSeatbeltHost({ runtime, grantId: grant.id, plan, scratchRoot: scratch });
  t.after(() => { runtime.close(); rmSync(base, { recursive: true, force: true }); });
  return { base, source, workspace, runtime, intent, plan, grant, host };
}
