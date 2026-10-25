import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { createSlackHttpsTransport, createSlackWebhookAdapter, sendSlackEnvelope } from '../../src/memory/slack-transport.js';
import type { SlackHttpOpen, SlackTransport } from '../../src/memory/slack-transport.js';
import { slackEnvelope, slackLiteral } from '../../src/memory/slack-envelope.js';
import { weeklyReportLines } from '../../src/memory/weekly-email.js';
import { serialize } from '../../src/context-engine/validation.js';
import { createWeeklyAccumulator, finishWeeklySummary } from '../../src/memory/weekly-summary.js';

// Fake credential shape only; all invocation paths use injected offline transports.
const url = 'https://hooks.slack.com/services/T00000000/B00000000/offline_fixture_not_a_secret';
const summary = finishWeeklySummary(createWeeklyAccumulator({ projectId: 'project', originalRoot: resolve(tmpdir(), 'project'),
  dueAt: 0, lowerExclusive: 0, upperInclusive: 0 }));
function wire(statusCode: number, chunks: readonly Buffer[], check: (options: RequestOptions, body: string) => void = () => {}, aborted = false) {
  let opens = 0, destroyed = 0;
  const open: SlackHttpOpen = (endpoint, options, receive) => {
    opens++; assert.equal(endpoint, url);
    const req = new EventEmitter() as ClientRequest;
    req.destroy = () => { destroyed++; return req; };
    req.end = ((body: string) => {
      check(options, body);
      queueMicrotask(() => {
        const res = new EventEmitter() as IncomingMessage;
        res.statusCode = statusCode; res.destroy = () => { destroyed++; return res; };
        receive(res); chunks.forEach(chunk => res.emit('data', chunk));
        if (aborted) res.emit('aborted');
        res.emit('end');
      });
      return req;
    }) as ClientRequest['end'];
    return req;
  };
  return { open, opens: () => opens, destroyed: () => destroyed };
}
test('native HTTPS path enforces TLS, fixed JSON controls and fragmented exact 200/ok acknowledgment', async () => {
  const w = wire(200, [Buffer.from('o'), Buffer.from('k')], (options, body) => {
    assert.equal(options.method, 'POST'); assert.equal(options.agent, false);
    assert.equal(options.rejectUnauthorized, true); assert.equal(options.maxHeaderSize, 8192);
    assert.equal((options.headers as Record<string, unknown>)['content-length'], Buffer.byteLength(body));
    assert.deepEqual(Object.keys(options.headers!).sort(), ['content-length', 'content-type']);
    const p = JSON.parse(body);
    assert.equal(p.mrkdwn, false); assert.equal(p.parse, 'none');
    assert.equal(p.unfurl_links, false); assert.equal(p.unfurl_media, false);
    assert.ok(!Object.hasOwn(p, 'channel')); assert.ok(!Object.hasOwn(p, 'link_names'));
  });
  const a = createSlackWebhookAdapter({ destinationId: 'team', webhookUrl: url }, createSlackHttpsTransport(w.open));
  assert.deepEqual(await sendSlackEnvelope(a, slackEnvelope(summary, a.destinationId, a.endpointBinding)), { status: 'accepted' });
  assert.equal(w.opens(), 1); assert.ok(!JSON.stringify(a).includes(url));
});
test('non-200/non-ok/oversized/aborted responses are uncertain; no redirects, retries or response text retention', async () => {
  for (const [status, body, cap, aborted] of [
    [201, 'ok', 4096, false], [204, '', 4096, false], [302, 'ok', 4096, false],
    [429, 'retry later', 4096, false], [500, 'secret-provider-text', 4096, false],
    [200, 'OK', 4096, false], [200, 'ok\n', 4096, false], [200, ' ok', 4096, false],
    [200, 'ok', 1, false], [200, '', 4096, false], [200, 'ok', 4096, true]
  ] as const) {
    const w = wire(status, [Buffer.from(body)], () => {}, aborted);
    const a = createSlackWebhookAdapter({ destinationId: 'team', webhookUrl: url, maxResponseBytes: cap }, createSlackHttpsTransport(w.open));
    const result = await sendSlackEnvelope(a, slackEnvelope(summary, a.destinationId, a.endpointBinding));
    assert.deepEqual(result, { status: 'uncertain' }); assert.equal(w.opens(), 1);
    assert.ok(!JSON.stringify(result).includes('secret-provider-text'));
    if (body.length > cap) assert.ok(w.destroyed() > 0);
  }
});
test('deadline aborts even if a fake transport ignores cancellation; throws never echo secrets', async () => {
  let signal: AbortSignal | undefined;
  const a = createSlackWebhookAdapter({ destinationId: 'team', webhookUrl: url, deadlineMs: 10 }, async req => {
    signal = req.signal; return new Promise(() => {});
  });
  assert.equal((await sendSlackEnvelope(a, slackEnvelope(summary, a.destinationId, a.endpointBinding))).status, 'uncertain');
  assert.equal(signal?.aborted, true);
  const b = createSlackWebhookAdapter({ destinationId: 'team', webhookUrl: url }, async () => { throw Error(url); });
  assert.deepEqual(await sendSlackEnvelope(b, slackEnvelope(summary, b.destinationId, b.endpointBinding)), { status: 'uncertain' });
});
test('forged responses, getters and mutated envelope fields fail before I/O without accessor evaluation', async () => {
  let touched = false;
  const getter = Object.defineProperty({ acknowledged: true }, 'statusCode', { enumerable: true, get() { touched = true; return 200; } });
  const transports: SlackTransport[] = [async () => getter as { statusCode: number; acknowledged: boolean },
    async () => ({ statusCode: 200, acknowledged: true, text: url }), async () => ({ statusCode: 0, acknowledged: true })];
  for (const transport of transports) {
    const a = createSlackWebhookAdapter({ destinationId: 'team', webhookUrl: url }, transport);
    assert.deepEqual(await sendSlackEnvelope(a, slackEnvelope(summary, a.destinationId, a.endpointBinding)), { status: 'uncertain' });
  }
  let calls = 0;
  const a = createSlackWebhookAdapter({ destinationId: 'team', webhookUrl: url }, async () => { calls++; return { statusCode: 200, acknowledged: true }; });
  const e = slackEnvelope(summary, a.destinationId, a.endpointBinding);
  const hostile = Object.defineProperty({ ...e }, 'summary', { enumerable: true, get() { touched = true; return summary; } });
  assert.equal((await sendSlackEnvelope(a, hostile)).status, 'uncertain');
  assert.equal((await sendSlackEnvelope(a, { ...e, payload: { ...e.payload, channel: 'other' } } as typeof e)).status, 'uncertain');
  assert.equal(calls, 0); assert.equal(touched, false);
});
test('endpoint allowlist rejects arbitrary hosts, GovSlack, credentials, queries, encoded paths and URL aliases', () => {
  const base = { destinationId: 'team', webhookUrl: url };
  let touched = false;
  const getter = Object.defineProperty({ ...base }, 'webhookUrl', { enumerable: true, get() { touched = true; return url; } });
  for (const raw of [getter, new Proxy(base, {}), { ...base, extra: 1 }, { ...base, deadlineMs: 30001 },
    { ...base, maxResponseBytes: 16385 }, ...[
      url.replace('https:', 'http:'), url.replace('hooks.slack.com', 'hooks.slack.com.evil.invalid'),
      url.replace('hooks.slack.com', 'hooks.slack-gov.com'), url.replace('hooks.slack.com', '127.0.0.1'),
      url.replace('hooks.slack.com', 'user:secret@hooks.slack.com'), url + '?secret=x', url + '#fragment',
      url.replace('hooks.slack.com', 'hooks.slack.com:443'), url.replace('/services/', '/services/%54'),
      url.replace('/services/', '/services/../services/'), url.replace('/services/', '/other/'),
      url.replace('https://', 'https:\\\\'), url + '\n', url.replace('hooks.slack.com', 'HOOKS.SLACK.COM')
    ].map(webhookUrl => ({ ...base, webhookUrl }))]) {
    assert.throws(() => createSlackWebhookAdapter(raw), { message: 'Invalid private Slack owner configuration' });
  }
  assert.equal(touched, false);
  const a = createSlackWebhookAdapter(base), b = createSlackWebhookAdapter({ ...base, webhookUrl: url + '2' });
  assert.notEqual(a.endpointBinding, b.endpointBinding);
});

