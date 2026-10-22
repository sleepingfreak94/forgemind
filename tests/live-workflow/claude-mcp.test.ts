import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startMcpEndpoint } from '../../src/live-workflow/claude-mcp-server.js';
import { codingTools } from '../../src/live-workflow/coding-tools.js';
import { NativeClaudeModel } from '../../src/live-workflow/claude-cli-model.js';
import { task as validateTask } from '../../src/live-workflow/validation.js';
import type { LiveTask, ToolCodingRequest } from '../../src/live-workflow/contracts.js';
import type { ProcessRequest } from '../../src/live-workflow/process.js';
import { claudeStream, fakeCli, fakeCliSkip, fixtureSession } from './claude-fixture.js';

const loopback = { skip: process.env.FORGEMIND_NESTED_SANDBOX === '1' ? 'loopback HTTP is denied inside a sandboxed check' : false };
function post(url: string, body: unknown, headers: Record<string, string> = {}, method = 'POST'): Promise<{ status: number; json: any }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: target.port, path: target.pathname, method,
      headers: { 'content-type': 'application/json', host: `127.0.0.1:${target.port}`, ...headers } }, res => {
      let text = ''; res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : undefined }));
    });
    req.on('error', reject); req.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
}
const rpc = (id: number, method: string, params: unknown = {}) => ({ jsonrpc: '2.0', id, method, params });

test('the MCP endpoint serves exactly the host tools on loopback and refuses everything else', loopback, async () => {
  const seen: unknown[] = [];
  let fatal: Error | undefined;
  const endpoint = await startMcpEndpoint(codingTools, async (name, args) => {
    seen.push([name, args]);
    if ((args as { path?: string }).path === 'boom') throw new Error('host stopped');
    return { text: '{"ok":true}', isError: name === 'host_check' };
  }, error => { fatal = error; });
  try {
    assert.match(endpoint.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/[A-Za-z0-9_-]{32}$/);
    const init = await post(endpoint.url, rpc(1, 'initialize', { protocolVersion: '2025-06-18' }));
    assert.equal(init.json.result.protocolVersion, '2025-06-18');
    assert.deepEqual(init.json.result.capabilities, { tools: { listChanged: false } });
    assert.equal((await post(endpoint.url, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    assert.deepEqual((await post(endpoint.url, rpc(2, 'tools/list'))).json.result.tools.map((t: { name: string }) => t.name),
      ['host_read', 'host_apply', 'host_check']);
    const read = await post(endpoint.url, rpc(3, 'tools/call', { name: 'host_read', arguments: { path: 'a' } }));
    assert.deepEqual(read.json.result, { content: [{ type: 'text', text: '{"ok":true}' }], isError: false });
    assert.equal((await post(endpoint.url, rpc(4, 'tools/call', { name: 'host_check', arguments: { id: 'x' } }))).json.result.isError, true);
    assert.equal((await post(endpoint.url, rpc(5, 'tools/call', { name: 'Bash', arguments: {} }))).json.error.code, -32602);
    assert.equal((await post(endpoint.url, rpc(6, 'resources/list'))).json.error.code, -32601);
    const wrongPath = endpoint.url.replace(/\/mcp\/.*/, '/mcp/guess');
    assert.equal((await post(wrongPath, rpc(7, 'tools/list'))).status, 404);
    assert.equal((await post(endpoint.url, rpc(8, 'tools/list'), { host: 'evil.example:80' })).status, 404, 'DNS-rebinding host refused');
    assert.equal((await post(endpoint.url, rpc(9, 'tools/list'), { origin: 'https://evil.example' })).status, 404, 'browser origin refused');
    assert.equal((await post(endpoint.url, '', {}, 'GET')).status, 405);
    assert.equal((await post(endpoint.url, [rpc(10, 'ping')])).status, 400, 'batches refused');
    assert.equal((await post(endpoint.url, 'x'.repeat(4194305))).status, 413);
    assert.equal(endpoint.calls, 2);
    assert.equal((await post(endpoint.url, rpc(11, 'tools/call', { name: 'host_read', arguments: { path: 'boom' } }))).json.error.message, 'Session stopped');
    assert.equal(fatal?.message, 'host stopped'); assert.equal(endpoint.fatal, fatal);
    assert.equal((await post(endpoint.url, rpc(12, 'tools/call', { name: 'host_read', arguments: { path: 'a' } }))).json.error.message, 'Session stopped');
    assert.equal(seen.length, 3, 'no call reaches the host after a fatal error');
  } finally { await endpoint.close(); }
});

const sonnet = 'claude-sonnet-5-5';
const mcpTools = ['mcp__forgemind__host_read', 'mcp__forgemind__host_apply', 'mcp__forgemind__host_check'];
function toolsTask(): LiveTask {
  return validateTask({ schemaVersion: 1, taskId: 'claude-tools', objective: 'x', readPaths: ['v.txt'], writePaths: ['v.txt'],
    checks: [{ id: 'c', executable: process.execPath, args: [], timeoutMs: 5000 }], model: sonnet, provider: 'anthropic', effort: 'low',
    maxModelRequests: 3, maxPromptBytes: 65536, maxOutputBytes: 262144, maxRuntimeMs: 60000, draftPr: false, codingMode: 'tools', maxToolCalls: 4 });
}
/** Replays Claude: calls the endpoint named in --mcp-config `calls` times, then reports `reported` tool uses. */
async function toolsModel(calls: number, reported: number, onCall: ToolCodingRequest['call'] = async () => ({ text: '{}', isError: false })) {
  const f = await fixtureSession();
  const state = join(f.root, 'state'); mkdirSync(state, { mode: 0o700 });
  const phases: [string, any][] = [], launches: ProcessRequest[] = [];
  const authority = { directory: state, reserveRequest: () => 1, phase: (name: string, _s: string, data: unknown) => { phases.push([name, data]); },
    reserve: () => ({ check() {}, finish() {} }) };
  const model = new NativeClaudeModel({ cli: fakeCli(), task: toolsTask(), authority, session: f.session, source: () => 'source-a',
    runner: async request => {
      launches.push(request);
      const url = JSON.parse(request.args[request.args.indexOf('--mcp-config') + 1]!).mcpServers.forgemind.url;
      await post(url, rpc(0, 'initialize', { protocolVersion: '2025-06-18' }));
      for (let i = 0; i < calls; i++) await post(url, rpc(i + 1, 'tools/call', { name: 'host_read', arguments: { path: 'v.txt' } }));
      const use = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: mcpTools[0], input: { path: 'v.txt' } }] } };
      return { code: 0, stderr: '', stdout: claudeStream(sonnet, { summary: 'done' }, { init: { tools: ['StructuredOutput', ...mcpTools],
        mcp_servers: [{ name: 'forgemind', status: 'connected', source: 'dynamic' }] }, extra: Array(reported).fill(use) }) };
    } });
  const request: ToolCodingRequest = { instructions: 'Code it', input: { a: 1 }, tools: codingTools, call: onCall, maxToolCalls: 4, assertCurrent() {} };
  return { model, request, phases, launches, cleanup: () => rmSync(f.root, { recursive: true, force: true }) };
}

