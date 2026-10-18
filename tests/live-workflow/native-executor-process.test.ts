import { reconcileChatGPTExecution } from '../../src/live-workflow/chatgpt-execution-leases.js';
import { executionFixture } from './chatgpt-execution-fixture.js';
import { ChatGPTExecutionLedger } from '../../src/live-workflow/chatgpt-execution-ledger.js';
import { nativeCleanupEvidence,consumeNativeCleanupEvidence } from '../../src/live-workflow/native-executor-process.js';
import { createServer as createHttpServer } from 'node:http';
import { spawn } from 'node:child_process';
import { JsonlRpc } from '../../src/agent-drivers/jsonl-rpc.js';
import { nativeInferenceProfile } from '../../src/live-workflow/native-executor-profile.js';
import { runtimeFiles } from '../../src/live-workflow/process.js';
import { NATIVE_CATALOG_PATH,NATIVE_CATALOG_SHA256 } from '../../src/live-workflow/native-executor-catalog.js';
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
    assert.equal(plan.dependencies.find(pin=>pin.path===NATIVE_CATALOG_PATH)?.digest,NATIVE_CATALOG_SHA256);
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

test('actual native offline ResponsesLite advertises exactly three direct host tools under the same no-fork profile',
  {skip:process.platform!=='darwin',timeout:15000},async()=>{
  const root=realpathSync(mkdtempSync(tmpdir()+'/fm-native-direct-')),home=root+'/home',tmp=root+'/tmp';
  mkdirSync(home,{mode:0o700});mkdirSync(tmp,{mode:0o700});
  let capturedResolve!:(names:string[])=>void,capturedReject!:(error:Error)=>void;
  const captured=new Promise<string[]>((resolve,reject)=>{capturedResolve=resolve;capturedReject=reject;});
  const sockets=new Set<import('node:net').Socket>();let posts=0;
  const server=createHttpServer((request,response)=>{
    let bytes=0;const chunks:Buffer[]=[];
    request.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>131072){request.destroy();capturedReject(new Error('Fixture request limit'));}else chunks.push(chunk);});
    request.on('end',()=>{
      try{
        posts++;const body=JSON.parse(Buffer.concat(chunks).toString());
        const additional=(body.input??[]).filter((item:{type?:string})=>item.type==='additional_tools').flatMap((item:{tools?:unknown[]})=>item.tools??[]);
        const defs=[...(body.tools??[]),...additional];
        assert.equal(body.model,'gpt-6.1-sol');
        assert.equal(defs.length,1);
        assert.equal(defs[0].type,'namespace');
        assert.equal(defs[0].name,'functions');
        assert.ok(Array.isArray(defs[0].tools));
        assert.equal(defs[0].tools.length,3);
        const names:string[]=defs[0].tools.map((tool:{type?:string;name?:string})=>{
          assert.equal(tool.type,'function');
          assert.equal(typeof tool.name,'string');
          return tool.name!;
        }).sort();
        capturedResolve(names);
        response.writeHead(401,{'content-type':'application/json'});response.end(JSON.stringify({error:{code:'invalid_key',message:'offline fixture only'}}));
      }catch(error){capturedReject(error as Error);response.writeHead(500);response.end();}
    });
  });
  server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');const port=address.port;
  const endpoint='http://127.0.0.1:'+port;
  // ONLY the fixed production endpoint is substituted for an offline local HTTP
  // fixture. No real account, external network, model response or qualification.
  writeFileSync(home+'/config.toml',nativeConfiguration('gpt-6.1-sol').replace('https://api.openai.com/v1',endpoint+'/v1'),{mode:0o600});
  const exe=realpathSync(homedir()+'/.local/bin/codex');
  const dependencies=[...runtimeFiles(exe).filter(path=>path!==exe),NATIVE_CA_FILE,NATIVE_CATALOG_PATH];
  const profile=nativeInferenceProfile(exe,home,tmp,port,dependencies);
  assert.equal(profile.includes('(allow process-fork'),false);
  const child=spawn('/usr/bin/sandbox-exec',['-p',profile,exe,'app-server','--listen','stdio://'],{
    cwd:home,detached:true,stdio:['pipe','pipe','pipe'],env:{HOME:home,CODEX_HOME:home,TMPDIR:tmp,LANG:'C',LC_ALL:'C',OPENSSL_CONF:'/dev/null',SSL_CERT_FILE:NATIVE_CA_FILE,ACCESS_TOKEN:'offline-fixture-not-a-credential',HTTP_PROXY:endpoint,HTTPS_PROXY:endpoint,NO_PROXY:''}});
  child.stderr!.resume();const exited=new Promise<void>(resolve=>child.once('close',()=>resolve()));
  const rpc=new JsonlRpc(child.stdout!,child.stdin!,{timeoutMs:3000,maxLineBytes:1048576,maxTotalBytes:2097152});
  let doneResolve!:()=>void;const done=new Promise<void>(resolve=>{doneResolve=resolve;});
  rpc.onNotification(event=>{if(event.method==='turn/completed')doneResolve();});
  try{
    await rpc.request('initialize',{clientInfo:{name:'forgemind_direct_offline',version:'1'},capabilities:{experimentalApi:true}});await rpc.notify('initialized',{});
    const start=await rpc.request('thread/start',{model:'gpt-6.1-sol',modelProvider:'openai_chatgpt_plan',cwd:home,sandbox:'read-only',approvalPolicy:'never',serviceTier:'default',dynamicTools:nativeDynamicTools,config:{model_reasoning_effort:'medium',project_doc_max_bytes:0},ephemeral:true}) as {thread:{id:string}};
    await rpc.request('turn/start',{threadId:start.thread.id,input:[{type:'text',text:'Use only the owner host tools to inspect the fixture.'}],model:'gpt-6.1-sol',effort:'medium',approvalPolicy:'never',sandboxPolicy:{type:'readOnly',networkAccess:false}});
    assert.deepEqual(await Promise.race([captured,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('Offline tool advertisement not received')),3000))]),['host_apply','host_check','host_read']);
    await Promise.race([done,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('Offline turn did not finish')),3000))]);
    assert.equal(posts,1);
  }finally{
    rpc.close();try{process.kill(-child.pid!,'SIGKILL');}catch{child.kill('SIGKILL');}await exited;
    for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));
    rmSync(root,{recursive:true,force:true});
  }
});


