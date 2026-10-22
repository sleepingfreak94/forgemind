import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { claudeFailureSummary, claudeStreamShape, parseClaudeStream } from '../../src/live-workflow/claude-stream.js';
import { assertClaudeSession, openClaudeSubscriptionSession, claudeInferenceProfile, pinClaudeCli } from '../../src/live-workflow/claude-session.js';
import type { ClaudeCli } from '../../src/live-workflow/claude-session.js';
import { NativeClaudeModel } from '../../src/live-workflow/claude-cli-model.js';
import { task as validateTask } from '../../src/live-workflow/validation.js';
import { CLAUDE_PHASE_MODELS } from '../../src/live-workflow/routing-profile.js';
import type { ActionEnvelope, LiveTask } from '../../src/live-workflow/contracts.js';
import type { ProcessRequest } from '../../src/live-workflow/process.js';
import { claudeStream, fakeArgs, fakeCli, fakeCliSkip, fakeEnv, fixtureSession } from './claude-fixture.js';

const sonnet = 'claude-sonnet-5-5', opus = 'claude-opus-5-5';
const expected = { model: sonnet, version: '2.1.308', tools: ['StructuredOutput'], maxTurns: 3 };
const answer = { status: 'ok', n: 2 };

test('stream parser returns the structured answer from the recorded Phase 0 shape', () => {
  const parsed = parseClaudeStream(claudeStream(sonnet, answer), expected);
  assert.deepEqual(parsed.output, answer);
  assert.equal(parsed.numTurns, 2);
  assert.equal(parsed.listCostUsd, 0.01);
});

const rejections: [string, string, RegExp][] = [
  ['model substitution', claudeStream(opus, answer), /model mismatch/],
  ['API key credential', claudeStream(sonnet, answer, { init: { apiKeySource: 'ANTHROPIC_API_KEY' } }), /owner subscription/],
  ['telemetry enabled', claudeStream(sonnet, answer, { init: { analytics_disabled: false } }), /telemetry/],
  ['extra built-in tool', claudeStream(sonnet, answer, { init: { tools: ['StructuredOutput', 'Bash'] } }), /tool inventory/],
  ['unreviewed tool call', claudeStream(sonnet, answer, { toolName: 'Bash' }), /unreviewed tool/],
  ['overage allowed', claudeStream(sonnet, answer, { limit: { overageStatus: 'allowed' } }), /beyond the plan/],
  ['overage in use', claudeStream(sonnet, answer, { limit: { isUsingOverage: true } }), /beyond the plan/],
  ['refusal', claudeStream(sonnet, answer, { result: { stop_reason: 'refusal' } }), /did not complete/],
  ['error result', claudeStream(sonnet, answer, { result: { subtype: 'error_during_execution', is_error: true } }), /did not complete/],
  ['turn limit', claudeStream(sonnet, answer, { result: { num_turns: 4 } }), /turn limit/],
  ['fallback model usage', claudeStream(sonnet, answer, { result: { modelUsage: { [sonnet]: {}, [opus]: {} } } }), /unexpected model/],
  ['permission denial', claudeStream(sonnet, answer, { result: { permission_denials: [{ tool_name: 'Bash' }] } }), /permission denials/],
  ['missing answer', claudeStream(sonnet, answer, { result: { structured_output: null } }), /no structured output/],
  ['unknown event', claudeStream(sonnet, answer, { extra: [{ type: 'hook_event' }] }), /Unreviewed Claude stream event/],
  ['events after result', claudeStream(sonnet, answer) + JSON.stringify({ type: 'user', message: { content: [] } }) + '\n', /single final result/],
  ['CLI retry', claudeStream(sonnet, answer, { extra: [{ type: 'system', subtype: 'api_retry', attempt: 1, error_status: 429 }] }), /retried a request/],
  ['telemetry plugin', claudeStream(sonnet, answer, { init: { plugins: [{ name: 'cc-plugin-agents-md', path: 'builtin' },
    { name: 'cc-plugin-plugin-authoring', path: 'builtin' }, { name: 'cc-plugin-telemetry', path: 'builtin' }] } }), /configuration differs/],
  ['configured MCP server', claudeStream(sonnet, answer, { init: { mcp_servers: [{ name: 'x', status: 'connected' }] } }), /configuration differs/],
  ['profile skill', claudeStream(sonnet, answer, { init: { skills: ['deploy'] } }), /configuration differs/],
  ['unreviewed agent', claudeStream(sonnet, answer, { init: { agents: ['claude', 'custom-agent'] } }), /configuration differs/],
  ['permission mode', claudeStream(sonnet, answer, { init: { permissionMode: 'bypassPermissions' } }), /configuration differs/],
  ['API error status', claudeStream(sonnet, answer, { result: { api_error_status: 429 } }), /did not complete/],
  ['safety stop', claudeStream(sonnet, answer, { result: { safety_stops: 1 } }), /did not complete/],
  ['malformed line', '{"type":"system"\n', /Malformed/],
  ['empty output', '', /missing/],
];
for (const [name, stream, error] of rejections)
  test(`stream parser fails closed on ${name}`, () => assert.throws(() => parseClaudeStream(stream, expected), error));
