import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeExecutor, NativeProviderError, nativeProviderDiagnostic } from '../../src/live-workflow/native-executor.js';
import { FixtureNativeHost } from '../../src/live-workflow/native-executor-host.js';
import type { NativeRpc } from '../../src/live-workflow/native-executor-host.js';
import { NativeState } from '../../src/live-workflow/native-executor-state.js';
import { nativeTool, nativeCheckFailure, nativeFailedCheckFacts } from '../../src/live-workflow/native-executor-tools.js';
import { nativeFailureCode, nativeRunFailureCode, NativeRunError } from '../../src/live-workflow/native-executor-run.js';
import { sha256 } from '../../src/live-workflow/validation.js';
import type { NativeTask } from '../../src/live-workflow/native-executor-contracts.js';

type Callback = Parameters<NativeRpc['onRequest']>[0];

/** Same RPC port as the subprocess transport, with no process or socket. */
class MemoryRpc implements NativeRpc {
  handler!: Callback;
  listeners = new Set<Parameters<NativeRpc['onNotification']>[0]>();
  replies: Awaited<ReturnType<Callback>>[] = [];
  interrupts = 0;
  closed = false;
  callbackDone: Promise<void> = Promise.resolve();
  onRequest(handler: Callback) { this.handler = handler; }
  onNotification(listener: Parameters<NativeRpc['onNotification']>[0]) {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  onFailure() { return () => {}; }
  onWire() { return () => {}; }
  async notify() {}
  close() { this.closed = true; }
  emit(event: Parameters<Parameters<NativeRpc['onNotification']>[0]>[0]) {
    this.listeners.forEach(listener => listener(event));
  }
  async callback(callId = 'check-call') {
    const reply = await this.handler({ id: 100, method: 'item/tool/call', params: {
      threadId:'thread', turnId:'turn', callId, tool:'host_check', arguments:{id:'check'},
    } });
    this.replies.push(reply);
    return reply;
  }
  async request(method: string, raw: unknown, onResult?: (value: unknown) => void) {
    const p = raw as {cwd:string;model:string;config:{model_reasoning_effort:string}};
    let value: unknown = {};
    if (method === 'thread/start') value = {
      thread:{id:'thread', turns:[], cliVersion:'0.162.1', cwd:p.cwd, ephemeral:false, modelProvider:'openai'},
      cwd:p.cwd, model:p.model, reasoningEffort:p.config.model_reasoning_effort, modelProvider:'openai',
      serviceTier:'default', approvalPolicy:'never', approvalsReviewer:'user', sandbox:{type:'readOnly',networkAccess:false},
    };
    if (method === 'turn/interrupt') this.interrupts++;
    if (method === 'turn/start') value = {turn:{id:'turn'}};
    onResult?.(value);
    if (method === 'turn/start') this.callbackDone = Promise.resolve().then(async () => {
      const reply = await this.callback();
      if ('result' in reply && (reply.result as {success?:boolean})?.success) this.emit({method:'turn/completed', params:{
        threadId:'thread', turn:{id:'turn',status:'completed',items:[]},
      }});
    });
    return value;
  }
}
function fixture(passed = false, resultBytes = 10000) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'b010-pure-'))), root = join(dir,'repo');
  mkdirSync(root); writeFileSync(join(root,'value.txt'),'source');
  const source = () => sha256(readFileSync(join(root,'value.txt')));
  const task: NativeTask = {project:'fixture',task:'b010',root,source:source(),model:'gpt-6.1-sol',effort:'medium',
    readPaths:[],writePaths:[],checks:[{id:'check',executable:process.execPath,args:[],timeoutMs:1000}],
    budget:{runtimeMs:10000,turns:null,toolCalls:null,retries:0,inputBytes:10000,resultBytes,wireBytes:10000,outputBytes:10000}};
  const state = new NativeState(join(dir,'state'),task), rpc = new MemoryRpc();
  const summary = {id:'check',passed,exitCode:passed?0:1,stdout:'actual bounded output',stderr:''};
  const terminals: {status:string;digest:string|undefined}[] = [], reservations: string[] = [];
  const hooks: {execute?:()=>Promise<unknown>;afterResult?:()=>void;finish?:()=>void;stop?:()=>void;boundary?:()=>void} = {};
  let executions = 0, stops = 0;
  const host = new FixtureNativeHost(rpc,{reserve(envelope) {
    reservations.push(envelope.source);
    return {check:()=>{},finish(status,digest) { terminals.push({status,digest}); hooks.finish?.(); }};
  }},()=>hooks.boundary?.(),async()=>{stops++;hooks.stop?.();},source,async()=>{
    executions++;const result=hooks.execute?await hooks.execute():summary;hooks.afterResult?.();return result;
  });
  const executor = new NativeExecutor(task,state,host);
  return {dir,root,task,state,rpc,host,executor,summary,terminals,reservations,hooks,
    get executions(){return executions;},get stops(){return stops;},
    tool:()=>nativeTool(task,state,host,'host_check',{id:'check'},new AbortController().signal),
    close:async()=>{await executor.close();state.close();rmSync(dir,{recursive:true,force:true});}};
}
async function rejected(operation: Promise<unknown>): Promise<unknown> {
  let caught: unknown;
  await assert.rejects(operation,error=>{caught=error;return true;});
  return caught;
}

