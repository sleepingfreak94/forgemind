import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { ChatGPTStore, loadChatGPTConnection, chatGPTStatus } from '../../src/live-workflow/chatgpt-store.js';
import { openChatGPTPlanSession } from '../../src/live-workflow/chatgpt-plan.js';
import { createChatGPTRefresh } from '../../src/live-workflow/chatgpt-refresh.js';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fm-readers-'))), directory = join(root, 'account');
  const store = new ChatGPTStore(directory, process.cwd(), true);
  try { store.lock(); const connection = { schemaVersion: 1 as const, hostId: store.getHostId(), clientId: 'oaiapp_fixture',
    subject: 'fixture-subject', accessToken: 'synthetic-access', idToken: 'synthetic.signed.identity',
    scope: 'chatgpt.tokens.use.direct', email: 'fixture@example.invalid', expiresAt: Date.now() + 3600000 };
    store.save(connection); store.confirmBillingReview(connection);
  } finally { store.close(); }
  return { root, directory, dispose: () => rmSync(root, { recursive: true, force: true }),
    open: () => openChatGPTPlanSession(directory, { isTTY: true, confirm: async () => { throw Error('Unexpected prompt'); } }) };
}

test('two real independent threads repeatedly open and check one reviewed account without reader locks or network', async () => {
  const f = fixture(), module = new URL('../../src/live-workflow/chatgpt-plan.js', import.meta.url).href,
    storeModule = new URL('../../src/live-workflow/chatgpt-store.js', import.meta.url).href;
  const workerCode = `const {parentPort,workerData}=require('node:worker_threads');
  (async()=>{const {openChatGPTPlanSession}=await import(workerData.module);const {loadChatGPTConnection,chatGPTStatus}=await import(workerData.storeModule);globalThis.fetch=()=>{throw Error('Network forbidden')};
  const flag=new Int32Array(workerData.barrier); Atomics.add(flag,0,1); Atomics.notify(flag,0);
  while(Atomics.load(flag,0)<2)Atomics.wait(flag,0,1,100);
  for(let i=0;i<40;i++){const s=await openChatGPTPlanSession(workerData.directory,{isTTY:true,confirm:async()=>{throw Error('Prompt forbidden')}});s.assertActive();if(!chatGPTStatus(workerData.directory).connected)throw Error('Status denied');if(loadChatGPTConnection(workerData.directory).clientId!=='oaiapp_fixture')throw Error('Connection drift');s.assertActive();s.binding();await s.prepare(900000,new AbortController().signal);}
  parentPort.postMessage('pass')})().catch(()=>{process.exitCode=1;parentPort.postMessage('failed')});`;
  const barrier = new SharedArrayBuffer(4), workers: Worker[] = [];
  try {
    const results = [0, 1].map(() => new Promise<string>((resolve, reject) => {
      const w = new Worker(workerCode, { eval: true, workerData: { module, storeModule, directory: f.directory, barrier } });
      workers.push(w); w.once('message', resolve); w.once('error', reject); w.once('exit', code => { if (code !== 0) reject(Error('Reader thread failed')); });
    }));
    assert.deepEqual(await Promise.all(results), ['pass', 'pass']);
    assert.equal(existsSync(join(f.directory, 'chatgpt.lock')), false);
    assert.equal(existsSync(join(f.directory, 'chatgpt-refresh-pending.json')), false);
  } finally { await Promise.all(workers.map(w => w.terminate())); f.dispose(); }
});

test('active writer and pending rotation still deny reads without stealing or deleting either marker', async () => {
  const f = fixture(), session = await f.open(), store = new ChatGPTStore(f.directory);
  try {
    store.lock(); assert.throws(() => session.assertActive(), /updated|locked/);
    assert.throws(() => loadChatGPTConnection(f.directory), /updated|locked/);
    assert.equal(chatGPTStatus(f.directory).connected, false);
    assert.equal(existsSync(join(f.directory, 'chatgpt.lock')), true);
    store.unlock(); store.lock(); store.beginRefresh(store.connection(true)!); store.unlock();
    assert.throws(() => session.assertActive(), /renewal/);
    assert.throws(() => loadChatGPTConnection(f.directory), /renewal/);
    assert.equal(chatGPTStatus(f.directory).connected, false);
    assert.equal(existsSync(join(f.directory, 'chatgpt-refresh-pending.json')), true);
    await assert.rejects(session.prepare(0, new AbortController().signal));
  } finally { store.close(); f.dispose(); }
});

test('a mutation between snapshot reads denies torn credentials and reset acknowledgement', () => {
  for (const mode of ['connection', 'review']) {
    const f = fixture(), store = new ChatGPTStore(f.directory), original = store.billingReview.bind(store);
    let calls = 0;
    try {
      store.billingReview = connection => {
        const review = original(connection);
        if (++calls === 1) {
          if (mode === 'review') unlinkSync(join(f.directory, 'chatgpt-billing-review.json'));
          else { const path = join(f.directory, 'chatgpt-connection.json');
            writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), accessToken: 'changed-synthetic' })); }
        }
        return review;
      };
      assert.throws(() => store.reviewedSnapshot(), /changed/);
    } finally { store.close(); f.dispose(); }
  }
});

test('healthy refresh preparation is read-only and still rechecks caller deadline/source and expected record', async () => {
  const f = fixture(), before = readFileSync(join(f.directory, 'chatgpt-connection.json'), 'utf8');
  let network = 0, checks = 0;
  const ensure = createChatGPTRefresh({ projectRoot: process.cwd(), transport: async () => { network++; throw Error('Network forbidden'); } });
  try {
    const connection = await ensure(f.directory, { minimumLifetimeMs: 900000, check: () => { checks++; } });
    assert.equal(network, 0); assert.ok(checks >= 2); assert.equal(readFileSync(join(f.directory, 'chatgpt-connection.json'), 'utf8'), before);
    await assert.rejects(ensure(f.directory, { expectedConnection: { ...connection, accessToken: 'different-synthetic' } }), /changed/);
    await assert.rejects(ensure(f.directory, { check: () => { throw Error('Denied caller'); } }));
    assert.equal(network, 0); assert.equal(existsSync(join(f.directory, 'chatgpt.lock')), false);
  } finally { f.dispose(); }
});