test('thinking progress estimates are allowed only as numeric system events after init', () => {
  const progress = { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 40, estimated_tokens_delta: 40 };
  const lines = claudeStream(sonnet, answer).trimEnd().split('\n');
  const observed = [lines[0], JSON.stringify(progress), JSON.stringify({ ...progress, estimated_tokens: 80 }), ...lines.slice(1)].join('\n') + '\n';
  assert.deepEqual(parseClaudeStream(observed, expected).output, answer);
  const first = [JSON.stringify(progress), ...lines].join('\n') + '\n';
  assert.throws(() => parseClaudeStream(first, expected), /Unreviewed Claude session start$/);
  const textual = claudeStream(sonnet, answer, { extra: [{ ...progress, estimated_tokens: 'many' }] });
  assert.throws(() => parseClaudeStream(textual, expected), /\(system thinking_tokens\)/);
  const fallback = claudeStream(sonnet, answer, { extra: [{ type: 'system', subtype: 'model_fallback' }] });
  assert.throws(() => parseClaudeStream(fallback, expected), /\(system model_fallback\)/);
});
test('stream parser bounds usage and failure summaries carry status fields only', () => {
  const big = parseClaudeStream(claudeStream(sonnet, answer, { result: { usage: { pad: 'x'.repeat(5000) } } }), expected);
  assert.equal(big.usage, null);
  const failed = claudeStream(sonnet, answer, { result: { subtype: 'error_during_execution', is_error: true, api_error_status: 429, result: 'secret model text' } });
  assert.deepEqual(claudeFailureSummary(failed), { subtype: 'error_during_execution', is_error: true, terminal_reason: 'completed',
    stop_reason: 'tool_use', api_error_status: 429, num_turns: 2 });
  assert.equal(claudeFailureSummary('not json'), null);
  const extra = claudeStream(sonnet, answer, { extra: [{ type: 'system', subtype: 'status', status: 'x' }, { type: 'system', subtype: '<b>' }] });
  assert.throws(() => parseClaudeStream(extra, expected), /^Error: Unreviewed Claude session start \(system status\)$/);
  assert.deepEqual(claudeStreamShape(extra + 'nope\n').slice(4, 7), ['system/status', 'system/unlabelled', 'result/success']);
  assert.equal(claudeStreamShape(extra + 'nope\n').at(-1), 'invalid');
});
test('stream parser requires an observed overage status', () => {
  const stream = claudeStream(sonnet, answer).split('\n').filter(line => !line.includes('rate_limit_event')).join('\n');
  assert.throws(() => parseClaudeStream(stream, expected), /overage status unavailable/);
});