test('[B010] known false settles once with exact digest and durably stops without a successful reply',async()=>{
  const f=fixture(), source=f.task.source, text=JSON.stringify(f.summary);
  try {
    const error=await rejected(f.executor.turn('check'));
    await f.rpc.callbackDone;
    assert.equal(f.executions,1);assert.deepEqual(f.reservations,[source]);
    assert.deepEqual(f.terminals,[{status:'completed',digest:sha256(text)}]);
    assert.equal(f.state.value.pending,null);assert.equal(f.state.value.status,'stopped');
    assert.equal(f.state.value.stage,'host_check');assert.equal(f.state.value.source,source);
    assert.equal(f.state.value.counters.resultBytes,Buffer.byteLength(text));
    assert.equal(f.rpc.interrupts,1);assert.equal(f.stops,1);assert.equal(f.rpc.closed,true);
    const reply=f.rpc.replies[0];assert.ok(reply && 'result' in reply);
    assert.equal((reply.result as {success:boolean}).success,false);
    assert.equal(f.executor.receipt.finalResult,null);
    assert.deepEqual(nativeCheckFailure(error),{source,digest:sha256(text),summary:f.summary,receiptCompleted:true});
    assert.ok(Object.isFrozen(nativeCheckFailure(error)));assert.ok(Object.isFrozen(nativeCheckFailure(error)!.summary));
    f.summary.stdout='mutated later';
    assert.equal(nativeCheckFailure(error)!.summary.stdout,'actual bounded output');
    assert.equal(Reflect.set(nativeCheckFailure(error)!.summary,'passed',true),false);
    // Even a transport that delivers after close cannot accept a late final result or re-execute.
    f.rpc.emit({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed',items:[
      {type:'agentMessage',text:'late final result'},
    ]}}});
    await f.rpc.callback('late-check');
    assert.equal(f.executions,1);assert.equal(f.executor.receipt.finalResult,null);
    await rejected(f.executor.turn('must not continue'));
    f.state.close();
    const reopened=new NativeState(join(f.dir,'state'),f.task);
    try{assert.equal(reopened.value.pending,null);assert.equal(reopened.value.status,'stopped');}
    finally{reopened.close();}
  } finally {await f.close();}
});

test('[B010] true checks retain successful tool replies and ready settlement',async()=>{
  const f=fixture(true);
  try {
    await f.executor.turn('check');await f.rpc.callbackDone;
    assert.equal(f.executions,1);assert.equal(f.state.value.status,'ready');assert.equal(f.state.value.pending,null);
    const reply=f.rpc.replies[0];assert.ok(reply && 'result' in reply);
    assert.equal((reply.result as {success:boolean}).success,true);
    assert.deepEqual(f.terminals,[{status:'completed',digest:sha256(JSON.stringify(f.summary))}]);
  } finally {await f.close();}
});

