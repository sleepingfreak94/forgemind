import test from 'node:test';
import assert from 'node:assert/strict';
import net, { createServer } from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { fork } from 'node:child_process';
import { prepareNativeLaunchPlan, nativeConfiguration, validateNativeCaBundle, NATIVE_CA_FILE } from '../../src/live-workflow/native-executor-launch-contracts.js';
import { assertNativeProcess, launchNativeProcess, assertNativeProcessCompleted } from '../../src/live-workflow/native-executor-process.js';
import { nativeDynamicTools } from '../../src/live-workflow/native-executor-tools.js';
test('serialized process cannot qualify native execution', () => {
  assert.throws(() => assertNativeProcess({ qualification: 'native-seatbelt' } as never), /trusted/);
});
test('real pinned 0.162.1 starts a read-only native thread offline and reaps before lifecycle finish',
  { skip: process.platform !== 'darwin', timeout: 15000 }, async () => {
  const root = realpathSync(mkdtempSync(tmpdir() + '/fm-native-process-'));
  const home = root + '/home', tmp = root + '/tmp'; mkdirSync(home, { mode: 0o700 }); mkdirSync(tmp, { mode: 0o700 });
  const allocator = createServer();
  await new Promise<void>(resolve => allocator.listen(0, '127.0.0.1', resolve));
  const address = allocator.address(); assert.ok(address && typeof address !== 'string'); const port = address.port;
  await new Promise<void>(resolve => allocator.close(() => resolve()));
  writeFileSync(home + '/config.toml', nativeConfiguration('gpt-6.1-sol'), { mode: 0o600 });
  let upstreamDials = 0;
  // Block every tunnel upstream dial in this test process. Native thread setup
  // must complete without a provider connection, even with a fixture token.
  const dial = test.mock.method(net, 'connect', (options: unknown) => {
    assert.deepEqual(options, { host: 'api.openai.com', port: 443 }); upstreamDials++;
    const socket = new net.Socket();
    setImmediate(() => socket.destroy(new Error('Offline regression denies provider egress')));
    return socket;
  });
  syncBuiltinESMExports();
  let finish: string | undefined;
  try {
    const plan = prepareNativeLaunchPlan({ taskId: 'offline', grantId: 'grant', fencingEpoch: 1,
      leaseId: 'lease', model: 'gpt-6.1-sol', effort: 'medium', grantDigest: 'a'.repeat(64), authorityBinding: 'c'.repeat(64), budgetBinding: 'b'.repeat(64), accountBinding: 'offline-no-account', reviewBinding: 'offline-test',
      executable: realpathSync(homedir() + '/.local/bin/codex'), config: home + '/config.toml',
      privateHome: home, privateTmp: tmp, tunnelPort: port, deadlineEpochMs: Date.now() + 12000, maxWireBytes: 1048576 });
    assert.ok(plan.dependencies.some(pin=>pin.path===NATIVE_CA_FILE));
    assert.ok(plan.profile.includes(JSON.stringify(NATIVE_CA_FILE)));
    assert.equal(plan.dependencies.filter(pin=>pin.path===NATIVE_CA_FILE).length,1);
    const native = await launchNativeProcess({ plan, lifecycle: { runtimeBinding: plan.runtimeBinding, receiptId: 'offline-receipt',
      checkActive() {}, finish(status) { finish = status; } }, accessToken: 'offline-fixture-not-a-credential' });
    try {
      const result = await native.rpc.request('initialize', { clientInfo: { name: 'forgemind_offline_transport', version: '1' },
        capabilities: { experimentalApi: true } });
      assert.ok(result); assertNativeProcess(native); assert.equal(finish, undefined);
      await native.rpc.notify('initialized', {});
      // No turn/start: this exercises native managed preferences and effective
      // thread configuration without model inference or account credentials.
      const response = await native.rpc.request('thread/start', {
        cwd: home, approvalPolicy: 'never', sandbox: 'read-only', model: plan.model, modelProvider: plan.provider,
        serviceTier: 'default', approvalsReviewer: 'user', allowProviderModelFallback: false, ephemeral: false,
        config: { model_reasoning_effort: plan.effort, project_doc_max_bytes: 0 }, dynamicTools: nativeDynamicTools,
        historyMode: 'legacy',
      }) as Record<string, unknown>;
      assert.equal(response.model, plan.model); assert.equal(response.modelProvider, plan.provider);
      assert.equal(response.reasoningEffort, plan.effort); assert.equal(response.serviceTier, 'default');
      assert.equal(response.approvalPolicy, 'never'); assert.equal(response.approvalsReviewer, 'user');
      assert.equal(response.cwd, home);
      const sandbox = response.sandbox as Record<string, unknown>, thread = response.thread as Record<string, unknown>;
      assert.equal(sandbox.type, 'readOnly'); assert.equal(sandbox.networkAccess, false);
      assert.equal(thread.cliVersion, '0.162.1'); assert.equal(thread.cwd, home);
      assert.equal(thread.ephemeral, false); assert.equal(thread.modelProvider, plan.provider);
      assert.equal(typeof thread.id, 'string'); assert.ok(thread.id);
      assert.equal(upstreamDials, 0, 'Native initialize/thread/start must not dial the provider');
    } finally { await native.stop(); }
    assert.equal(finish, 'completed'); assert.throws(() => native.assertActive(), /stopped/);
    // Exercise parent IPC disconnect against the actual supervisor/native pair.
    const supervisor = fork(plan.supervisor.path, [], { execPath: plan.node.path, execArgv: [], cwd: tmp,
      env: { LANG: 'C' }, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    supervisor.stdout!.resume(); supervisor.stderr!.resume();
    // Node may keep the parent's writable stdin open after manual IPC disconnect;
    // the supervisor exit plus native PID disappearance is the reaping evidence.
    const closed = new Promise<void>(resolve => supervisor.once('exit', () => resolve()));
    const pid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => { supervisor.kill('SIGKILL'); reject(new Error('Supervisor startup timed out')); }, 2000);
      supervisor.on('message', (message: unknown) => {
        if (message && typeof message === 'object' && 'pid' in message && typeof message.pid === 'number') {
          clearTimeout(timer); resolve(message.pid);
        }
      });
      supervisor.send({ executable: plan.executable.path, profile: plan.profile, home, tmp, port,
        accessToken: 'offline-fixture-not-a-credential', deadlineEpochMs: Date.now() + 5000, maxWireBytes: 1048576 });
    });
    supervisor.disconnect(); await closed; supervisor.stdin!.destroy();
    assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH');
    for (const mode of ['revoke', 'cancel', 'config-drift'] as const) {
      let active = true, settlement: string | undefined;
      const controller = new AbortController();
      const subject = await launchNativeProcess({ plan, lifecycle: { runtimeBinding: plan.runtimeBinding,
        receiptId: 'offline-' + mode, checkActive() { if (!active) throw new Error('Revoked'); },
        finish(status) { settlement = status; } }, signal: controller.signal, accessToken: 'offline-fixture-not-a-credential' });
      if (mode === 'revoke') active = false;
      if (mode === 'cancel') controller.abort();
      if (mode === 'config-drift') writeFileSync(home + '/config.toml', nativeConfiguration('gpt-6.1-sol') + '\n');
      await new Promise<void>((resolve, reject) => {
        const timer = setInterval(() => { if (settlement) { clearInterval(timer); clearTimeout(timeout); resolve(); } }, 10);
        const timeout = setTimeout(() => { clearInterval(timer); reject(new Error('Cleanup did not settle')); }, 3000);
      });
      await subject.stop(); assert.equal(settlement, 'failed');
      assert.throws(()=>assertNativeProcessCompleted(subject),/not completed/);
      assert.throws(() => subject.assertActive(), /stopped/);
    }
    const inspect = (directory: string) => {
      for (const file of readdirSync(directory, { withFileTypes: true })) {
        const path = directory + '/' + file.name;
        if (file.isDirectory()) inspect(path);
        else if (file.isFile()) assert.equal(readFileSync(path).includes(Buffer.from('offline-fixture-not-a-credential')), false,
          'Native home must not persist access token');
      }
    };
    inspect(home);
  } finally { dial.mock.restore(); syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true }); }
});

