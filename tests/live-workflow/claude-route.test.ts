import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseClaudeStream } from '../../src/live-workflow/claude-stream.js';
import { assertClaudeSession, openClaudeSubscriptionSession, claudeInferenceProfile } from '../../src/live-workflow/claude-session.js';
import { NativeClaudeModel } from '../../src/live-workflow/claude-cli-model.js';
import { task as validateTask } from '../../src/live-workflow/validation.js';
import { CLAUDE_PHASE_MODELS } from '../../src/live-workflow/routing-profile.js';
import type { ActionEnvelope, LiveTask } from '../../src/live-workflow/contracts.js';
import type { ProcessRequest } from '../../src/live-workflow/process.js';
import { claudeStream, fakeCli, fixtureSession } from './claude-fixture.js';

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
  ['malformed line', '{"type":"system"\n', /Malformed/],
  ['empty output', '', /missing/],
];
for (const [name, stream, error] of rejections)
  test(`stream parser fails closed on ${name}`, () => assert.throws(() => parseClaudeStream(stream, expected), error));
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
  assert.throws(() => liveTask({ provider: 'bedrock' as never }), /Invalid provider/);
  assert.equal(liveTask({ provider: undefined, model: 'gpt-6.1-sol' }).provider, undefined);
  assert.deepEqual(CLAUDE_PHASE_MODELS, { plan: opus, coding: sonnet, review: sonnet });
});

