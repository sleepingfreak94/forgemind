import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NativeCursorModel } from '../../src/live-workflow/cursor-cli-model.js';
import type { ActionEnvelope, LiveTask, ToolCodingRequest } from '../../src/live-workflow/contracts.js';
import type { ProcessRequest } from '../../src/live-workflow/process.js';
import { cursorTask, fixture, grok, grokLabel, open } from './cursor-fixture.js';

const skip = process.env.FORGEMIND_NESTED_SANDBOX === '1' ? 'loopback HTTP is denied inside a sandboxed check' : false;
function post(url: string, body: unknown): Promise<{ status: number; json: any }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: target.port, path: target.pathname, method: 'POST',
      headers: { 'content-type': 'application/json', host: `127.0.0.1:${target.port}` } }, res => {
      let text = ''; res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : undefined }));
    });
    req.on('error', reject); req.end(JSON.stringify(body));
  });
}
const rpc = (id: number, method: string, params: unknown = {}) => ({ jsonrpc: '2.0', id, method, params });
const summaryText = '{"summary":"done"}';
const mcpCall = (subtype: string, id: string, result?: unknown) => ({ type: 'tool_call', subtype, call_id: id, session_id: 's', timestamp_ms: 1,
  tool_call: { mcpToolCall: { args: { name: 'forgemind-host_echo', args: {}, toolCallId: id, providerIdentifier: 'forgemind', toolName: 'host_echo', serverIdentifier: 'forgemind' }, result },
    toolCallId: id, startedAtMs: '1' } });
function stream(reported: number, text = summaryText): string {
  const ok = { success: { content: [{ text: { text: '{}' } }], isError: false } };
  const calls = Array.from({ length: reported }, (_, i) => [mcpCall('started', `c${i}`), mcpCall('completed', `c${i}`, ok)]).flat();
  return [
    { type: 'system', subtype: 'init', apiKeySource: 'login', cwd: '/w', session_id: 's', model: grokLabel, permissionMode: 'default' },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'prompt' }] }, session_id: 's' },
    ...calls,
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, session_id: 's' },
    { type: 'result', subtype: 'success', is_error: false, result: text, session_id: 's', request_id: 'r-3' },
  ].map(e => JSON.stringify(e)).join('\n') + '\n';
}
const tools = [{ name: 'host_echo', description: 'echo', inputSchema: { type: 'object' } }];

/** Replays Cursor: reads the work mcp.json, calls the endpoint `calls` times, then reports `reported` tool calls. */
async function toolsModel(calls: number, reported: number, onCall: ToolCodingRequest['call'] = async () => ({ text: '{}', isError: false }), task: LiveTask = cursorTask(grok, { codingMode: 'tools', maxToolCalls: 8, readScope: 'repository' })) {
  const f = fixture(), session = await open(f, 'Free');
  const state = join(f.root, 'state'); mkdirSync(state, { recursive: true, mode: 0o700 });
  const reserved: ActionEnvelope[] = [], finished: string[] = [], phases: [string, any][] = [], launches: ProcessRequest[] = [];
  const urls: string[] = [];
  const authority = { directory: state, reserveRequest: () => 1, phase: (name: string, _s: string, data: unknown) => { phases.push([name, data]); },
    reserve: (e: ActionEnvelope) => { reserved.push(e); return { check() {}, finish: (s: string) => { finished.push(s); } }; } };
  const model = new NativeCursorModel({ cli: f.cli, task, authority, session, source: () => 'src',
    runner: async request => {
      launches.push(request);
      const url = JSON.parse(readFileSync(join(request.cwd!, '.cursor', 'mcp.json'), 'utf8')).mcpServers.forgemind.url as string;
      urls.push(url);
      await post(url, rpc(0, 'initialize', { protocolVersion: '2025-06-18' }));
      await post(url, { jsonrpc: '2.0', method: 'notifications/initialized' });
      for (let i = 0; i < calls; i++) await post(url, rpc(i + 1, 'tools/call', { name: 'host_echo', arguments: {} }));
      return { code: 0, stderr: '', stdout: stream(reported) };
    } });
  let hostCalls = 0;
  const request: ToolCodingRequest = { instructions: 'Code it', input: { a: 1 }, tools, maxToolCalls: 8, assertCurrent() {},
    call: async (n, a) => { hostCalls++; return onCall(n, a); } };
  return { model, request, reserved, finished, phases, launches, urls, hostCalls: () => hostCalls, cleanup: f.close };
}
const signal = () => new AbortController().signal;