test('prelaunch revocation, bind collision and post-bind pre-fork failure each terminalize once',
  {skip:process.platform!=='darwin',timeout:20000},async()=>{
  for(const mode of ['revoked','occupied','pre-fork'] as const){
    const root=realpathSync(mkdtempSync(tmpdir()+'/fm-native-prelaunch-')),home=root+'/home',tmp=root+'/tmp';
    mkdirSync(home,{mode:0o700});mkdirSync(tmp,{mode:0o700});
    writeFileSync(home+'/config.toml',nativeConfiguration('gpt-6.1-sol'),{mode:0o600});
    const allocator=createServer();await new Promise<void>(resolve=>allocator.listen(0,'127.0.0.1',resolve));
    const address=allocator.address();assert.ok(address&&typeof address!=='string');const port=address.port;
    if(mode!=='occupied')await new Promise<void>(resolve=>allocator.close(()=>resolve()));
    const statuses:string[]=[];let checks=0;
    try{
      const plan=prepareNativeLaunchPlan({taskId:'offline',grantId:'grant',fencingEpoch:1,leaseId:'lease',model:'gpt-6.1-sol',effort:'medium',grantDigest:'a'.repeat(64),authorityBinding:'c'.repeat(64),budgetBinding:'b'.repeat(64),accountBinding:'offline-no-account',reviewBinding:'offline-test',executable:realpathSync(homedir()+'/.local/bin/codex'),config:home+'/config.toml',privateHome:home,privateTmp:tmp,tunnelPort:port,deadlineEpochMs:Date.now()+12000,maxWireBytes:1048576});
      await assert.rejects(launchNativeProcess({plan,accessToken:'offline-fixture-not-a-credential',lifecycle:{runtimeBinding:plan.runtimeBinding,receiptId:'receipt-'+mode,
        checkActive(){checks++;if(mode==='revoked')throw new Error('Revoked before launch');if(mode==='pre-fork'&&checks===3)rmSync(tmp,{recursive:true});},
        finish(status){statuses.push(status);}}}));
      assert.deepEqual(statuses,['failed']);
      if(mode!=='occupied'){
        const proof=createServer();await new Promise<void>((resolve,reject)=>{proof.once('error',reject);proof.listen(port,'127.0.0.1',resolve);});
        await new Promise<void>(resolve=>proof.close(()=>resolve()));
      }
    }finally{
      if(mode==='occupied')await new Promise<void>(resolve=>allocator.close(()=>resolve()));
      rmSync(root,{recursive:true,force:true});
    }
  }
});

test('fixed native TLS bundle is nonempty parseable PEM and malformed inputs cannot fall back',()=>{
  assert.ok(validateNativeCaBundle(readFileSync(NATIVE_CA_FILE))>0);
  for(const bytes of [Buffer.alloc(0),Buffer.from('not PEM'),Buffer.from('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----'),
    Buffer.from('-----BEGIN CERTIFICATE-----\nAAAA'),Buffer.alloc(4*1024*1024+1)]){
    assert.throws(()=>validateNativeCaBundle(bytes),/Invalid native CA/);
  }
});
test('fixed configuration disables auxiliary plugins and unbounded connection retries',()=>{
  const config=nativeConfiguration('gpt-6.1-sol');
  assert.match(config,/\[features\][\s\S]*\nplugins = false\n/);
  assert.match(config,/\nunbounded_connection_retries = false\n/);
  assert.match(config,/\nrequest_max_retries = 0\n/);assert.match(config,/\nstream_max_retries = 0\n/);
});