test('[B010] execution errors retain their identity when best effort indeterminate finish also fails',async()=>{
  const f=fixture(), primary=new Error('execution primary');
  f.hooks.execute=async()=>{throw primary;};f.hooks.finish=()=>{throw new Error('secondary finish');};
  try {
    assert.equal(await rejected(f.executor.turn('check')),primary);await f.rpc.callbackDone;
    assert.deepEqual(f.terminals,[{status:'indeterminate',digest:undefined}]);
    assert.equal(f.executions,1);assert.equal(f.state.value.pending,'check');assert.equal(f.state.value.status,'indeterminate');
    assert.equal(nativeCheckFailure(primary),null);assert.equal(nativeFailedCheckFacts(primary),null);
  } finally {await f.close();}
});

test('[B010] source drift keeps check uncertainty and the actual bounded facts',async()=>{
  const f=fixture();f.hooks.afterResult=()=>writeFileSync(join(f.root,'value.txt'),'drift');
  try {
    const error=await rejected(f.executor.turn('check'));await f.rpc.callbackDone;
    assert.equal(nativeCheckFailure(error),null);assert.equal(nativeFailedCheckFacts(error)!.source,f.task.source);
    assert.equal(nativeFailedCheckFacts(error)!.receiptCompleted,false);
    assert.equal(f.state.value.pending,'check');assert.equal(f.state.value.status,'indeterminate');
    assert.deepEqual(f.terminals,[{status:'indeterminate',digest:undefined}]);assert.equal(f.executions,1);
  } finally {await f.close();}
});

test('[B010] completed finish errors never attempt a second terminal',async()=>{
  const f=fixture(), primary=new Error('finish primary');f.hooks.finish=()=>{throw primary;};
  try {
    assert.equal(await rejected(f.executor.turn('check')),primary);await f.rpc.callbackDone;
    assert.deepEqual(f.terminals,[{status:'completed',digest:sha256(JSON.stringify(f.summary))}]);
    assert.equal(f.state.value.pending,'check');assert.equal(f.state.value.status,'indeterminate');
    assert.equal(nativeCheckFailure(primary),null);assert.equal(nativeFailedCheckFacts(primary)!.receiptCompleted,false);
  } finally {await f.close();}
});

test('[B010] checkpoint failure after completed settlement restores uncertainty without refinish',async()=>{
  const f=fixture(), primary=new Error('checkpoint primary'), update=f.state.update.bind(f.state);
  f.state.update=patch=>{update(patch);if(patch.stage==='host_check')throw primary;};
  try {
    assert.equal(await rejected(f.executor.turn('check')),primary);await f.rpc.callbackDone;
    assert.equal(f.terminals.length,1);assert.equal(f.terminals[0]!.status,'completed');
    assert.equal(nativeCheckFailure(primary),null);assert.equal(nativeFailedCheckFacts(primary)!.receiptCompleted,true);
    assert.equal(f.state.value.pending,'check');assert.equal(f.state.value.status,'indeterminate');
  } finally {await f.close();}
});

test('[B010] a real checkpoint compare-and-swap failure cannot appear clean after completed finish',async()=>{
  const f=fixture(), update=f.state.update.bind(f.state);
  f.state.update=patch=>{
    if(patch.stage==='host_check'){
      const db=new DatabaseSync(join(f.dir,'state','native.sqlite'));
      try{db.exec("UPDATE checkpoint SET value=value || ' '");}finally{db.close();}
    }
    update(patch);
  };
  try {
    const error=await rejected(f.tool());
    assert.equal(nativeCheckFailure(error),null);assert.equal(nativeFailedCheckFacts(error)!.receiptCompleted,true);
    assert.equal(f.terminals.length,1);assert.equal(f.terminals[0]!.status,'completed');
    assert.equal(f.state.value.pending,'check');assert.equal(f.state.value.status,'indeterminate');
  } finally {
    const db=new DatabaseSync(join(f.dir,'state','native.sqlite'));
    try{db.exec('UPDATE checkpoint SET value=trim(value)');}finally{db.close();}
    await f.close();
  }
});


