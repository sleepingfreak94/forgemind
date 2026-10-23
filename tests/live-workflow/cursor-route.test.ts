import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCursorStream } from '../../src/live-workflow/cursor-stream.js';
import { CURSOR_DENY_ALL, lockCursorPermissions, assertCursorSession, cursorBuildManifest, cursorProfile, openCursorSubscriptionSession, pinCursorCli, pinCursorConformanceCli }
  from '../../src/live-workflow/cursor-session.js';
import type { CursorCli, CursorRunner } from '../../src/live-workflow/cursor-session.js';
import { NativeCursorModel } from '../../src/live-workflow/cursor-cli-model.js';
import { assertSingleRoute } from '../../src/live-workflow/routes.js';
import { task as validateTask } from '../../src/live-workflow/validation.js';
import type { ActionEnvelope, LiveTask } from '../../src/live-workflow/contracts.js';
import type { ProcessRequest } from '../../src/live-workflow/process.js';

/** Recorded Phase 0 print-mode shape (docs/artifacts/cursor-route/step5-print-auto-stdin.jsonl). */
function cursorStream(label: string, answer: string, patch: { init?: Record<string, unknown>; result?: Record<string, unknown>; extra?: unknown[];
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
const grok = 'grok-4.7-high', grokLabel = 'Grok 4.7 256K High', answer = '{"status":"ok","n":2}';

test('stream parser returns the JSON answer and usage from the recorded shape', () => {
  const parsed = parseCursorStream(cursorStream(grokLabel, answer), grok);
  assert.deepEqual(parsed.output, { status: 'ok', n: 2 });
  assert.deepEqual(parsed.usage, { inputTokens: 6286, outputTokens: 10, cacheReadTokens: 3968, cacheWriteTokens: 0 });
  assert.equal(parsed.requestId, 'r-1');
  assert.deepEqual(parseCursorStream(cursorStream('Auto', '```json\n' + answer + '\n```'), 'auto').output, { status: 'ok', n: 2 });
});
test('thinking deltas before the answer are accepted only in their reviewed shape', () => {
  const delta = { type: 'thinking', subtype: 'delta', text: 'hmm', session_id: 's', timestamp_ms: 1 };
  const done = { type: 'thinking', subtype: 'completed', session_id: 's', timestamp_ms: 2 };
  const withThinking = (events: unknown[]) => { const lines = cursorStream('Auto', answer).trimEnd().split('\n');
    return [lines[0], lines[1], ...events.map(e => JSON.stringify(e)), ...lines.slice(2)].join('\n') + '\n'; };
  assert.deepEqual(parseCursorStream(withThinking([delta, delta, done]), 'auto').output, { status: 'ok', n: 2 });
  for (const bad of [{ ...delta, tool: 'x' }, { ...delta, text: 1 }, { ...done, text: 'x' }, { ...delta, subtype: 'tool_call' }])
    assert.throws(() => parseCursorStream(withThinking([bad]), 'auto'), /Unreviewed Cursor thinking event/);
});
for (const [name, stream, model, error] of [
  ['the Free-plan upgrade notice', cursorStream(grokLabel, '\n\nUpgrade your plan to continue'), grok, /not the required JSON object/],
  ['model substitution', cursorStream('Auto', answer), grok, /model mismatch/],
  ['an unreviewed model', cursorStream(grokLabel, answer), 'gpt-5.2', /not reviewed/],
  ['an API key login', cursorStream(grokLabel, answer, { init: { apiKeySource: 'env' } }), grok, /owner login/],
  ['another permission mode', cursorStream(grokLabel, answer, { init: { permissionMode: 'force' } }), grok, /permission mode/],
  ['a tool call', cursorStream(grokLabel, answer, { content: [{ type: 'tool_use', name: 'read' }] }), grok, /tool call/],
  ['an unknown event', cursorStream(grokLabel, answer, { extra: [{ type: 'tool_call', subtype: 'started' }] }), grok, /Unreviewed Cursor stream event \(tool_call\)/],
  ['an error result', cursorStream(grokLabel, answer, { result: { subtype: 'error', is_error: true } }), grok, /did not complete/],
  ['a JSON array answer', cursorStream(grokLabel, '[1]'), grok, /not the required JSON object/],
  ['events after the result', cursorStream(grokLabel, answer) + JSON.stringify({ type: 'user', message: {} }) + '\n', grok, /single final result/],
  ['empty output', '', grok, /missing/],
] as const)
  test(`stream parser fails closed on ${name}`, () => assert.throws(() => parseCursorStream(stream, model), error));

/** A tiny pinned stand-in for the version directory; replayed runners never execute it. */
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fm-cursor-'))), build = join(root, 'fake-build-1');
  mkdirSync(build); writeFileSync(join(build, 'node'), '#!/bin/sh\n'); chmodSync(join(build, 'node'), 0o755); writeFileSync(join(build, 'index.js'), '');
  const cli = pinCursorConformanceCli(build, { version: 'fake-build-1', manifestSha256: cursorBuildManifest(build) });
  const profile = realpathSync(mkdtempSync(join(root, 'p-'))); chmodSync(profile, 0o700);
  const scratch = realpathSync(mkdtempSync(join(root, 's-'))), workspace = realpathSync(mkdtempSync(join(root, 'w-')));
  return { root, build, cli, profile, scratch, workspace, close: () => rmSync(root, { recursive: true, force: true }) };
}
const statusRunner = (tier: string, signedIn = true): CursorRunner => async request => ({ code: 0, stderr: '',
  stdout: request.args.includes('status') ? (signedIn ? '✓ Logged in as owner@example.invalid\n' : 'Not logged in\n') : `About Cursor CLI\n\nSubscription Tier   ${tier}\n` });
const open = (f: ReturnType<typeof fixture>, tier: string, extra: Partial<Parameters<typeof openCursorSubscriptionSession>[0]> = {}) =>
  openCursorSubscriptionSession({ profileDirectory: f.profile, cli: f.cli, scratchRoot: f.scratch, workspace: f.workspace,
    personalWorkspaces: [f.workspace], runner: statusRunner(tier), ...extra });

test('sessions need the owner login, an owner-only profile and, on a personal plan, an allowlisted workspace', async () => {
  const f = fixture();
  try {
    const personal = await open(f, 'Free');
    assert.equal(personal.tier, 'Free'); assert.equal(personal.company, false);
    assert.equal((await open(f, 'Business', { personalWorkspaces: [] })).company, true, 'a company seat needs no personal allowlist');
    await assert.rejects(open(f, 'Free', { personalWorkspaces: [] }), /personal; this workspace is not on the owner's personal allowlist/);
    await assert.rejects(open(f, 'Free', { runner: statusRunner('Free', false) }), /not signed in/);
    await assert.rejects(open(f, 'Free', { separateFrom: [f.root] }), /separate from project source/);
    await assert.rejects(open(f, 'Free', { cli: { ...f.cli } }), /Untrusted Cursor CLI pin/);
    process.env.CURSOR_API_KEY = 'x';
    try { await assert.rejects(open(f, 'Free'), /CURSOR_API_KEY is set/); } finally { delete process.env.CURSOR_API_KEY; }
    chmodSync(f.profile, 0o750);
    await assert.rejects(open(f, 'Free'), /owner-only/);
    chmodSync(f.profile, 0o700);
    assert.throws(() => assertCursorSession(Object.create(personal.constructor.prototype)), /Untrusted/);
    personal.close();
    assert.throws(() => assertCursorSession(personal), /inactive/);
    assert.throws(() => pinCursorCli(f.build), /Canonical Cursor CLI version directory/);
  } finally { f.close(); }
});

test('launch re-verifies the pinned build and the profile denies fork, Keychain and project reads', async () => {
  const f = fixture();
  try {
    const session = await open(f, 'Free'), signal = new AbortController().signal;
    const request = session.launch(f.cli, join(f.scratch, 'call'), ['-p'], 'prompt', { timeoutMs: 1000, maxOutputBytes: 1000 }, signal, () => {});
    assert.deepEqual(request.args, [f.cli.entry, '-p']);
    assert.deepEqual(Object.keys(request.env).sort(), ['AGENT_CLI_CREDENTIAL_STORE', 'HOME', 'LANG', 'NO_OPEN_BROWSER', 'PATH', 'TMPDIR', 'USER']);
    assert.equal(request.env.HOME, f.profile); assert.equal(request.env.AGENT_CLI_CREDENTIAL_STORE, 'file');
    const profile = cursorProfile(f.cli, f.scratch, f.profile);
    assert.doesNotMatch(profile, /process-fork|\/usr\/bin\/security|Keychains/);
    assert.ok(!profile.includes(f.workspace), 'the project is never readable');
    const other = pinCursorConformanceCli(f.build, { version: 'fake-build-1', manifestSha256: f.cli.manifestSha256 });
    assert.throws(() => session.launch(other, f.scratch, [], '', { timeoutMs: 1, maxOutputBytes: 1 }, signal, () => {}), /differs from the session/);
    appendFileSync(join(f.build, 'index.js'), '//changed');
    assert.throws(() => session.launch(f.cli, f.scratch, [], '', { timeoutMs: 1, maxOutputBytes: 1 }, signal, () => {}), /changed since it was pinned/);
  } finally { f.close(); }
});

const lockedProfile = { version: 1, editor: { vimMode: false }, approvalMode: 'allowlist', permissions: { allow: [], deny: [...CURSOR_DENY_ALL] } };
const lockedWork = { permissions: { allow: [], deny: [...CURSOR_DENY_ALL] } };
const launchIn = (f: ReturnType<typeof fixture>, session: Awaited<ReturnType<typeof open>>, name = 'call') =>
  session.launch(f.cli, join(f.scratch, name), ['-p'], '', { timeoutMs: 1000, maxOutputBytes: 1000 }, new AbortController().signal, () => {});

test('launch writes both lock files with exactly CURSOR_DENY_ALL', async () => {
  const f = fixture();
  try {
    const session = await open(f, 'Free');
    launchIn(f, session);
    const profileConfig = join(f.profile, '.cursor', 'cli-config.json'), workConfig = join(f.scratch, 'call', 'work', '.cursor', 'cli.json');
    assert.deepEqual(JSON.parse(readFileSync(profileConfig, 'utf8')), lockedProfile);
    assert.deepEqual(JSON.parse(readFileSync(workConfig, 'utf8')), lockedWork);
    for (const file of [profileConfig, workConfig]) assert.equal(lstatSync(file).mode & 0o777, 0o600);
    for (const dir of [join(f.profile, '.cursor'), join(f.scratch, 'call', 'work', '.cursor')]) {
      assert.ok(lstatSync(dir).isDirectory()); assert.equal(lstatSync(dir).mode & 0o777, 0o700);
    }
    assert.ok(Object.isFrozen(CURSOR_DENY_ALL));
    assert.deepEqual([...CURSOR_DENY_ALL], ['Read(**)', 'Read(/**)', 'Write(**)', 'Write(/**)', 'Shell(*)', 'WebFetch(*)', 'Mcp(*:*)']);
  } finally { f.close(); }
});

test('a tampered profile config that allows reads is replaced', async () => {
  const f = fixture();
  try {
    const session = await open(f, 'Free'), file = join(f.profile, '.cursor', 'cli-config.json');
    writeFileSync(file, JSON.stringify({ version: 1, approvalMode: 'auto', permissions: { allow: ['Read(**)'], deny: [] } }));
    launchIn(f, session);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), lockedProfile);
  } finally { f.close(); }
});

