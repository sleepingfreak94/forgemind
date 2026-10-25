import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { BrainStore, containsSecret } from './brain.js';
import type { BrainSpace } from './brain.js';
import { brainSpaceFor } from './brain-spaces.js';

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
  status: string; prUrl?: string }): { recorded: true; space: BrainSpace; id: string; lessons: number } | { recorded: false; reason: string } {
  try {
    let space: BrainSpace;
    try { space = brainSpaceFor(input.workspace, input.brainDirectory); }
    catch (error) {
      const message = error instanceof Error ? error.message : '';
      return { recorded: false, reason: message || 'brain unavailable' };
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
      const key = basename(dirname(input.artifacts));
      const id = store.record({ project, source: 'harness', key, title, summary, files, outcome, evidence });
      let lessons = 0;
      try {
        const texts: string[] = [];
        if (Array.isArray(list)) {
          const failed = list.filter(isObject).filter(c => typeof c.id === 'string' && c.passed === false).slice(0, 3);
          for (const c of failed) texts.push(`Check ${c.id as string} failed after the change in ${title}.`);
        }
        if (isObject(review) && (review.verdict === 'revise' || review.verdict === 'blocked') && Array.isArray(review.findings)) {
          const found = review.findings.filter((f): f is string => typeof f === 'string' && f.trim() !== '').slice(0, 3);
          for (const f of found) texts.push(`Reviewer (${review.verdict}): ${f.trim().slice(0, 300)}`);
        }
        if (message) texts.push(`Run stopped: ${message}`);
        const known = new Set(store.list({ project }).map(e => e.id));
        for (const text of new Set(texts)) {
          if (containsSecret(text)) continue;
          try {
            const lesson = store.propose({ kind: 'lesson', project, text, evidence: [clean(input.taskId, 300), key],
              reason: 'auto-proposed from a harness run' });
            if (!known.has(lesson)) { known.add(lesson); lessons++; }
          } catch { /* a proposal error never stops the run being recorded */ }
        }
      } catch { /* lessons are best effort */ }
      return { recorded: true, space, id, lessons };
    } finally { store.close(); }
  } catch (error) {
    return { recorded: false, reason: error instanceof Error ? error.message : 'brain write failed' };
  }
}