test('[B010] within-cap accounting persistence failure retains uncertain bounded facts',async()=>{
  const f=fixture(),file=join(f.dir,'state','native.sqlite');let saved:string|undefined;
  f.hooks.finish=()=>{const db=new DatabaseSync(file);try{saved=String(db.prepare('SELECT value FROM checkpoint WHERE id=1').get()!.value);db.prepare('UPDATE checkpoint SET value=? WHERE id=1').run(saved+' ');}finally{db.close();}};
  try{
    const error=await rejected(f.executor.turn('check'));await f.rpc.callbackDone;assert.ok(error instanceof Error);assert.match(error.message,/Concurrent checkpoint owner/);
    const facts=nativeFailedCheckFacts(error);assert.ok(facts);assert.equal(facts.accountingUncertain,true);
    assert.equal(facts.receiptCompleted,true);assert.equal(facts.source,f.task.source);assert.deepEqual(facts.summary,f.summary);
    assert.equal(facts.digest,sha256(JSON.stringify(f.summary)));assert.ok(Object.isFrozen(facts));
    assert.equal(f.state.value.counters.resultBytes,Buffer.byteLength(JSON.stringify(f.summary)));assert.equal(f.state.value.pending,'check');
    assert.equal(nativeCheckFailure(error),null);assert.equal(nativeRunFailureCode(error,'indeterminate',false,'check'),'cleanup-or-effect-indeterminate');
    assert.equal(f.executor.receipt.checkpointUncertain,true);assert.equal(f.state.value.status,'indeterminate');
    assert.equal(f.rpc.closed,true);assert.equal(f.stops,1);assert.equal(f.rpc.interrupts,1);
    assert.deepEqual(f.terminals,[{status:'completed',digest:facts.digest}]);assert.equal(f.executions,1);
  }finally{
    if(saved!==undefined){const db=new DatabaseSync(file);try{db.prepare('UPDATE checkpoint SET value=? WHERE id=1').run(saved);}finally{db.close();}}
    await f.close();
  }
});

test('[B010] result byte cap rejects before clearing pending or exposing uncharged facts',async()=>{
  const f=fixture(false,1);
  try {
    const error=await rejected(f.tool());
    assert.equal(nativeCheckFailure(error),null);assert.equal(nativeFailedCheckFacts(error),null);
    assert.equal(f.state.value.counters.resultBytes,0);assert.equal(f.state.value.pending,'check');
    assert.deepEqual(f.terminals,[{status:'completed',digest:sha256(JSON.stringify(f.summary))}]);assert.equal(f.executions,1);
  } finally {await f.close();}
});

test('[B010] finish failure remains primary when later result accounting also fails',async()=>{
  const f=fixture(false,1), primary=new Error('finish primary');f.hooks.finish=()=>{throw primary;};
  try {
    assert.equal(await rejected(f.tool()),primary);assert.equal(f.terminals.length,1);
    assert.equal(f.terminals[0]!.status,'completed');assert.equal(nativeFailedCheckFacts(primary),null);
    assert.equal(f.state.value.pending,'check');assert.equal(f.state.value.counters.resultBytes,0);
  } finally {await f.close();}
});

test('[B010] serialization errors preserve the first error and never duplicate finish',async()=>{
  const f=fixture(), primary=new Error('serialize primary');
  f.hooks.execute=async()=>({toJSON(){throw primary;}});f.hooks.finish=()=>{throw new Error('finish secondary');};
  try {
    assert.equal(await rejected(f.tool()),primary);assert.equal(f.terminals.length,1);
    assert.equal(f.state.value.pending,'check');assert.equal(nativeCheckFailure(primary),null);
  } finally {await f.close();}
});