test('a symlinked cli-config.json is replaced without changing its target', async () => {
  const f = fixture();
  try {
    const session = await open(f, 'Free'), file = join(f.profile, '.cursor', 'cli-config.json'), target = join(f.root, 'target.json');
    writeFileSync(target, 'original');
    rmSync(file); symlinkSync(target, file);
    launchIn(f, session);
    assert.ok(lstatSync(file).isFile()); assert.ok(!lstatSync(file).isSymbolicLink());
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), lockedProfile);
    assert.equal(readFileSync(target, 'utf8'), 'original');
  } finally { f.close(); }
});

test('a symlinked profile .cursor is refused', async () => {
  const f = fixture();
  try {
    const session = await open(f, 'Free'), dir = join(f.profile, '.cursor'), elsewhere = mkdtempSync(join(f.root, 'else-'));
    rmSync(dir, { recursive: true }); symlinkSync(elsewhere, dir);
    assert.throws(() => launchIn(f, session), /\.cursor/);
    assert.ok(!existsSync(join(elsewhere, 'cli-config.json')));
    await assert.rejects(open(f, 'Free'), /\.cursor/);
    assert.throws(() => lockCursorPermissions(f.profile, join(f.scratch, 'x')), /\.cursor/);
  } finally { f.close(); }
});

