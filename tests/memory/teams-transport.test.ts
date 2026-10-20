import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { createTeamsHttpsTransport, createTeamsWorkflowAdapter, sendTeamsEnvelope } from '../../src/memory/teams-transport.js';
import type { TeamsHttpOpen, TeamsTransport } from '../../src/memory/teams-transport.js';
import { teamsEnvelope } from '../../src/memory/teams-envelope.js';
import { createWeeklyAccumulator, finishWeeklySummary } from '../../src/memory/weekly-summary.js';

const url = 'https://workflow.invalid/private?sig=fake-secret', token = 'fake-private-token';
const summary = finishWeeklySummary(createWeeklyAccumulator({ projectId: 'project', originalRoot: '/project',
  dueAt: 0, lowerExclusive: 0, upperInclusive: 0 }));
function wire(statusCode: number, chunks: readonly Buffer[], check: (options: RequestOptions, body: string) => void = () => {}) {
  let opens = 0, destroyed = 0;
  const open: TeamsHttpOpen = (_url, options, receive) => {
    opens++;
    const req = new EventEmitter() as ClientRequest;
    req.destroy = () => { destroyed++; return req; };
    req.end = ((body: string) => {
      check(options, body);
      queueMicrotask(() => {
        const res = new EventEmitter() as IncomingMessage;
        res.statusCode = statusCode; res.destroy = () => { destroyed++; return res; };
        receive(res); chunks.forEach(chunk => res.emit('data', chunk)); res.emit('end');
      });
      return req;
    }) as ClientRequest['end'];
    return req;
  };
  return { open, opens: () => opens, destroyed: () => destroyed };
}
test('native HTTP adapter path uses single HTTPS POST with fixed framing, no agent/redirects and response bound', async () => {
  const w = wire(202, [Buffer.from('accepted')], (options, body) => {
    assert.equal(options.method, 'POST'); assert.equal(options.agent, false); assert.equal(options.maxHeaderSize, 8192);
    assert.equal((options.headers as Record<string, unknown>).authorization, 'Bearer ' + token);
    assert.equal((options.headers as Record<string, unknown>)['content-length'], Buffer.byteLength(body));
    assert.equal(JSON.parse(body).text.includes('historical evidence'), true);
  });
  const a = createTeamsWorkflowAdapter({ destinationId: 'team', webhookUrl: url, bearerToken: token }, createTeamsHttpsTransport(w.open));
  assert.equal((await sendTeamsEnvelope(a, teamsEnvelope(summary, a.destinationId, a.endpointBinding))).status, 'accepted');
  assert.equal(w.opens(), 1); assert.ok(!JSON.stringify(a).includes(token)); assert.ok(!JSON.stringify(a).includes(url));
  const big = wire(202, [Buffer.alloc(3), Buffer.alloc(3)]);
  const b = createTeamsWorkflowAdapter({ destinationId: 'team', webhookUrl: url, maxResponseBytes: 4 }, createTeamsHttpsTransport(big.open));
  assert.equal((await sendTeamsEnvelope(b, teamsEnvelope(summary, b.destinationId, b.endpointBinding))).status, 'uncertain');
  assert.ok(big.destroyed() > 0);
});
test('all non-2xx including redirects and throttling remain uncertain with no retry or follow', async () => {
  for (const status of [301, 302, 400, 401, 403, 429, 500, 503]) {
    const w = wire(status, []), a = createTeamsWorkflowAdapter({ destinationId: 'team', webhookUrl: url }, createTeamsHttpsTransport(w.open));
    assert.equal((await sendTeamsEnvelope(a, teamsEnvelope(summary, a.destinationId, a.endpointBinding))).status, 'uncertain');
    assert.equal(w.opens(), 1);
  }
});
test('deadline aborts and returns uncertainty even if injected transport ignores cancellation', async () => {
  let signal: AbortSignal | undefined;
  const a = createTeamsWorkflowAdapter({ destinationId: 'team', webhookUrl: url, deadlineMs: 10 }, async req => {
    signal = req.signal; return new Promise(() => {});
  });
  assert.equal((await sendTeamsEnvelope(a, teamsEnvelope(summary, a.destinationId, a.endpointBinding))).status, 'uncertain');
  assert.equal(signal?.aborted, true);
});
test('transport throws/invalid status/getters are redacted; malformed envelopes never reach transport', async () => {
  let touched = false;
  const getter = Object.defineProperty({}, 'statusCode', { enumerable: true, get() { touched = true; return 200; } });
  const transports: TeamsTransport[] = [async () => { throw Error(url + token); }, async () => getter as { statusCode: number },
    async () => ({ statusCode: 0 }), async () => ({ statusCode: 200, secret: token })];
  for (const transport of transports) {
    const a = createTeamsWorkflowAdapter({ destinationId: 'team', webhookUrl: url }, transport);
    const result = await sendTeamsEnvelope(a, teamsEnvelope(summary, a.destinationId, a.endpointBinding));
    assert.deepEqual(result, { status: 'uncertain' }); assert.ok(!JSON.stringify(result).includes(token));
  }
  let calls = 0;
  const a = createTeamsWorkflowAdapter({ destinationId: 'team', webhookUrl: url }, async () => { calls++; return { statusCode: 200 }; });
  const e = teamsEnvelope(summary, a.destinationId, a.endpointBinding);
  const malicious = Object.defineProperty({ ...e }, 'summary', { enumerable: true, get() { touched = true; return summary; } });
  assert.equal((await sendTeamsEnvelope(a, malicious)).status, 'uncertain');
  assert.equal((await sendTeamsEnvelope(a, { ...e, payload: { text: 'changed' } })).status, 'uncertain');
  assert.equal(calls, 0); assert.equal(touched, false);
});
test('only explicit private owner options accepted; endpoint identity changes with URL, not token', () => {
  const base = { destinationId: 'team', webhookUrl: url };
  let touched = false;
  const getter = Object.defineProperty({ ...base }, 'webhookUrl', { enumerable: true, get() { touched = true; return url; } });
  for (const raw of [getter, new Proxy(base, {}), { ...base, extra: 1 }, { ...base, bearerToken: 'a\r\nb' },
    { ...base, deadlineMs: 30001 }, { ...base, maxResponseBytes: 16385 },
    ...['http://workflow.invalid/path', 'https://u:p@workflow.invalid/path', 'https://workflow.invalid/path#secret',
      'https://workflow.invalid/', 'https://workflow.invalid:8443/path'].map(webhookUrl => ({ ...base, webhookUrl }))]) {
    assert.throws(() => createTeamsWorkflowAdapter(raw), { message: 'Invalid private Teams owner configuration' });
  }
  assert.equal(touched, false);
  const a = createTeamsWorkflowAdapter(base), b = createTeamsWorkflowAdapter({ ...base, bearerToken: token });
  assert.equal(a.endpointBinding, b.endpointBinding);
  assert.notEqual(a.endpointBinding, createTeamsWorkflowAdapter({ ...base, webhookUrl: url + '2' }).endpointBinding);
});