test('[B010] boundary loss after completed settlement retains receipt-bound facts and pending uncertainty',async()=>{
  const f=fixture(), primary=new Error('authority boundary');let revoked=false;
  f.hooks.finish=()=>{revoked=true;};f.hooks.boundary=()=>{if(revoked)throw primary;};
  try {
    assert.equal(await rejected(f.tool()),primary);assert.equal(f.terminals.length,1);
    assert.equal(nativeFailedCheckFacts(primary)!.receiptCompleted,true);assert.equal(nativeCheckFailure(primary),null);
    assert.equal(f.state.value.pending,'check');
  } finally {await f.close();}
});

test('[B010] unrelated pending apply and check effects cannot be cleared by a check callback',async()=>{
  for(const pending of ['files.apply','check']) {
    const f=fixture();f.state.update({pending});
    try {await rejected(f.tool());assert.equal(f.state.value.pending,pending);assert.equal(f.executions,0);assert.equal(f.terminals.length,0);}
    finally {await f.close();}
  }
});

test('[B010] private failure classification survives public mutation and outranks secondary provider diagnostics',async()=>{
  const f=fixture();let reads=0;
  try {
    const error=await rejected(f.tool());assert.ok(error instanceof Error);
    Object.defineProperties(error,{message:{get(){reads++;throw new Error('getter');}},code:{get(){reads++;throw new Error('getter');}}});
    const diagnostic=new NativeProviderError({codexErrorInfo:'unauthorized'},false).diagnostic;
    assert.equal(nativeFailureCode(error,diagnostic),'verification-failed');
    assert.equal(nativeRunFailureCode(error,'stopped',false,null,diagnostic),'verification-failed');
    const envelope=new NativeRunError('native-turn',nativeFailureCode(error,diagnostic),{checks:nativeFailedCheckFacts(error)});
    assert.deepEqual(JSON.parse(JSON.stringify(envelope)).receipts.checks,nativeCheckFailure(error));
    assert.equal(reads,0);
    for(const claimed of [{code:'verification-failed',message:'Native predefined check failed'},Object.create(error),new Error('Native predefined check failed')]) {
      assert.equal(nativeCheckFailure(claimed),null);assert.equal(nativeFailureCode(claimed),'native-execution-failed');
    }
  } finally {await f.close();}
});

test('[B010] unrecognized hostile values invoke zero accessors coercions and proxy traps',()=>{
  let reads=0;const trap=()=>{reads++;throw new Error('hostile trap');};
  const handler={get:trap,getPrototypeOf:trap,getOwnPropertyDescriptor:trap,ownKeys:trap,has:trap};
  const accessor=Object.defineProperties(new Error(),{message:{get:trap},code:{get:trap},diagnostic:{get:trap}});
  const prototype=new Error('untrusted');Object.setPrototypeOf(prototype,new Proxy({},handler));
  const values:unknown[]=[new Proxy({},handler),new Proxy(new Error('check'),handler),accessor,prototype,
    Object.defineProperties({},{message:{get:trap},code:{get:trap},[Symbol.toPrimitive]:{get:trap}})];
  const revoked=Proxy.revocable({},handler);revoked.revoke();values.push(revoked.proxy);
  for(const value of values){
    assert.equal(nativeCheckFailure(value),null);assert.equal(nativeFailedCheckFacts(value),null);
    assert.equal(nativeFailureCode(value),'native-execution-failed');
  }
  assert.equal(reads,0);
});