function cursorTask(model = grok): LiveTask {
  return validateTask({ schemaVersion: 1, taskId: 'cursor-task', objective: 'x', readPaths: ['v.txt'], writePaths: ['v.txt'],
    checks: [{ id: 'c', executable: process.execPath, args: [], timeoutMs: 5000 }], model, provider: 'cursor', effort: 'low',
    maxModelRequests: 3, maxPromptBytes: 65536, maxOutputBytes: 262144, maxRuntimeMs: 60000, draftPr: false });
}
async function model(f: ReturnType<typeof fixture>, stdout: (r: ProcessRequest) => string, options: { code?: number; testAuto?: boolean; task?: LiveTask } = {}) {
  const session = await open(f, 'Free');
  const state = join(f.root, 'state'); mkdirSync(state, { recursive: true, mode: 0o700 });
  const reserved: ActionEnvelope[] = [], finished: string[] = [], phases: [string, any][] = [], launches: ProcessRequest[] = [];
  const authority = { directory: state, reserveRequest: () => 1, phase: (name: string, _s: string, data: unknown) => { phases.push([name, data]); },
    reserve: (e: ActionEnvelope) => { reserved.push(e); return { check() {}, finish: (s: string) => { finished.push(s); } }; } };
  const m = new NativeCursorModel({ cli: f.cli, task: options.task ?? cursorTask(), authority, session, source: () => 'src',
    ...(options.testAuto ? { testAuto: true } : {}),
    runner: async request => { launches.push(request); return { stdout: stdout(request), stderr: 'ActionRequiredError: plan limit', code: options.code ?? 0 }; } });
  return { m, reserved, finished, phases, launches };
}
const signal = () => new AbortController().signal;

