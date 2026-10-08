import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatGPTStore } from '../../src/live-workflow/chatgpt-store.js';
import { openChatGPTPlanSession } from '../../src/live-workflow/chatgpt-plan.js';
import { startBroker } from '../../src/live-workflow/provider.js';
import type { LiveTask } from '../../src/live-workflow/contracts.js';

function connection(subject = 'subject-a', lifetime = 3600000, email: string | undefined = 'owner@example.invalid') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fm-plan-'))), directory = join(root, 'account');
  const store = new ChatGPTStore(directory, process.cwd(), true);
  try {
    store.lock();
    store.save({ schemaVersion: 1, hostId: store.getHostId(), clientId: 'oaiapp_fixture', subject,
      accessToken: 'synthetic-access-token', idToken: 'synthetic.signed.identity', scope: 'chatgpt.tokens.use.direct',
      expiresAt: Date.now() + lifetime, ...(email ? { email } : {}) });
  } finally { store.close(); }
  let prompt = '';
  return { directory, root, get prompt() { return prompt; },
    open: () => openChatGPTPlanSession(directory, { isTTY: true, confirm: async text => {
      prompt = text; return text.match(/Enter exactly "([^"]+)"/)![1]!;
    } }), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
function change(directory: string, updates: Record<string, unknown>) {
  const path = join(directory, 'chatgpt-connection.json');
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), ...updates }));
}

test('owner review distinguishes accounts sharing a client and exposes only account matching information', async () => {
  const a = connection(), b = connection('subject-b');
  try {
    const one = await a.open(), two = await b.open();
    assert.notEqual(one.binding().accountSha256, two.binding().accountSha256);
    assert.notEqual(a.prompt.match(/Enter exactly "([^"]+)"/)![1], b.prompt.match(/Enter exactly "([^"]+)"/)![1]);
    for (const text of [a.prompt, b.prompt]) {
      assert.match(text, /Signed account email: owner@example.invalid/);
      assert.match(text, /Match this email/);
      assert.match(text, /owner confirmation, not an automatic inspection/);
      assert.doesNotMatch(text, /synthetic-access-token|synthetic.signed.identity/);
    }
    assert.ok(a.prompt.includes(a.directory));
    assert.doesNotMatch(JSON.stringify(one.binding()), /synthetic-access-token|owner@example.invalid/);
  } finally { a.cleanup(); b.cleanup(); }
});

test('denial, missing verified email and credential changes during owner review cannot mint sessions', async () => {
  const f = connection(), noEmail = connection('subject-no-email', 3600000, '');
  try {
    await assert.rejects(openChatGPTPlanSession(f.directory, { isTTY: true, confirm: async () => 'yes' }), /not confirmed/);
    await assert.rejects(noEmail.open(), /signed account email/);
    await assert.rejects(openChatGPTPlanSession(f.directory, { isTTY: true, confirm: async text => {
      change(f.directory, { email: 'different@example.invalid' });
      return text.match(/Enter exactly "([^"]+)"/)![1]!;
    } }), /changed during/);
  } finally { f.cleanup(); noEmail.cleanup(); }
});

for (const field of ['accessToken', 'idToken', 'email', 'scope', 'expiresAt', 'disconnect'])
  test('reviewed session rejects stored connection drift: ' + field, async () => {
    const f = connection();
    try {
      const session = await f.open();
      if (field === 'disconnect') unlinkSync(join(f.directory, 'chatgpt-connection.json'));
      else change(f.directory, { [field]: field === 'expiresAt' ? Date.now() + 1800000 : field === 'scope' ? 'openid chatgpt.tokens.use.direct' : field === 'idToken' ? 'different.signed.identity' : 'changed' });
      assert.throws(() => session.assertActive());
      await assert.rejects(session.request('{}', new AbortController().signal));
    } finally { f.cleanup(); }
  });