test('[B010] honest cleanup cancellation and pending precedence retain known failed facts',async()=>{
  for(const mode of ['cleanup','cancel']) {
    const f=fixture(), controller=new AbortController();
    f.hooks.stop=()=>{if(mode==='cleanup')throw new Error('cleanup');controller.abort();};
    try {
      const error=await rejected(f.executor.turn('check',controller.signal));await f.rpc.callbackDone;
      assert.ok(nativeCheckFailure(error));assert.equal(f.state.value.pending,null);
      const code=nativeRunFailureCode(error,f.state.value.status,controller.signal.aborted,null);
      assert.equal(code,mode==='cleanup'?'cleanup-or-effect-indeterminate':'cancelled');
      assert.equal(nativeFailedCheckFacts(error)!.summary.passed,false);assert.equal(f.terminals.length,1);
      assert.equal(nativeRunFailureCode(error,'stopped',false,'files.apply'),'pending-effect');
    } finally {await f.close();}
  }
});

test('[B010] legitimate host and provider classifications retain compatibility',()=>{
  for(const [message,code] of [['Native account expired','account-or-authority'],['Native budget exhausted','budget-exhausted'],
    ['Pinned runtime drift','runtime-unqualified'],['Stale source checkpoint','source-or-checkpoint'],['Native reported error','native-execution-failed']]) {
    assert.equal(nativeFailureCode(new Error(message)),code);
  }
  const diagnostic=new NativeProviderError({codexErrorInfo:'rateLimitExceeded'},false).diagnostic;
  assert.equal(nativeFailureCode(new Error('rpc closed'),diagnostic),'native-provider-rate-limit');
  assert.equal(nativeFailureCode(new NativeProviderError({codexErrorInfo:'unauthorized'},false)),'native-provider-unauthorized');
});


test('[B010] raw fatal proxies never trigger traps when the owner reads the full executor receipt',async()=>{
  let traps=0;
  const hostile=new Proxy(new Error('host fault'),{
    get(){traps++;throw new Error('Unexpected get');},
    getPrototypeOf(){traps++;throw new Error('Unexpected prototype');},
    getOwnPropertyDescriptor(){traps++;throw new Error('Unexpected descriptor');},
  });
  const revoked=Proxy.revocable(new Error('revoked'),{});revoked.revoke();
  const inherited=new Error('inherited proxy');Object.setPrototypeOf(inherited,hostile);
  for(const original of [hostile,revoked.proxy,inherited]){
    const f=fixture();f.hooks.execute=async()=>{throw original;};
    try{
      let caught:unknown;try{await f.executor.turn('check');}catch(error){caught=error;}
      assert.equal(caught,original);await f.rpc.callbackDone;
      const receipt=f.executor.receipt;
      assert.equal(receipt.nativeDiagnostic,null);assert.equal(receipt.checkpointUncertain,false);
      assert.equal(receipt.checkpoint.pending,'check');assert.equal(receipt.checkpoint.status,'indeterminate');
      assert.equal(nativeRunFailureCode(original,receipt.checkpoint.status,false,receipt.checkpoint.pending),'cleanup-or-effect-indeterminate');
      assert.equal(receipt.finalResult,null);assert.equal(f.stops,1);assert.equal(f.rpc.closed,true);
      assert.deepEqual(f.terminals,[{status:'indeterminate',digest:undefined}]);
      assert.equal(traps,0);
    }finally{await f.close();}
  }
  assert.equal(traps,0);
});

test('[B010] provider receipts use constructor-owned diagnostic identity without reading mutable properties',()=>{
  const error=new NativeProviderError({codexErrorInfo:'unauthorized'},false),expected=error.diagnostic;
  let reads=0;Object.defineProperty(error,'diagnostic',{get(){reads++;throw new Error('Unexpected diagnostic getter');}});
  assert.equal(nativeProviderDiagnostic(error),expected);assert.equal(reads,0);assert.equal(Object.isFrozen(expected),true);
  assert.deepEqual(expected,{kind:'unauthorized',httpStatusCode:null,willRetry:false});
  assert.equal(nativeProviderDiagnostic(new Proxy(error,{})),null);
  assert.equal(nativeProviderDiagnostic(Object.create(NativeProviderError.prototype)),null);
});
