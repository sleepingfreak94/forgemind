import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { BrainStore, containsSecret } from './brain.js';
import type { BrainSpace } from './brain.js';
import { brainSpaceFor } from './brain-spaces.js';

const unmapped = 'project not mapped to a brain space';
const maxFile = 1024 * 1024;

function readJson(directory: string, name: string): unknown {
  try {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > maxFile) return undefined;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch { return undefined; }
}
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function clean(value: string, max: number): string {
  const text = value.trim().slice(0, max);
  return containsSecret(text) ? '[redacted]' : text;
}

function firstSentence(objective: string): string {
  const text = objective.trim();
  const cuts = ['. ', ': ', '\n'].map(d => text.indexOf(d)).filter(i => i >= 0);
  const first = (cuts.length ? text.slice(0, Math.min(...cuts)) : text).trim();
  return first.length > 120 ? first.slice(0, 119).trimEnd() + '…' : first;
}

export function recordHarnessRun(input: { brainDirectory: string; workspace: string; taskId: string; objective: string; artifacts: string;
  status: string; prUrl?: string }): { recorded: true; space: BrainSpace; id: string } | { recorded: false; reason: string } {
  try {
    let space: BrainSpace;
    try { space = brainSpaceFor(input.workspace, input.brainDirectory); }
    catch (error) {
      const message = error instanceof Error ? error.message : '';
      return { recorded: false, reason: /not mapped/.test(message) ? unmapped : message || 'brain unavailable' };
    }
    const project = realpathSync(input.workspace);
    const dir = input.artifacts;
    const changes = readJson(dir, 'changes.json'), checks = readJson(dir, 'after-checks.json');
    const review = readJson(dir, 'review.json'), failure = readJson(dir, 'failure.json');
    const parts: string[] = [];
    const paths: string[] = [];
    if (isObject(changes)) {
      if (typeof changes.summary === 'string' && changes.summary.trim()) parts.push(changes.summary.trim());
      if (Array.isArray(changes.edits)) for (const edit of changes.edits) {
        if (isObject(edit) && typeof edit.path === 'string') paths.push(edit.path);
      }
    }
    if (isObject(review) && typeof review.verdict === 'string') parts.push(`Review: ${review.verdict}.`);
    const list: unknown = Array.isArray(checks) ? checks : isObject(checks) ? checks.checks : undefined;
    if (Array.isArray(list)) {
      const done = list.filter(isObject).filter(c => typeof c.id === 'string' && typeof c.passed === 'boolean')
        .map(c => `${c.id as string} ${c.passed ? 'pass' : 'fail'}`);
      if (done.length) parts.push(`Checks: ${done.join(', ')}.`);
    }
    const joined = parts.join(' ').slice(0, 4000);
    const summary = containsSecret(joined) ? '[redacted]' : joined;
    const title = clean(firstSentence(input.objective), 300) || clean(input.taskId, 300) || 'harness run';
    const files = [...new Set(paths.map(p => clean(p, 1024)))].slice(0, 200);
    const message = isObject(failure) && typeof failure.message === 'string' ? failure.message.trim().slice(0, 180) : '';
    const outcome = clean(input.status === 'failed' && message ? `failed: ${message}` : input.status, 200) || 'unknown';
    const evidence = [clean(input.taskId, 300), ...(input.prUrl ? [clean(input.prUrl, 300)] : [])];
    const store = new BrainStore(input.brainDirectory, space);
    try {
      const id = store.record({ project, source: 'harness', key: basename(dirname(input.artifacts)), title, summary, files, outcome, evidence });
      return { recorded: true, space, id };
    } finally { store.close(); }
  } catch (error) {
    return { recorded: false, reason: error instanceof Error ? error.message : 'brain write failed' };
  }
}