test('codeWithTools returns the summary, passes --approve-mcps and records the host tool calls', { skip }, async () => {
  const m = await toolsModel(1, 1);
  try {
    assert.deepEqual(await m.model.codeWithTools(m.request, signal()), { summary: 'done' });
    assert.equal(m.hostCalls(), 1);
    assert.deepEqual(m.finished, ['completed']);
    assert.deepEqual(m.launches[0]!.args.slice(1), ['-p', '--mode', 'ask', '--trust', '--approve-mcps', '--model', grok, '--output-format', 'stream-json']);
    const usage = m.phases.find(([n]) => n === 'model-usage')![1];
    assert.equal(usage.toolCalls, 1); assert.equal(usage.phase, 'coding');
    assert.match(m.launches[0]!.input!, /forgemind MCP host tools[\s\S]*"summary"[\s\S]*Code it[\s\S]*\{"a":1\}/);
  } finally { m.cleanup(); }
});

test('codeWithTools receipt names the coding phase and the MCP grant', { skip }, async () => {
  const m = await toolsModel(1, 1);
  try {
    await m.model.codeWithTools(m.request, signal());
    const detail = m.reserved[0]!.detail as Record<string, any>;
    assert.equal(detail.phase, 'coding');
    assert.deepEqual(Object.keys(detail.mcp).sort(), ['endpointSha256', 'maxToolCalls', 'server', 'tools']);
    assert.equal(detail.mcp.server, 'forgemind'); assert.deepEqual(detail.mcp.tools, ['host_echo']); assert.equal(detail.mcp.maxToolCalls, 8);
    assert.match(detail.mcp.endpointSha256, /^[a-f0-9]{64}$/);
    assert.match(m.urls[0]!, /^http:\/\/127\.0\.0\.1:\d+\/mcp\//);
  } finally { m.cleanup(); }
});

test('codeWithTools refuses a stream count that differs from the host count', { skip }, async () => {
  const m = await toolsModel(1, 2);
  try {
    await assert.rejects(m.model.codeWithTools(m.request, signal()), /Cursor tool calls differ from host tool calls/);
    assert.equal(m.phases.at(-1)![0], 'model-rejected');
    assert.deepEqual(m.finished, ['indeterminate']);
  } finally { m.cleanup(); }
});

test('codeWithTools fails with a host fatal error and records no usage', { skip }, async () => {
  const m = await toolsModel(1, 1, async () => { throw new Error('Source changed outside host tools'); });
  try {
    await assert.rejects(m.model.codeWithTools(m.request, signal()), /Source changed outside host tools/);
    assert.ok(!m.phases.some(([n]) => n === 'model-usage'));
  } finally { m.cleanup(); }
});

test('codeWithTools is refused without tools mode or with a different tool-call budget', { skip }, async () => {
  const plain = await toolsModel(0, 0, undefined, cursorTask());
  try {
    await assert.rejects(plain.model.codeWithTools(plain.request, signal()), /Tools coding mode is not granted/);
    assert.equal(plain.launches.length, 0);
  } finally { plain.cleanup(); }
  const m = await toolsModel(0, 0);
  try {
    await assert.rejects(m.model.codeWithTools({ ...m.request, maxToolCalls: 9 }, signal()), /Tools coding mode is not granted/);
    assert.equal(m.launches.length, 0);
  } finally { m.cleanup(); }
});