test('session requires a subscription sign-in and an owner-only profile; forged sessions are rejected', async () => {
  for (const status of [{ loggedIn: false }, { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' },
    { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'bedrock' }]) await assert.rejects(fixtureSession(status), /not signed in/);
  const f = await fixtureSession();
  try {
    assert.equal(f.session.subscriptionType, 'pro');
    const status = f.requests[0]!;
    assert.deepEqual(status.args, ['auth', 'status']);
    assert.equal(status.env.CLAUDE_CONFIG_DIR, f.profile);
    chmodSync(f.profile, 0o750);
    await assert.rejects(openClaudeSubscriptionSession({ profileDirectory: f.profile, cli: fakeCli, scratchRoot: f.scratch,
      runner: async () => ({ stdout: '{}', stderr: '', code: 0 }) }), /owner-only/);
    chmodSync(f.profile, 0o700);
    await assert.rejects(openClaudeSubscriptionSession({ profileDirectory: f.profile, cli: fakeCli, scratchRoot: f.scratch, workspace: f.root,
      runner: async () => ({ stdout: '{}', stderr: '', code: 0 }) }), /separate from project source/);
    assert.throws(() => assertClaudeSession(Object.create(f.session.constructor.prototype)), /Untrusted/);
    f.session.close();
    assert.throws(() => assertClaudeSession(f.session), /inactive/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('sandbox profile is deny-default with no broad write and only the reviewed Keychain additions', () => {
  const profile = claudeInferenceProfile(fakeCli, '/private/tmp/fm/scratch', '/Users/o/.forgemind/claude-profile', '/Users/o', '/private/var/folders/x/C');
  assert.match(profile, /^\(version 1\)\n\(deny default\)/);
  assert.match(profile, /\(allow process-exec \(literal "\/fixture\/claude"\) \(literal "\/usr\/bin\/security"\)\)/);
  assert.match(profile, /\(allow file-write\* \(subpath "\/private\/var\/folders\/x\/C\/mds"\)\)/);
  assert.doesNotMatch(profile, /\(allow file-write\*\)|\(allow file-read\*\)|\(allow mach-lookup\)|\(allow network\*/);
  assert.match(profile, /com\.apple\.system\.opendirectoryd\.membership/);
});

interface Recorder { requests: number[]; reserved: ActionEnvelope[]; finished: string[]; phases: string[] }
function fakeAuthority(directory: string, recorder: Recorder) {
  return {
    directory,
    reserveRequest: (bytes: number) => { recorder.requests.push(bytes); return recorder.requests.length; },
    reserve: (envelope: ActionEnvelope) => { recorder.reserved.push(envelope); return { check() {}, finish: (status: string) => { recorder.finished.push(status); } }; },
    phase: (name: string) => { recorder.phases.push(name); },
  };
}
async function modelFixture(stdout: (request: ProcessRequest) => string, options: { code?: number; source?: () => string; task?: LiveTask } = {}) {
  const f = await fixtureSession();
  const state = join(f.root, 'state'); mkdirSync(state, { mode: 0o700 });
  const recorder: Recorder = { requests: [], reserved: [], finished: [], phases: [] };
  const launches: ProcessRequest[] = [];
  const model = new NativeClaudeModel({ cli: fakeCli, task: options.task ?? liveTask(), authority: fakeAuthority(state, recorder), session: f.session,
    source: options.source ?? (() => 'source-a'),
    runner: async request => { launches.push(request); return { stdout: stdout(request), stderr: 'diagnostic', code: options.code ?? 0 }; } });
  return { f, model, recorder, launches, cleanup: () => rmSync(f.root, { recursive: true, force: true }) };
}
const modelArg = (request: ProcessRequest) => request.args[request.args.indexOf('--model') + 1]!;

test('each phase runs its owner-fixed model with tools, MCP, settings and persistence disabled', async () => {
  const m = await modelFixture(request => claudeStream(modelArg(request), answer));
  try {
    const signal = new AbortController().signal;
    for (const phase of ['plan', 'coding', 'review'] as const)
      assert.deepEqual(await m.model.complete('Instructions', { value: 1 }, { type: 'object' }, signal, phase), answer);
    assert.deepEqual(m.launches.map(modelArg), [opus, sonnet, sonnet]);
    const [launch] = m.launches;
    for (const [flag, value] of [['--tools', ''], ['--mcp-config', '{"mcpServers":{}}'], ['--setting-sources', ''], ['--effort', 'low'],
      ['--output-format', 'stream-json'], ['--permission-prompts', 'none']] as const)
      assert.equal(launch!.args[launch!.args.indexOf(flag) + 1], value, flag);
    for (const flag of ['--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands', '--safe-mode'])
      assert.ok(launch!.args.includes(flag), flag);
    assert.ok(!launch!.args.includes('--fallback-model'));
    assert.equal(launch!.env.CLAUDE_CONFIG_DIR, m.f.profile);
    assert.equal(launch!.env.DISABLE_TELEMETRY, '1');
    assert.ok(!Object.keys(launch!.env).some(key => /ANTHROPIC|OAUTH|TOKEN|API_KEY/.test(key)), 'no credential variables');
    assert.match(launch!.input!, /Task input \(untrusted evidence\):\n\{"value":1\}/);
    assert.equal(m.recorder.requests.length, 3);
    assert.deepEqual(m.recorder.finished, ['completed', 'completed', 'completed']);
    const detail = m.recorder.reserved[0]!.detail as Record<string, unknown>;
    assert.equal(m.recorder.reserved[0]!.kind, 'provider');
    assert.equal(detail.model, opus); assert.equal(detail.phase, 'plan'); assert.equal(detail.fallback, false);
    assert.equal(detail.credential, 'owner-claude-subscription');
    assert.deepEqual(m.recorder.phases, ['model-usage', 'model-usage', 'model-usage']);
  } finally { m.cleanup(); }
});

test('model refuses calls without a phase, for non-Claude tasks, or over the prompt limit before reserving a request', async () => {
  const signal = new AbortController().signal;
  for (const [options, call, error] of [
    [{}, (m: NativeClaudeModel) => m.complete('x', {}, {}, signal), /require a pipeline phase/],
    [{ task: liveTask({ provider: undefined, model: 'gpt-6.1-sol' }) }, (m: NativeClaudeModel) => m.complete('x', {}, {}, signal, 'plan'), /not routed to Claude/],
    [{ task: liveTask({ maxPromptBytes: 64 }) }, (m: NativeClaudeModel) => m.complete('x'.repeat(100), {}, {}, signal, 'plan'), /prompt limit/],
  ] as const) {
    const m = await modelFixture(request => claudeStream(modelArg(request), answer), options);
    try {
      await assert.rejects(call(m.model), error);
      assert.equal(m.recorder.requests.length, 0); assert.equal(m.launches.length, 0);
    } finally { m.cleanup(); }
  }
});

test('process failure, refusal and source drift fail closed with an indeterminate receipt and no retry', async () => {
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
