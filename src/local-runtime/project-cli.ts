import { createInterface } from 'node:readline/promises';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initializeProject, readProject, documentStatus } from '../project-workflow/project.js';
import { evaluateWorkflow, prepareWorkflow, proofRequest, renderPlan } from '../project-workflow/preflight.js';
import { preferences, plan as validatePlan, scope as validateScope, taskPreferences } from '../project-workflow/validation.js';
import { serialize } from '../context-engine/validation.js';
import { ProjectMemory } from '../memory/service.js';
import { defaultMemoryDirectory } from '../memory/location.js';
import { databasePath } from '../memory/database.js';
import type { ImplementationPlan, TaskPreferences, WorkflowAuthority, WorkflowPreferences } from '../project-workflow/contracts.js';

const usage = `Project onboarding (no live execution):
  npm run project:init -- --workspace /path/to/repo --project-id my-project [--new] [--preferences /path/to/preferences.json]
  npm run project:plan -- --workspace /path/to/repo --task-id ticket --source-snapshot <sha256> --plan /path/to/plan.json [--preview]
  npm run project:prepare -- --workspace /path/to/repo --project-id my-project --task-id ticket --source-snapshot <sha256> --plan /path/to/plan.json [--new]
Task overrides: --draft-pr yes|no --evidence text|video|both --plan-review approve|show|auto
Memory: existing default project memory loads automatically; --memory or --memory-state-dir /private/path enables it explicitly.
Optional --memory-query "keywords" overrides retrieval from the supplied plan objective.
Existing project:init reuses stored preferences. --new scaffolds missing draft PRD/SRS/ADR templates.
Plan approval is a local workflow choice; runtime grants and publishing authorization remain separate.\n`;
function argumentsFor(mode: string, args: string[]): Record<string, string | true> {
  const setup = ['workspace', 'project-id', 'name', 'new', 'preferences'];
  const planning = ['workspace', 'task-id', 'principal-id', 'source-snapshot', 'plan', 'preview', 'draft-pr', 'evidence', 'plan-review', 'memory', 'memory-state-dir', 'memory-query'];
  const allowed = mode === 'init' ? setup : mode === 'plan' ? planning : mode === 'prepare' ? [...new Set([...setup, ...planning])] : [];
  if (!allowed.length) throw new Error('unknown project command');
  const result: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!.replace(/^--/, '');
    if (args[i] !== `--${key}` || !allowed.includes(key) || key in result) throw new Error('invalid project arguments');
    if (['new', 'preview', 'memory'].includes(key)) result[key] = true;
    else {
      const value = args[++i]; if (!value || value.startsWith('--')) throw new Error('missing argument value'); result[key] = value;
    }
  }
  return result;
}
function required(args: Record<string, string | true>, key: string): string {
  const value = args[key]; if (typeof value !== 'string') throw new Error(`missing --${key}`); return value;
}
function jsonFile(path: string): unknown {
  const canonical = realpathSync(resolve(path)), stat = lstatSync(canonical);
  if (!stat.isFile() || stat.size > 65536) throw new Error('invalid JSON input file');
  try { return JSON.parse(readFileSync(canonical, 'utf8')); } catch { throw new Error('invalid JSON input'); }
}
async function main(): Promise<void> {
  const [mode, ...raw] = process.argv.slice(2);
  if (mode === '--help' || raw.includes('--help')) { process.stdout.write(usage); return; }
  const args = argumentsFor(mode ?? '', raw), root = realpathSync(resolve(typeof args.workspace === 'string' ? args.workspace : process.cwd()));
  let inputPlan: Readonly<ImplementationPlan> | undefined;
  let inputChoices: TaskPreferences = {};
  if (mode !== 'init') {
    // Reject invalid task inputs before onboarding can write any project files.
    inputPlan = validatePlan(jsonFile(required(args, 'plan')) as ImplementationPlan);
    validateScope({ projectId: 'input-validation', taskId: required(args, 'task-id'), principalId: typeof args['principal-id'] === 'string' ? args['principal-id'] : 'local-planning-owner',
      workspaceRoot: root, sourceSnapshot: required(args, 'source-snapshot'), expiresAt: Date.now() + 300000 });
    if (args['draft-pr']) {
      if (!['yes', 'no'].includes(String(args['draft-pr']))) throw new Error('invalid --draft-pr'); inputChoices.draftPr = args['draft-pr'] === 'yes';
    }
    if (args.evidence) inputChoices.evidence = args.evidence as TaskPreferences['evidence'] & string;
    if (args['plan-review']) inputChoices.planReview = args['plan-review'] as TaskPreferences['planReview'] & string;
    inputChoices = taskPreferences(inputChoices);
  }
  let io: ReturnType<typeof createInterface> | undefined;
  let memory: ProjectMemory | undefined;
  const closed = new AbortController();
  const question = async (prompt: string) => {
    io ??= createInterface({ input: process.stdin, output: process.stdout });
    io.once('close', () => closed.abort());
    return (await io.question(prompt, { signal: closed.signal })).trim().toLowerCase();
  };
  const choose = async <T extends string>(prompt: string, values: readonly T[]): Promise<T> => {
    const answer = await question(`${prompt} (${values.join('/')}; default ${values[0]}): `);
    const selected = answer || values[0]!; if (!values.includes(selected as T)) throw new Error('invalid preference choice'); return selected as T;
  };
  const choices = async (existing: TaskPreferences = {}, defaults: TaskPreferences = {}): Promise<TaskPreferences> => {
    const selected = { ...existing };
    if (selected.draftPr === undefined) selected.draftPr = await choose('Create a draft PR when complete? This preference does not grant Git access', defaults.draftPr === false ? ['no', 'yes'] : ['yes', 'no']) === 'yes';
    if (selected.evidence === undefined) {
      const values = ['text', 'video', 'both'] as const;
      selected.evidence = await choose('Before/after evidence', defaults.evidence ? [defaults.evidence, ...values.filter(value => value !== defaults.evidence)] : values);
    }
    if (selected.planReview === undefined) {
      const values = ['approve', 'show', 'auto'] as const;
      selected.planReview = await choose('Plan: approve waits; show displays; auto keeps the prepared plan quiet', defaults.planReview ? [defaults.planReview, ...values.filter(value => value !== defaults.planReview)] : values);
    }
    return selected;
  };
  const onboard = async () => {
    try {
      const existing = readProject(root);
      if (args['project-id'] && args['project-id'] !== existing.projectId) throw new Error('project ID differs from stored profile');
      if (args.new || args.preferences || args.name) throw new Error('project already registered; edit its profile explicitly');
      return { reused: true, profile: existing, documents: documentStatus(root, existing) };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const projectId = required(args, 'project-id');
    const selected = typeof args.preferences === 'string' ? preferences(jsonFile(args.preferences) as WorkflowPreferences) :
      preferences({ askAt: await choose('Ask delivery preferences once per project or for every task?', ['project', 'task']), ...await choices() });
    return initializeProject(root, { schemaVersion: 1, projectId, name: typeof args.name === 'string' ? args.name : projectId,
      documents: { prd: 'docs/PRD.md', srs: 'docs/SRS.md', adrs: 'docs/adr' }, preferences: selected }, args.new === true);
  };
  try {
    if (mode === 'init') {
      const result = await onboard();
      process.stdout.write(JSON.stringify({ ...result, liveCodingEnabled: false }, null, 2) + '\n'); return;
    }
    if (mode === 'prepare') { const setup = await onboard(); process.stdout.write(JSON.stringify({ ...setup, liveCodingEnabled: false }, null, 2) + '\n'); }
    const profile = readProject(root), plan = inputPlan!;
    const memoryDirectory = resolve(typeof args['memory-state-dir'] === 'string' ? args['memory-state-dir'] : defaultMemoryDirectory());
    if (args.memory || args['memory-state-dir'] || existsSync(databasePath(memoryDirectory, root, profile.projectId))) memory = new ProjectMemory(memoryDirectory, root);
    if (args['memory-query'] && !memory) throw new Error('memory is not initialized');
    const memoryQuery = typeof args['memory-query'] === 'string' ? args['memory-query'] : Array.from(plan.objective).slice(0, 400).join('');
    const memoryPacket = memory?.packet(memoryQuery);
    let overrides: TaskPreferences = { ...inputChoices };
    const scope = { projectId: profile.projectId, taskId: required(args, 'task-id'), principalId: typeof args['principal-id'] === 'string' ? args['principal-id'] : 'local-planning-owner',
      workspaceRoot: root, sourceSnapshot: required(args, 'source-snapshot'), expiresAt: Date.now() + 300000 };
    let prepared = prepareWorkflow(profile, plan, scope, overrides, memoryPacket);
    if (args.preview !== true && (prepared.missingPreferences.length || !prepared.taskPreferencesConfirmed)) {
      overrides = await choices(profile.preferences.askAt === 'task' ? overrides : prepared.preferences, profile.preferences);
      prepared = prepareWorkflow(profile, plan, scope, overrides, memoryPacket);
    }
    if (args.preview === true || prepared.preferences.planReview !== 'auto') process.stdout.write(renderPlan(prepared));
    else process.stdout.write(JSON.stringify({ planPrepared: true, planVisible: false, planDigest: prepared.planDigest, preferencesDigest: prepared.preferencesDigest }, null, 2) + '\n');
    process.stdout.write(JSON.stringify({ documents: documentStatus(root, profile) }, null, 2) + '\n');
    const approvals = new Map<string, string>();
    const authority: WorkflowAuthority = { async verify(request, receiptId) { return approvals.get(receiptId) === serialize(request); } };
    const receipts: { plan?: string } = {};
    let result = await evaluateWorkflow(prepared, authority, receipts);
    if (args.preview !== true && result.status === 'needs-plan-approval') {
      if (await question('Type approve to accept this displayed plan; any other answer keeps it pending: ') === 'approve') {
        if (memoryPacket) memory!.assertCurrent(memoryPacket);
        const id = `local-plan-review-${randomUUID()}`; approvals.set(id, serialize(proofRequest(prepared, 'plan-review'))); receipts.plan = id;
        result = await evaluateWorkflow(prepared, authority, receipts);
      }
    }
    if (memoryPacket) memory!.assertCurrent(memoryPacket);
    process.stdout.write(JSON.stringify({ ...result, note: 'Preflight only. No coding, Git action or video recording was performed. Local review receipts are in-memory, not durable runtime grants.' }, null, 2) + '\n');
    if (result.status !== 'ready-for-policy') process.exitCode = 2;
  } finally { memory?.close(); io?.close(); }
}
void main().catch(() => { process.stderr.write('Project preflight failed: invalid inputs, unavailable project or incomplete interactive answers. Use --help.\n'); process.exitCode = 2; });