function liveTask(overrides: { [K in keyof LiveTask]?: LiveTask[K] | undefined } = {}): LiveTask {
  return validateTask({ schemaVersion: 1, taskId: 'claude-task', objective: 'Change value', readPaths: ['value.txt'], writePaths: ['value.txt'],
    checks: [{ id: 'value', executable: process.execPath, args: [], timeoutMs: 5000 }], model: sonnet, effort: 'low', maxModelRequests: 3,
    maxPromptBytes: 65536, maxOutputBytes: 65536, maxRuntimeMs: 60000, draftPr: false, provider: 'anthropic', ...overrides });
}
test('Claude tasks name only the reviewed coding model; provider is optional and closed', () => {
  assert.equal(liveTask().provider, 'anthropic');
  assert.throws(() => liveTask({ model: opus }), /Invalid model routing/);
  assert.throws(() => liveTask({ provider: 'openai', model: sonnet }), /Invalid model routing/);
  assert.throws(() => liveTask({ provider: undefined, model: opus }), /Invalid model routing/);
  assert.throws(() => liveTask({ provider: 'bedrock' as never }), /Invalid provider/);
  assert.equal(liveTask({ provider: undefined, model: 'gpt-6.1-sol' }).provider, undefined);
  assert.deepEqual(CLAUDE_PHASE_MODELS, { plan: opus, coding: sonnet, review: sonnet });
});