test('rendered readable body is posted when it fits', async () => {
  let body = '';
  const a = createSlackWebhookAdapter({ destinationId: 'team', webhookUrl: url }, async req => { body = req.body; return { statusCode: 200, acknowledged: true }; });
  const e = slackEnvelope(summary, a.destinationId, a.endpointBinding);
  assert.equal((await sendSlackEnvelope(a, e)).status, 'accepted');
  const p = JSON.parse(body);
  assert.ok(body.startsWith('{')); assert.ok(p.text.startsWith('ForgeMind weekly report')); assert.ok(p.text.endsWith(e.payload.text));
});
test('envelope whose rendered body exceeds the budget posts the exact original payload', async () => {
  let found: ReturnType<typeof slackEnvelope> | undefined;
  // '&' expands to '&amp;' in the literal payload, so the root length steers the payload size.
  for (let n = 1; n <= 900 && !found; n++) {
    let e: ReturnType<typeof slackEnvelope>;
    try {
      const s = finishWeeklySummary(createWeeklyAccumulator({ projectId: 'project', originalRoot: resolve('/', 'project', '&'.repeat(n)),
        dueAt: 0, lowerExclusive: 0, upperInclusive: 0 }));
      e = slackEnvelope(s, 'team', 'a'.repeat(64), 4096);
    } catch { continue; }
    const rendered = serialize({ ...e.payload, text: slackLiteral(weeklyReportLines(e.summary)) + '\n\n' + e.payload.text });
    if (Buffer.byteLength(serialize(e.payload)) <= 4096 && Buffer.byteLength(rendered) > 4096) found = e;
  }
  assert.ok(found);
  let body = '', calls = 0;
  const a = createSlackWebhookAdapter({ destinationId: 'team', webhookUrl: url }, async req => { calls++; body = req.body; return { statusCode: 200, acknowledged: true }; });
  const e = slackEnvelope(found.summary, a.destinationId, a.endpointBinding, 4096);
  const rendered = serialize({ ...e.payload, text: slackLiteral(weeklyReportLines(e.summary)) + '\n\n' + e.payload.text });
  assert.ok(Buffer.byteLength(rendered) > 4096);
  assert.equal((await sendSlackEnvelope(a, e)).status, 'accepted');
  assert.equal(calls, 1); assert.equal(body, serialize(e.payload));
});
test('native transport independently rejects unsupported endpoints and request bounds before opening', async () => {
  let calls = 0;
  const transport = createSlackHttpsTransport(() => { calls++; throw Error('must not open'); });
  for (const input of [
    { url: 'https://arbitrary.invalid/path', body: '{}' },
    { url, body: 'x'.repeat(24577) }
  ]) await assert.rejects(transport({ ...input, signal: new AbortController().signal, maxResponseBytes: 4096 }));
  assert.equal(calls, 0);
});
