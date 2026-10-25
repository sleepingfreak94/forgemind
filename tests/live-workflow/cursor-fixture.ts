import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cursorBuildManifest, openCursorSubscriptionSession, pinCursorConformanceCli } from '../../src/live-workflow/cursor-session.js';
import type { CursorRunner } from '../../src/live-workflow/cursor-session.js';
import { task as validateTask } from '../../src/live-workflow/validation.js';
import type { LiveTask } from '../../src/live-workflow/contracts.js';

/** Recorded Phase 0 print-mode shape (docs/artifacts/cursor-route/step5-print-auto-stdin.jsonl). */
export function cursorStream(label: string, answer: string, patch: { init?: Record<string, unknown>; result?: Record<string, unknown>; extra?: unknown[];
  content?: unknown[] } = {}): string {
  return [
    { type: 'system', subtype: 'init', apiKeySource: 'login', cwd: '/scratch/work', session_id: 's', model: label, permissionMode: 'default', ...patch.init },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'prompt' }] }, session_id: 's' },
    { type: 'assistant', message: { role: 'assistant', content: patch.content ?? [{ type: 'text', text: answer }] }, session_id: 's' },
    ...(patch.extra ?? []),
    { type: 'result', subtype: 'success', duration_ms: 3083, is_error: false, result: answer, session_id: 's', request_id: 'r-1',
      usage: { inputTokens: 6286, outputTokens: 10, cacheReadTokens: 3968, cacheWriteTokens: 0 }, ...patch.result },
  ].map(e => JSON.stringify(e)).join('\n') + '\n';
}
export const grok = 'grok-4.7-high', grokLabel = 'Grok 4.7 256K High', answer = '{"status":"ok","n":2}';

/** A tiny pinned stand-in for the version directory; replayed runners never execute it. */
export function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fm-cursor-'))), build = join(root, 'fake-build-1');
  mkdirSync(build); writeFileSync(join(build, 'node'), '#!/bin/sh\n'); chmodSync(join(build, 'node'), 0o755); writeFileSync(join(build, 'index.js'), '');
  const cli = pinCursorConformanceCli(build, { version: 'fake-build-1', manifestSha256: cursorBuildManifest(build) });
  const profile = realpathSync(mkdtempSync(join(root, 'p-'))); chmodSync(profile, 0o700);
  const scratch = realpathSync(mkdtempSync(join(root, 's-'))), workspace = realpathSync(mkdtempSync(join(root, 'w-')));
  return { root, build, cli, profile, scratch, workspace, close: () => rmSync(root, { recursive: true, force: true }) };
}
export const statusRunner = (tier: string, signedIn = true): CursorRunner => async request => ({ code: 0, stderr: '',
  stdout: request.args.includes('status') ? (signedIn ? '✓ Logged in as owner@example.invalid\n' : 'Not logged in\n') : `About Cursor CLI\n\nSubscription Tier   ${tier}\n` });
export const open = (f: ReturnType<typeof fixture>, tier: string, extra: Partial<Parameters<typeof openCursorSubscriptionSession>[0]> = {}) =>
  openCursorSubscriptionSession({ profileDirectory: f.profile, cli: f.cli, scratchRoot: f.scratch, workspace: f.workspace,
    personalWorkspaces: [f.workspace], runner: statusRunner(tier), ...extra });

export function cursorTask(model = grok, extra: Record<string, unknown> = {}): LiveTask {
  return validateTask({ schemaVersion: 1, taskId: 'cursor-task', objective: 'x', readPaths: ['v.txt'], writePaths: ['v.txt'],
    checks: [{ id: 'c', executable: process.execPath, args: [], timeoutMs: 5000 }], model, provider: 'cursor', effort: 'low',
    maxModelRequests: 3, maxPromptBytes: 65536, maxOutputBytes: 262144, maxRuntimeMs: 60000, draftPr: false, ...extra });
}
export const signal = () => new AbortController().signal;