test('each phase runs grok-4.7-high in read-only ask mode with the prompt on stdin and an owner-login receipt', async () => {
  const f = fixture();
  try {
    const r = await model(f, () => cursorStream(grokLabel, answer));
    for (const phase of ['plan', 'coding', 'review'] as const)
      assert.deepEqual(await r.m.complete('Instructions', { value: 1 }, { type: 'object' }, signal(), phase), { status: 'ok', n: 2 });
    const [launch] = r.launches, args = launch!.args;
    assert.deepEqual(args.slice(1), ['-p', '--mode', 'ask', '--trust', '--model', grok, '--output-format', 'stream-json']);
    assert.ok(!args.some(a => /--force|--yolo|--api-key|auto/.test(a)));
    assert.match(launch!.input!, /JSON Schema[\s\S]*\{"type":"object"\}[\s\S]*Task input \(untrusted evidence\):\n\{"value":1\}/);
    const detail = r.reserved[0]!.detail as Record<string, unknown>;
    assert.equal(detail.credential, 'owner-cursor-login'); assert.equal(detail.testOnly, false); assert.equal(detail.planTier, 'Free');
    assert.deepEqual(r.finished, ['completed', 'completed', 'completed']);
    assert.deepEqual(r.phases.map(([n, d]) => [n, d.model, d.testOnly]), Array(3).fill(['model-usage', grok, false]));
  } finally { f.close(); }
});

