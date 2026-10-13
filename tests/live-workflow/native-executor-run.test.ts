import { NativeProviderError } from '../../src/live-workflow/native-executor.js';
import { writeFileSync, mkdirSync, chmodSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { NativeOwner } from '../../src/live-workflow/native-executor-owner.js';
import { NativeProject } from '../../src/live-workflow/native-executor-project.js';
import { FixtureNativeHost, fixtureStdioRpc } from '../../src/live-workflow/native-executor-host.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { projectFixture } from './native-executor-project.test.js';
import { validateNativeTask, runNativeTask, allocateNativePort, nativePacketBinding, runOfflineNativeTask, assertNativeRunCompleted, nativeTaskContext, nativeFailureCode, NativeRunError } from '../../src/live-workflow/native-executor-run.js';
import { ChatGPTPlanSession } from '../../src/live-workflow/chatgpt-plan.js';
import { parseNativeArguments, loadNativePacket } from '../../src/local-runtime/native-cli.js';
import { join } from 'node:path';

test('production run rejects a constructed unauthenticated session before process launch',async()=>{
  const f=projectFixture();
  try{await assert.rejects(runNativeTask({task:f.task,objective:'repair',runDirectory:join(f.dir,'run'),codexExecutable:process.execPath,session:new ChatGPTPlanSession(),parent:{binding:'a'.repeat(64),check:()=>undefined},signal:new AbortController().signal}),/Unrecognized/);}
  finally{f.close();}
});
test('native task accepts explicit uncapped counters and rejects implicit infinity or permission traversal',()=>{
  const f=projectFixture();
  try{
    validateNativeTask(f.task);
    assert.throws(()=>validateNativeTask({...f.task,budget:{...f.task.budget,turns:Infinity}}),/budget/);
    assert.throws(()=>validateNativeTask({...f.task,writePaths:['../escape']}),/Unsafe/);
    assert.throws(()=>validateNativeTask({...f.task,budget:{...f.task.budget,retries:3} as never}),/budget/);
    assert.throws(()=>parseNativeArguments(['--packet','relative']),/Exact/);
  }finally{f.close();}
});

test('allocated native loopback port is nonzero and sealing can bind it',async()=>{
  const port=await allocateNativePort(()=>undefined);assert.ok(port>=1&&port<=65535);
});
test('owner packet digest excludes observed source only; private permission boundary is enforced',()=>{
  const f=projectFixture();
  try{
    const packet={schema:'native-owner-packet-v1',task:f.task,objective:'repair'};
    const path=join(f.dir,'packet.json');writeFileSync(path,JSON.stringify(packet),{mode:0o600});
    const binding=loadNativePacket(path,join(f.dir,'run')).parentBinding;
    assert.equal(nativePacketBinding({...packet,task:{...f.task,source:'b'.repeat(64)}}),binding);
    assert.notEqual(nativePacketBinding({...packet,objective:'another task'}),binding);
    assert.notEqual(nativePacketBinding({...packet,task:{...f.task,writePaths:['other.txt']}}),binding);
    chmodSync(path,0o644);assert.throws(()=>loadNativePacket(path,join(f.dir,'run')),/Owner-private/);
    const inside=join(f.root,'packet.json');writeFileSync(inside,JSON.stringify(packet),{mode:0o600});
    assert.throws(()=>loadNativePacket(inside,join(f.dir,'run')),/Owner-private|outside worker/);
  }finally{f.close();}
});
const restartProgram=`
const rl=require('node:readline').createInterface({input:process.stdin});
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');let phase=0,n=100,turn='turn'+process.pid;
const tool=(name,args)=>send({id:++n,method:'item/tool/call',params:{threadId:'thread',turnId:turn,callId:'call'+process.pid+n,tool:name,arguments:args}});
rl.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')send({id:m.id,result:{}});
if(m.method==='thread/start'||m.method==='thread/resume')send({id:m.id,result:{thread:{id:'thread',turns:m.method==='thread/resume'?[{id:process.argv[1],status:'completed',items:[]}]:[],cliVersion:'0.162.1',cwd:m.params.cwd,ephemeral:false,modelProvider:'openai'},model:m.params.model,reasoningEffort:m.params.config.model_reasoning_effort,cwd:m.params.cwd,modelProvider:'openai',serviceTier:'default',approvalPolicy:'never',approvalsReviewer:'user',sandbox:{type:'readOnly',networkAccess:false}}});
if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:turn}}});setImmediate(()=>tool('host_read',{path:'value.txt'}));}
if(m.result&&m.id>100){if(!m.result.success)return;if(phase++===0)tool('host_apply',{summary:'repair',edits:[{path:'value.txt',beforeSha256:JSON.parse(m.result.contentItems[0].text).sha256,content:'after'}]});else if(phase===2)tool('host_check',{id:'check'});else send({method:'turn/completed',params:{threadId:'thread',turn:{id:turn,status:'completed',items:[]}}});}
});`;
test('actual callable runner restarts process and thread/resume using immutable owner packet and cumulative counters',async()=>{
  const f=projectFixture(),runDirectory=join(f.dir,'run');mkdirSync(runDirectory,{mode:0o700});
  const packetPath=join(f.dir,'packet.json');writeFileSync(packetPath,JSON.stringify({schema:'native-owner-packet-v1',task:f.task,objective:'repair'}),{mode:0o600});
  let owner=f.owner;
  try{
    let firstBinding='',firstWire=0,priorTurn='';
    for(let pass=0;pass<2;pass++){
      const invocation=loadNativePacket(packetPath,runDirectory);
      if(pass===0)firstBinding=invocation.parentBinding;else{
        assert.equal(invocation.parentBinding,firstBinding);
        owner.close();owner=new NativeOwner(join(f.dir,'owner'),invocation.packet.task,Date.now()+10000,()=>undefined);
      }
      const project=new NativeProject(f.root,owner,(...args)=>owner.phase(...args),()=>owner.active());
      const child=spawn(process.execPath,['-e',restartProgram,priorTurn]);
      const host=new FixtureNativeHost(fixtureStdioRpc(child.stdout!,child.stdin!),owner,()=>owner.active(),async()=>{child.kill();await new Promise<void>(resolve=>child.once('close',()=>resolve()));},()=>project.source(),async()=>({passed:true}),project);
      const receipt=await runOfflineNativeTask({task:invocation.packet.task,objective:invocation.packet.objective,runDirectory,parent:{binding:invocation.parentBinding,check:()=>owner.active()},signal:new AbortController().signal,host});
      assert.equal(receipt.checkpoint.counters.turns,pass+1);assert.equal(receipt.checkpoint.counters.toolCalls,(pass+1)*3);
      assert.equal(receipt.checkpoint.source,owner.source);assert.equal(receipt.checkpoint.thread,'thread');
      assert.ok(receipt.checkpoint.counters.wireBytes>firstWire);firstWire=receipt.checkpoint.counters.wireBytes;priorTurn='turn'+child.pid;
    }
  }finally{owner.close();f.close();}
});

test('return boundary rejects authority, account, source and failed-runtime faults introduced during cleanup',()=>{
  const f=projectFixture();
  try{
    for(const failure of ['parent','account','source','runtime'] as const){
      let cleanupFinished=false;
      const check=(kind:string)=>()=>{if(cleanupFinished&&failure===kind)throw new Error('invalid '+kind);};
      const checks={active:check('parent'),account:check('account'),source:check('source'),runtime:check('runtime')};
      assertNativeRunCompleted(checks);
      cleanupFinished=true;assert.throws(()=>assertNativeRunCompleted(checks),new RegExp('invalid '+failure));
    }
    writeFileSync(join(f.root,'drift.txt'),'unrelated cleanup drift');
    assert.throws(()=>assertNativeRunCompleted({active:()=>f.owner.active(),account:()=>undefined,
      source:()=>f.project.assertCurrent(f.state.value.source),runtime:()=>undefined}),/Stale native project/);
  }finally{f.close();}
});
test('assembled native input includes exact scope, edit contract and serial tool instruction',()=>{
  const f=projectFixture();
  try{
    const input=nativeTaskContext(f.task,'repair the counter');
    assert.match(input,/value.txt/);assert.match(input,/beforeSha256/);assert.match(input,/one host tool at a time/);
    assert.ok(input.includes(JSON.stringify(f.task.checks.map(check=>check.id))));
    assert.ok(input.endsWith('repair the counter'));
    const creation=nativeTaskContext({...f.task,writePaths:['new.txt']},'create');
    assert.ok(creation.includes('Initially absent owner write paths: ["new.txt"]'));
    assert.match(creation,/beforeSha256:null/);
    assert.match(creation,/do not host_read nonexistent files/);
  }finally{f.close();}
});

test('typed provider kinds are distinguished without matching malicious remote messages as runtime tokens',()=>{
  const cases=[
    ['unauthorized','native-provider-unauthorized'],
    ['rateLimitExceeded','native-provider-rate-limit'],
    ['usageLimitExceeded','native-provider-quota'],
    [{httpConnectionFailed:{httpStatusCode:401}},'native-provider-unauthorized'],
    [{responseStreamConnectionFailed:{httpStatusCode:429}},'native-provider-rate-limit'],
    [{responseStreamDisconnected:{httpStatusCode:502}},'native-provider-transport'],
    [{responseTooManyFailedAttempts:{httpStatusCode:null}},'native-provider-transport'],
    ['not-a-known-native-kind','native-provider-error'],
  ] as const;
  for(const [info,code] of cases){
    const error=new NativeProviderError({message:'Bearer SECRET prompt runtime port pin',codexErrorInfo:info,additionalDetails:'SECRET'},false);
    assert.equal(nativeFailureCode(error),code);
    const failure=new NativeRunError('native-turn',nativeFailureCode(error),{checkpoint:{status:'stopped'},runtime:{status:'failed'},nativeDiagnostic:error.diagnostic});
    const serialized=JSON.stringify(failure);
    assert.equal(serialized.includes('SECRET'),false);assert.equal(serialized.includes('prompt'),false);
    assert.equal((failure.receipts as {nativeDiagnostic:unknown}).nativeDiagnostic,error.diagnostic);
  }
  assert.equal(nativeFailureCode(new Error('Native reported error')),'native-execution-failed');
  assert.equal(nativeFailureCode(new Error('Unsupported native operation')),'native-execution-failed');
  assert.equal(nativeFailureCode(new Error('Pinned runtime drift')),'runtime-unqualified');
  assert.equal(nativeFailureCode(new Error('Native configuration mismatch')),'runtime-unqualified');
  assert.equal(nativeFailureCode(new Error('Native port allocation failed')),'runtime-unqualified');
});
test('malformed diagnostic status and extra variant keys map to unknown instead of reflecting remote data',()=>{
  for(const info of [{httpConnectionFailed:{httpStatusCode:'SECRET'}},{httpConnectionFailed:{httpStatusCode:-1}},
    {httpConnectionFailed:{httpStatusCode:65536}},{httpConnectionFailed:{httpStatusCode:401},secret:'SECRET'}]){
    const error=new NativeProviderError({message:'SECRET',codexErrorInfo:info},'SECRET');
    assert.deepEqual(error.diagnostic,{kind:'unknown',httpStatusCode:null,willRetry:null});
    assert.equal(JSON.stringify(error).includes('SECRET'),false);
  }
});

test('captured safe native diagnostic classifies generic RPC closure while unannotated host errors keep their classification',()=>{
  const diagnostic=new NativeProviderError({message:'SECRET',codexErrorInfo:{httpConnectionFailed:{httpStatusCode:401}}},false).diagnostic;
  assert.equal(nativeFailureCode(new Error('rpc-error'),diagnostic),'native-provider-unauthorized');
  assert.equal(nativeFailureCode(new Error('disconnected'),diagnostic),'native-provider-unauthorized');
  assert.equal(nativeFailureCode(new Error('Native configuration mismatch'),null),'runtime-unqualified');
});