test('codeWithTools runs Sonnet with only the host tools, loopback network and an exact tool-call account', { ...loopback, skip: loopback.skip || fakeCliSkip }, async () => {
  const m = await toolsModel(2, 2);
  try {
    assert.deepEqual(await m.model.codeWithTools(m.request, new AbortController().signal), { summary: 'done' });
    const [launch] = m.launches, args = launch!.args;
    assert.equal(args[args.indexOf('--model') + 1], sonnet);
    assert.equal(args[args.indexOf('--tools') + 1], '');
    assert.equal(args[args.indexOf('--allowedTools') + 1], mcpTools.join(','));
    assert.equal(args[args.indexOf('--max-turns') + 1], '7');
    assert.ok(args.includes('--strict-mcp-config') && !args.includes('--safe-mode') && !args.includes('--fallback-model'));
    const port = new URL(JSON.parse(args[args.indexOf('--mcp-config') + 1]!).mcpServers.forgemind.url).port;
    assert.ok(launch!.profile.includes(`(remote ip "localhost:${port}")`), 'sandbox reaches only this loopback port');
    const usage = m.phases.find(([name]) => name === 'model-usage')![1];
    assert.equal(usage.toolCalls, 2); assert.equal(usage.phase, 'coding');
  } finally { m.cleanup(); }
});

test('codeWithTools fails closed on a tool-call mismatch, a host stop or a mode that was not granted', { ...loopback, skip: loopback.skip || fakeCliSkip }, async () => {
  const mismatch = await toolsModel(1, 2);
  try {
    await assert.rejects(mismatch.model.codeWithTools(mismatch.request, new AbortController().signal), /differ from host tool calls/);
    assert.equal(mismatch.phases.at(-1)![0], 'model-rejected');
  } finally { mismatch.cleanup(); }
  const stopped = await toolsModel(1, 1, async () => { throw new Error('Source changed outside host tools'); });
  try {
    await assert.rejects(stopped.model.codeWithTools(stopped.request, new AbortController().signal), /Source changed outside host tools/);
  } finally { stopped.cleanup(); }
  const ungranted = await toolsModel(0, 0);
  try {
    await assert.rejects(ungranted.model.codeWithTools({ ...ungranted.request, maxToolCalls: 9 }, new AbortController().signal), /not granted/);
    assert.equal(ungranted.launches.length, 0);
  } finally { ungranted.cleanup(); }
});
