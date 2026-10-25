import { applyEdits } from './edits.js';
import { runChecks } from './checks.js';
import { runToolCoding } from './coding-tools.js';
import { sourceIdentity } from './repository.js';
import { readSources } from './validation.js';
import { codingSchema } from './contracts.js';
import type { RunAuthority } from './authority.js';
import type { CheckRuntime } from './check-runtime.js';
import type { CodingResult, GeneratedPlan, LiveTask, ModelPort, ProposedEdit, SubtaskPlan } from './contracts.js';

export const codingInstructions =
  'Implement the approved plan. For small changes to existing files prefer {path,beforeSha256,format:"text-replacements-v1",replacements:[{before,after}]}. Use the exact supplied whole-file beforeSha256. Each nonempty before must match exactly once in the original file; operations must not overlap, use regex, or depend on another operation. Keep anchors short but unique. The host preserves untouched bytes. Alternatively return {path,beforeSha256,content} with complete UTF-8 content (null digest for new files; null content deletes a file). Never mix formats within an edit. Do not change unrelated paths or weaken tests. Do not execute tools.';

export interface SplitCodingOptions {
  root: string;
  task: LiveTask;
  subtasks: SubtaskPlan[];
  source: string;
  authority: RunAuthority;
  checkDirectory: string;
  signal: AbortSignal;
  input: { plan: GeneratedPlan; memory: unknown; beforeChecks: unknown };
  checkRuntime?: CheckRuntime;
  save(name: string, value: unknown): void;
  progress(message: string): void;
  /** Lets the caller move its tracked source forward after each subtask. */
  advance?(source: string): void;
}

/** Code each subtask in order on one worktree; each subtask's own checks must pass before the next starts. */
export async function runSplitCoding(model: ModelPort, options: SplitCodingOptions):
  Promise<{ changes: CodingResult; source: string; consulted: string[] }> {
  const { root, task, subtasks, authority, signal, input } = options;
  let source = options.source;
  const assertCurrent = () => {
    if (sourceIdentity(root) !== source) throw new Error('Source drift outside authorized mutation');
  };
  const n = subtasks.length;
  const merged = new Map<string, ProposedEdit>();
  const summaries: string[] = [];
  const consulted: string[] = [];
  const earlier: { title: string; summary: string }[] = [];
  const changed: string[] = [];
  for (let k = 0; k < n; k++) {
    const i = k + 1, subtask = subtasks[k]!;
    const narrowed: LiveTask = { ...task, objective: subtask.objective, writePaths: subtask.writePaths,
      checks: task.checks.filter(c => subtask.checks.includes(c.id)) };
    options.progress(`Subtask ${i} of ${n}: ${subtask.title}`);
    const sources = readSources(root, [...new Set([...task.readPaths, ...subtask.writePaths, ...changed])], task.maxPromptBytes);
    const codingInput = { task: narrowed, subtask: { index: i, of: n, title: subtask.title }, earlier: earlier.map(e => ({ ...e })),
      plan: input.plan, sources, memory: input.memory, beforeChecks: input.beforeChecks };
    let result: CodingResult;
    if (task.codingMode === 'tools') {
      const coded = await runToolCoding(model, { root, task: narrowed, source, authority, checkDirectory: options.checkDirectory, signal,
        boundary: () => signal.throwIfAborted(), input: codingInput,
        ...(options.checkRuntime ? { checkRuntime: options.checkRuntime } : {}) });
      result = coded.changes; source = coded.source;
      for (const p of coded.consulted) if (!consulted.includes(p)) consulted.push(p);
    } else {
      const raw = await model.complete(codingInstructions, codingInput, codingSchema, signal, 'coding');
      assertCurrent();
      result = applyEdits(root, source, subtask.writePaths, raw, authority, assertCurrent);
      source = sourceIdentity(root);
    }
    options.advance?.(source);
    const paths = result.edits.map(e => e.path);
    authority.phase('subtask', source, { index: i, of: n, title: subtask.title, paths });
    if (narrowed.checks.length) {
      // Subtask checks are not phase evidence (no output digest on the receipt).
      const results = await runChecks(root, source, narrowed.checks, options.checkDirectory, authority, signal, options.checkRuntime, false);
      options.save(`subtask-${i}-checks.json`, results);
      assertCurrent();
      if (results.some(c => !c.passed))
        throw new Error(`Subtask ${i} of ${n} ("${subtask.title}") failed its checks; later subtasks were not started and the worktree is retained`);
    }
    earlier.push({ title: subtask.title, summary: result.summary });
    summaries.push(`${i}. ${subtask.title}: ${result.summary}`);
    // Last write wins; a rewritten path moves to the end (last-write order).
    for (const edit of result.edits) { merged.delete(edit.path); merged.set(edit.path, edit); }
    for (const p of paths) if (!changed.includes(p)) changed.push(p);
  }
  return { changes: { summary: summaries.join('\n').slice(0, 4000), edits: [...merged.values()] }, source, consulted };
}