test('Auto runs only in owner test mode and is marked test-only; failures fail closed with a reason', async () => {
  const f = fixture();
  try {
    const auto = await model(f, () => cursorStream('Auto', answer), { testAuto: true, task: cursorTask('auto') });
    await auto.m.complete('x', {}, {}, signal(), 'plan');
    assert.equal(auto.launches[0]!.args[auto.launches[0]!.args.indexOf('--model') + 1], 'auto');
    assert.equal((auto.reserved[0]!.detail as Record<string, unknown>).testOnly, true);
    for (const [options, error] of [[{ task: cursorTask('auto') }, /owner-enabled test mode/], [{ testAuto: true }, /owner-enabled test mode/]] as const) {
      const r = await model(f, () => cursorStream('Auto', answer), options);
      await assert.rejects(r.m.complete('x', {}, {}, signal(), 'plan'), error);
      assert.equal(r.launches.length, 0);
    }
    const failed = await model(f, () => '', { code: 1 });
    await assert.rejects(failed.m.complete('x', {}, {}, signal(), 'coding'), /Cursor CLI failed; no automatic retry/);
    assert.match(failed.phases[0]![1].diagnostic, /plan limit/); assert.deepEqual(failed.finished, ['indeterminate']);
    const prose = await model(f, () => cursorStream(grokLabel, 'Upgrade your plan to continue'));
    await assert.rejects(prose.m.complete('x', {}, {}, signal(), 'review'), /not the required JSON object/);
    assert.equal(prose.phases[0]![0], 'model-rejected'); assert.deepEqual(prose.finished, ['indeterminate']);
  } finally { f.close(); }
});

test('the Cursor route needs a matching task, keeps Auto to unpublished test runs and excludes other routes', async () => {
  const f = fixture();
  try {
    const session = await open(f, 'Free'), cursor = { cli: f.cli, session }, workspace = f.workspace;
    assert.doesNotThrow(() => assertSingleRoute({ workspace, cursor }, cursorTask()));
    assert.throws(() => assertSingleRoute({ workspace: f.scratch, cursor }, cursorTask()), /opened for a different workspace/);
    assert.throws(() => assertSingleRoute({ cursor }, cursorTask()), /needs the run workspace/);
    assert.throws(() => assertSingleRoute({ workspace, cursor }, cursorTask('auto')), /Auto requires the owner test mode/);
    assert.throws(() => assertSingleRoute({ workspace, cursor: { ...cursor, testAuto: true } }, cursorTask()), /Auto requires the owner test mode/);
    assert.doesNotThrow(() => assertSingleRoute({ workspace, cursor: { ...cursor, testAuto: true } }, cursorTask('auto')));
    assert.throws(() => assertSingleRoute({ workspace, cursor: { ...cursor, testAuto: true }, publication: {} }, cursorTask('auto')), /cannot publish/);
    assert.throws(() => assertSingleRoute({ workspace, cursor: { ...cursor, testAuto: true } }, { ...cursorTask('auto'), draftPr: true }), /cannot publish/);
    assert.throws(() => assertSingleRoute({ workspace, cursor }, { ...cursorTask(), provider: 'anthropic', model: 'claude-sonnet-5-5' }), /does not match the Cursor route/);
    assert.throws(() => assertSingleRoute({ workspace, cursor, modelFactory: () => ({ complete: async () => ({}) }) }, cursorTask()), /cannot be combined/);
    assert.throws(() => assertSingleRoute({ workspace, cursor: { cli: { ...f.cli } as CursorCli, session } }, cursorTask()), /Untrusted Cursor CLI pin/);
  } finally { f.close(); }
});