test('execution leases release only with genuine native reaping or prelaunch cleanup, independent of cancellation',
  {skip:process.platform!=='darwin',timeout:20000},async()=>{
  for(const mode of ['normal','cancel','prelaunch','reconcile','revoked-settlement'] as const){
    const f=executionFixture(),home=f.root+'/native-home',tmp=f.root+'/native-tmp';
    mkdirSync(home,{mode:0o700});mkdirSync(tmp,{mode:0o700});writeFileSync(home+'/config.toml',nativeConfiguration('gpt-6.1-sol'),{mode:0o600});
    const allocator=createServer();await new Promise<void>(resolve=>allocator.listen(0,'127.0.0.1',resolve));
    const address=allocator.address();assert.ok(address&&typeof address!=='string');const port=address.port;
    await new Promise<void>(resolve=>allocator.close(()=>resolve()));
    const controller=new AbortController(),session=await f.open();
    const lease=session.admitExecution({runBinding:'a'.repeat(64),deadline:Date.now()+15000,signal:controller.signal,check:()=>{}});
    const plan=prepareNativeLaunchPlan({taskId:'offline',grantId:'grant',fencingEpoch:1,leaseId:'lease',model:'gpt-6.1-sol',effort:'medium',grantDigest:'a'.repeat(64),authorityBinding:'c'.repeat(64),budgetBinding:'b'.repeat(64),accountBinding:'offline-no-account',reviewBinding:'offline-test',executable:realpathSync(homedir()+'/.local/bin/codex'),config:home+'/config.toml',privateHome:home,privateTmp:tmp,tunnelPort:port,deadlineEpochMs:Date.now()+12000,maxWireBytes:1048576});
    lease.beginLaunch(plan.runtimeBinding);
    try{
      if(mode==='prelaunch')controller.abort();
      try{
        const native=await launchNativeProcess({plan,execution:lease,signal:controller.signal,accessToken:'offline-fixture-not-a-credential',lifecycle:{runtimeBinding:plan.runtimeBinding,receiptId:'execution-'+mode,checkActive:()=>lease.assertActive(),finish:()=>{}}});
        assert.equal(nativeCleanupEvidence(native),null);
        await assert.rejects(launchNativeProcess({plan:{...plan},execution:lease,accessToken:'offline-fixture-not-a-credential',lifecycle:{runtimeBinding:plan.runtimeBinding,receiptId:'forged',checkActive:()=>{},finish:()=>{}}}),error=>{assert.equal(nativeCleanupEvidence(error),null);return true;});
        await assert.rejects(launchNativeProcess({plan,execution:lease,accessToken:'offline-fixture-not-a-credential',lifecycle:{runtimeBinding:plan.runtimeBinding,receiptId:'duplicate',checkActive:()=>{},finish:()=>{}}}),error=>{assert.equal(nativeCleanupEvidence(error),null);return true;});
        if(mode==='cancel')controller.abort();
        if(mode==='reconcile')lease.retainIndeterminate();
        await native.stop();const proof=nativeCleanupEvidence(native);assert.ok(proof);
        if(mode==='revoked-settlement'){const ledger=new ChatGPTExecutionLedger(f.directory);try{ledger.revoke();}finally{ledger.close();}assert.throws(()=>lease.settle('completed',proof),/revoked/);}
        if(mode==='reconcile')reconcileChatGPTExecution(f.directory,lease.receipt().id,proof,()=>{});
        else lease.settle(mode==='normal'?'completed':'failed',proof);
        assert.throws(()=>consumeNativeCleanupEvidence(proof,plan.runtimeBinding,lease.receipt().id),/replayed/);
      }catch(error){if(mode!=='prelaunch')throw error;const proof=nativeCleanupEvidence(error);assert.ok(proof);lease.settle('failed',proof);}
      assert.equal(lease.receipt().status,mode==='normal'?'completed':mode==='reconcile'?'indeterminate':'failed');
      const ledger=new ChatGPTExecutionLedger(f.directory);try{const intent=ledger.beginRefresh('a'.repeat(64),()=>{});ledger.finishRefresh(intent);}finally{ledger.close();}
    }finally{f.close();}
  }
});