test('production session pins official OAuth endpoint, omits ambient credentials and rejects fixture mixing', async () => {
  const f = connection(), previous = globalThis.fetch;
  let calls = 0;
  try {
    const session = await f.open();
    globalThis.fetch = async (url, init) => {
      calls++;
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal(init?.redirect, 'error');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-access-token');
      assert.equal(new Headers(init?.headers).get('chatgpt-account-id'), null);
      assert.equal(init?.body, '{"store":false}');
      return new Response('fixture');
    };
    assert.equal(await (await session.request('{"store":false}', new AbortController().signal)).text(), 'fixture');
    assert.equal(calls, 1);
    await assert.rejects(startBroker({ task: null!, authority: null!, source: () => '', signal: new AbortController().signal,
      planSession: session, transport: previous }), /cannot be combined/);
    await assert.rejects(startBroker({ task: null!, authority: null!, source: () => '', signal: new AbortController().signal,
      planSession: session, credentials: () => ({ accessToken: 'other', accountId: 'other' }) }), /cannot be combined/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = previous; f.cleanup(); }
});

for (const phase of ['headers', 'body'])
  test('session expiry actively cancels stalled ' + phase, async t => {
    // Setup time must not consume the expiry window under parallel suite load.
    // Keep native AbortSignal timers real: they still cancel the stalled fetch.
    const now = Date.now();
    t.mock.timers.enable({ apis: ['Date'], now });
    const f = connection('expiring', 200), previous = globalThis.fetch;
    const keepAlive = setTimeout(() => {}, 2000);
    let aborted = false;
    try {
      const session = await f.open();
      globalThis.fetch = async (_url, init) => {
        const signal = init!.signal!;
        if (phase === 'headers') return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
        });
        return new Response(new ReadableStream({ start(controller) {
          signal.addEventListener('abort', () => { aborted = true; controller.error(signal.reason); }, { once: true });
        } }));
      };
      await assert.rejects(async () => {
        const response = await session.request('{}', new AbortController().signal);
        await response.text();
      });
      assert.equal(aborted, true);
      t.mock.timers.setTime(now + 201);
      assert.throws(() => session.assertActive());
    } finally { clearTimeout(keepAlive); globalThis.fetch = previous; f.cleanup(); }
  });

const task: LiveTask = { schemaVersion: 1, taskId: 'public-route', objective: 'fixture', readPaths: ['value.txt'],
  writePaths: ['value.txt'], checks: [], model: 'fixture-model', effort: 'low', maxModelRequests: 3,
  maxPromptBytes: 20000, maxOutputBytes: 20000, maxRuntimeMs: 5000, draftPr: false };
for (const scenario of ['completed-crlf', 'quota', 'failed-stream'])
  test('authenticated broker handles public route ' + scenario + ' without fallback or replay', async () => {
    const f = connection(), nativeFetch = globalThis.fetch, actions: string[] = [], receipts: unknown[] = [];
    let calls = 0, observedReasoning: unknown;
    const source = 'a'.repeat(64);
    const authority = {
      reserveRequest: () => 1,
      reserve: (request: unknown) => { receipts.push(request); return { check: () => {}, finish: (status: string) => { actions.push(status); } }; },
    };
    let broker: Awaited<ReturnType<typeof startBroker>> | undefined;
    try {
      const session = await f.open();
      globalThis.fetch = async (url, init) => {
        if (String(url).startsWith('http://127.0.0.1:')) return nativeFetch(url, init);
        assert.equal(url, 'https://api.openai.com/v1/responses'); calls++;
        const payload = JSON.parse(String(init?.body));
        observedReasoning = payload.reasoning;
        assert.equal(payload.store, false); assert.deepEqual(payload.tools, []);
        if (scenario === 'quota') return new Response('synthetic-secret-provider-body', { status: 429 });
        const event = scenario === 'failed-stream' ? { type: 'response.failed', response: { error: { message: 'synthetic-secret-provider-body' } } } :
          { type: 'response.completed', response: { status: 'completed', model: task.model } };
        const bytes = Buffer.from('data:' + JSON.stringify(event) + '\r\n\r\n');
        // Exercise a CRLF boundary split across chunks and data fields without a space.
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(bytes.subarray(0, bytes.length - 1)); controller.enqueue(bytes.subarray(bytes.length - 1)); controller.close();
        } }));
      };
      broker = await startBroker({ task, source: () => source, authority, planSession: session, signal: AbortSignal.timeout(5000) });
      const dispatch = () => nativeFetch(`http://127.0.0.1:${broker!.port}/v1/responses`, { method: 'POST',
        headers: { authorization: 'Bearer ' + broker!.token }, body: JSON.stringify({ model: task.model, stream: true, input: [] }) });
      let responseText = '';
      try { const response = await dispatch(); responseText = await response.text(); } catch {}
      assert.equal(calls, 1);
      assert.deepEqual(observedReasoning, { effort: task.effort });
      assert.doesNotMatch(responseText, /synthetic-secret-provider-body/);
      if (scenario === 'completed-crlf') { broker.assertSuccess(); assert.equal(actions.at(-1), 'completed'); }
      else { assert.throws(() => broker!.assertSuccess()); assert.equal(actions.at(-1), 'indeterminate'); }
      assert.doesNotMatch(JSON.stringify(receipts), /synthetic-access-token/);
      assert.match(JSON.stringify(receipts), /owner-confirmed-server-credit-control-off/);
      try { const replay = await dispatch(); await replay.text(); } catch {}
      assert.equal(calls, 1);
    } finally { await broker?.close(); globalThis.fetch = nativeFetch; f.cleanup(); }
  });