test('session requires a subscription sign-in and an owner-only profile; forged sessions are rejected', { skip: fakeCliSkip }, async () => {
  for (const status of [{ loggedIn: false }, { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' },
    { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'bedrock' }]) await assert.rejects(fixtureSession(status), /not signed in/);
  const f = await fixtureSession();
  try {
    assert.equal(f.session.subscriptionType, 'pro');
    const status = f.requests[0]!;
    assert.deepEqual(status.args, ['auth', 'status']);
    assert.equal(status.env.CLAUDE_CONFIG_DIR, f.profile);
    chmodSync(f.profile, 0o750);
    const runner = async () => ({ stdout: '{}', stderr: '', code: 0 });
    await assert.rejects(openClaudeSubscriptionSession({ profileDirectory: f.profile, cli: fakeCli(), scratchRoot: f.scratch, runner }), /owner-only/);
    chmodSync(f.profile, 0o700);
    for (const root of [f.root, join(f.profile, 'state')])
      await assert.rejects(openClaudeSubscriptionSession({ profileDirectory: f.profile, cli: fakeCli(), scratchRoot: f.scratch, separateFrom: ['/nonexistent', root],
        runner }), /separate from project source, run state and worktrees/);
    await assert.rejects(openClaudeSubscriptionSession({ profileDirectory: f.profile, cli: { ...fakeCli() }, scratchRoot: f.scratch, runner }),
      /Untrusted Claude executable pin/);
    assert.deepEqual(readdirSync(f.scratch), [], 'status scratch is removed');
    assert.throws(() => assertClaudeSession(Object.create(f.session.constructor.prototype)), /Untrusted/);
    f.session.close();
    assert.throws(() => assertClaudeSession(f.session), /inactive/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('sandbox profile is deny-default with no broad write and only the reviewed Keychain additions', { skip: fakeCliSkip }, () => {
  const cli = fakeCli();
  const profile = claudeInferenceProfile(cli, '/private/tmp/fm/scratch', '/Users/o/.forgemind/claude-profile', '/Users/o', '/private/var/folders/x/C');
  assert.match(profile, /^\(version 1\)\n\(deny default\)/);
  assert.ok(profile.includes(`(allow process-exec (literal ${JSON.stringify(cli.path)}) (literal "/usr/bin/security"))`));
  assert.match(profile, /\(allow file-write\* \(subpath "\/private\/var\/folders\/x\/C\/mds"\)\)/);
  assert.doesNotMatch(profile, /\(allow file-write\*\)|\(allow file-read\*\)|\(allow mach-lookup\)|\(allow network\*/);
  assert.match(profile, /com\.apple\.system\.opendirectoryd\.membership/);
});

interface Recorder { requests: number[]; reserved: ActionEnvelope[]; finished: string[]; phases: string[]; data: Record<string, unknown>[] }
function fakeAuthority(directory: string, recorder: Recorder) {
  return {
    directory,
    reserveRequest: (bytes: number) => { recorder.requests.push(bytes); return recorder.requests.length; },
    reserve: (envelope: ActionEnvelope) => { recorder.reserved.push(envelope); return { check() {}, finish: (status: string) => { recorder.finished.push(status); } }; },
    phase: (name: string, _source: string, data: Record<string, unknown>) => { recorder.phases.push(name); recorder.data.push(data); },
  };
}
async function modelFixture(stdout: ((request: ProcessRequest) => string) | 'supervised',
  options: { code?: number; source?: () => string; task?: LiveTask; cli?: ClaudeCli } = {}) {
  const f = await fixtureSession(undefined, { supervised: stdout === 'supervised' });
  const state = join(f.root, 'state'); mkdirSync(state, { mode: 0o700 });
  const recorder: Recorder = { requests: [], reserved: [], finished: [], phases: [], data: [] };
  const launches: ProcessRequest[] = [];
  const model = new NativeClaudeModel({ cli: options.cli ?? fakeCli(), task: options.task ?? liveTask(), authority: fakeAuthority(state, recorder),
    session: f.session, source: options.source ?? (() => 'source-a'),
    ...(stdout === 'supervised' ? {} : { runner: async (request: ProcessRequest) => {
      launches.push(request); return { stdout: stdout(request), stderr: 'diagnostic', code: options.code ?? 0 }; } }) });
  return { f, state, model, recorder, launches, cleanup: () => rmSync(f.root, { recursive: true, force: true }) };
}
const modelArg = (request: ProcessRequest) => request.args[request.args.indexOf('--model') + 1]!;

test('each phase runs its owner-fixed model with tools, MCP, settings and persistence disabled', { skip: fakeCliSkip }, async () => {
  const m = await modelFixture(request => claudeStream(modelArg(request), answer));
  try {
    const signal = new AbortController().signal;
    for (const phase of ['plan', 'coding', 'review'] as const)
      assert.deepEqual(await m.model.complete('Instructions', { value: 1 }, { type: 'object' }, signal, phase), answer);
    assert.deepEqual(m.launches.map(modelArg), [opus, sonnet, sonnet]);
    const [launch] = m.launches;
    for (const [flag, value] of [['--tools', ''], ['--max-turns', '3'], ['--mcp-config', '{"mcpServers":{}}'], ['--setting-sources', ''], ['--effort', 'low'],
      ['--output-format', 'stream-json'], ['--permission-prompts', 'none']] as const)
      assert.equal(launch!.args[launch!.args.indexOf(flag) + 1], value, flag);
    for (const flag of ['--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands', '--safe-mode'])
      assert.ok(launch!.args.includes(flag), flag);
    assert.ok(!launch!.args.includes('--fallback-model'));
    assert.equal(launch!.env.CLAUDE_CONFIG_DIR, m.f.profile);
    assert.equal(launch!.env.DISABLE_TELEMETRY, '1');
    assert.equal(launch!.env.CLAUDE_CODE_MAX_RETRIES, '0');
    assert.equal(launch!.executableSha256, fakeCli().sha256);
    assert.ok(!Object.keys(launch!.env).some(key => /ANTHROPIC|OAUTH|TOKEN|API_KEY/.test(key)), 'no credential variables');
    assert.match(launch!.input!, /Task input \(untrusted evidence\):\n\{"value":1\}/);
    assert.equal(m.recorder.requests.length, 3);
    assert.deepEqual(m.recorder.finished, ['completed', 'completed', 'completed']);
    const detail = m.recorder.reserved[0]!.detail as Record<string, unknown>;
    assert.equal(m.recorder.reserved[0]!.kind, 'provider');
    assert.equal(detail.model, opus); assert.equal(detail.phase, 'plan'); assert.equal(detail.fallback, false);
    assert.equal(detail.credential, 'owner-claude-subscription');
    assert.deepEqual(m.recorder.phases, ['model-usage', 'model-usage', 'model-usage']);
    assert.deepEqual(readdirSync(m.state), [], 'per-call scratch is removed');
  } finally { m.cleanup(); }
});

test('model refuses calls without a phase, for non-Claude tasks, or over the prompt limit before reserving a request', { skip: fakeCliSkip }, async () => {
  const signal = new AbortController().signal;
  for (const [options, call, error] of [
    [{}, (m: NativeClaudeModel) => m.complete('x', {}, {}, signal), /require a pipeline phase/],
    [{ task: liveTask({ provider: undefined, model: 'gpt-6.1-sol' }) }, (m: NativeClaudeModel) => m.complete('x', {}, {}, signal, 'plan'), /not routed to Claude/],
    [{ task: liveTask({ maxPromptBytes: 64 }) }, (m: NativeClaudeModel) => m.complete('x'.repeat(100), {}, {}, signal, 'plan'), /prompt limit/],
    [{ cli: { ...fakeCli() } }, (m: NativeClaudeModel) => m.complete('x', {}, {}, signal, 'plan'), /Untrusted Claude executable pin/],
  ] as const) {
    const m = await modelFixture(request => claudeStream(modelArg(request), answer), options);
    try {
      await assert.rejects(call(m.model), error);
      assert.equal(m.recorder.requests.length, 0); assert.equal(m.launches.length, 0);
    } finally { m.cleanup(); }
  }
});

test('process failure, refusal and source drift fail closed with an indeterminate receipt and no retry', { skip: fakeCliSkip }, async () => {
  const signal = new AbortController().signal;
  let source = 'source-a';
  for (const [stdout, options, error] of [
    [(r: ProcessRequest) => claudeStream(modelArg(r), answer), { code: 1 }, /Claude CLI failed; no automatic retry/],
    [(r: ProcessRequest) => claudeStream(modelArg(r), answer, { result: { stop_reason: 'refusal' } }), {}, /no automatic retry or fallback/],
    [(r: ProcessRequest) => { source = 'source-b'; return claudeStream(modelArg(r), answer); }, { source: () => source }, /Source changed/],
  ] as const) {
    source = 'source-a';
    const m = await modelFixture(stdout, options);
    try {
      await assert.rejects(m.model.complete('x', {}, {}, signal, 'coding'), error);
      assert.equal(m.launches.length, 1);
      assert.deepEqual(m.recorder.finished, ['indeterminate']);
    } finally { m.cleanup(); }
  }
});

const sandboxed = { skip: process.platform !== 'darwin' || fakeCliSkip, timeout: 60000 };
test('the pinned fake runs under the real Claude Seatbelt profile: sign-in, one call, recorded flags and environment', sandboxed, async () => {
  const m = await modelFixture('supervised');
  try {
    assert.equal(m.f.session.subscriptionType, 'pro');
    writeFileSync(join(m.f.profile, 'stream-1.jsonl'), claudeStream(sonnet, answer));
    assert.deepEqual(await m.model.complete('Instructions', { value: 1 }, { type: 'object' }, new AbortController().signal, 'coding'), answer);
    const args = fakeArgs(m.f.profile, 1);
    assert.equal(args[args.indexOf('--model') + 1], sonnet);
    assert.equal(args[args.indexOf('--max-turns') + 1], '3');
    assert.ok(!args.includes('--fallback-model'));
    const env = fakeEnv(m.f.profile, 1);
    assert.ok(env.includes('CLAUDE_CODE_MAX_RETRIES') && env.includes('CLAUDE_CONFIG_DIR'));
    assert.ok(!env.some(key => /ANTHROPIC|OAUTH|TOKEN|API_KEY/.test(key)), 'no credential variables reach the child');
    assert.deepEqual(m.recorder.finished, ['completed']);
    assert.deepEqual(readdirSync(m.state), []);
  } finally { m.cleanup(); }
});

test('a pinned binary that changes before launch is refused with no request made', sandboxed, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fm-claude-drift-'))), path = join(dir, 'claude');
  copyFileSync(fakeCli().path, path); chmodSync(path, 0o755);
  const build = { version: '2.1.308', versionOutput: '2.1.308 (Claude Code)', sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
  const cli = pinClaudeCli(path, build);
  assert.equal(cli.reviewed, false);
  assert.throws(() => pinClaudeCli(path), /not the reviewed build/);
  const m = await modelFixture('supervised', { cli });
  try {
    writeFileSync(join(m.f.profile, 'stream-1.jsonl'), claudeStream(sonnet, answer));
    chmodSync(path, 0o700); appendFileSync(path, '\0'); chmodSync(path, 0o755);
    await assert.rejects(m.model.complete('x', {}, {}, new AbortController().signal, 'coding'), /not the reviewed build/);
    assert.equal(existsSync(join(m.f.profile, 'count')), false, 'the changed binary never ran');
    assert.deepEqual(m.recorder.finished, ['indeterminate']);
  } finally { m.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

test('cancellation and timeout stop the whole sandboxed process tree with an indeterminate receipt', sandboxed, async () => {
  for (const [name, task, abortAfter, error] of [
    ['cancel', liveTask(), 1000, /Cancelled/], ['timeout', liveTask({ maxRuntimeMs: 1500 }), undefined, /Deadline|timed out|Timeout/i],
  ] as const) {
    const m = await modelFixture('supervised', { task });
    try {
      writeFileSync(join(m.f.profile, 'hang'), '');
      const controller = new AbortController();
      if (abortAfter) setTimeout(() => controller.abort(), abortAfter);
      await assert.rejects(m.model.complete('x', {}, {}, controller.signal, 'coding'), error, name);
      const child = Number(readFileSync(join(m.f.profile, 'child.pid'), 'utf8'));
      assert.throws(() => process.kill(child, 0), /ESRCH/, `${name}: forked child was reaped`);
      assert.deepEqual(m.recorder.finished, ['indeterminate']);
    } finally { m.cleanup(); }
  }
});

test('output beyond the task limit and a failing CLI are rejected, and the receipt records why', sandboxed, async () => {
  const big = await modelFixture('supervised', { task: liveTask({ maxOutputBytes: 2048 }) });
  try {
    writeFileSync(join(big.f.profile, 'stream-1.jsonl'), claudeStream(sonnet, { pad: 'x'.repeat(8192) }));
    await assert.rejects(big.model.complete('x', {}, {}, new AbortController().signal, 'coding'), /Output limit|output-limit/);
    assert.deepEqual(big.recorder.finished, ['indeterminate']);
  } finally { big.cleanup(); }
  const failed = await modelFixture('supervised');
  try {
    writeFileSync(join(failed.f.profile, 'fail'), '');
    writeFileSync(join(failed.f.profile, 'stream-1.jsonl'),
      claudeStream(sonnet, answer, { result: { subtype: 'error_during_execution', is_error: true, api_error_status: 429 } }));
    await assert.rejects(failed.model.complete('x', {}, {}, new AbortController().signal, 'coding'), /Claude CLI failed; no automatic retry/);
    assert.deepEqual(failed.recorder.phases, ['model-process-failed']);
    assert.equal((failed.recorder.data[0]!.result as Record<string, unknown>).api_error_status, 429);
    assert.match(String(failed.recorder.data[0]!.diagnostic), /fixture failure/);
  } finally { failed.cleanup(); }
  const rejected = await modelFixture(request => claudeStream(modelArg(request), answer, { result: { safety_stops: 1 } }));
  try {
    await assert.rejects(rejected.model.complete('x', {}, {}, new AbortController().signal, 'review'), /did not complete/);
    assert.deepEqual(rejected.recorder.phases, ['model-rejected']);
    assert.match(String(rejected.recorder.data[0]!.reason), /did not complete/);
    assert.deepEqual(rejected.recorder.data[0]!.events, ['system/init', 'assistant', 'user', 'rate_limit_event', 'result/success']);
  } finally { rejected.cleanup(); }
});
