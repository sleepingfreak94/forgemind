import { PassThrough } from 'node:stream';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { NativeExecutor, NativeProviderError } from '../../src/live-workflow/native-executor.js';
import { NativeState } from '../../src/live-workflow/native-executor-state.js';
import { FixtureNativeHost, fixtureStdioRpc } from '../../src/live-workflow/native-executor-host.js';
import { nativeReadiness } from '../../src/live-workflow/native-executor-readiness.js';
import { nativeTool, nativeCheckFailure } from '../../src/live-workflow/native-executor-tools.js';
import { ownerRouting } from '../../src/live-workflow/routing-profile.js';
import { sha256 } from '../../src/live-workflow/validation.js';
import type { NativeTask } from '../../src/live-workflow/native-executor-contracts.js';

function setup() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'native-fixture-')), root = join(dir, 'repo');
  spawnSync(process.execPath, ['-e', 'require("node:fs").mkdirSync(process.argv[1])', root]);
  writeFileSync(join(root, 'file.txt'), 'before');
  const task: NativeTask = { project: 'fixture', task: 'task', model:'gpt-6.1-sol',effort:'medium',source: sha256('before'), root,
    readPaths: ['file.txt'], writePaths: ['file.txt'], checks: [{ id: 'check', executable: process.execPath, args: [], timeoutMs: 1000 }],
    budget: { retries:0,runtimeMs: 2000, turns: 4, toolCalls: 12, inputBytes: 10000, resultBytes: 10000, wireBytes: 50000, outputBytes: 1000 } };
  return { dir, task, state: new NativeState(join(dir, 'state'), task) };
}
const program = `
const rl=require('node:readline').createInterface({input:process.stdin});
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
let n=100,phase=0,hash='';
function tool(name,args){send({id:++n,method:'item/tool/call',params:{threadId:'thread',turnId:'turn',callId:'call'+n,tool:name,arguments:args,namespace:null}})}
rl.on('line',line=>{const m=JSON.parse(line);
 if(m.method==='initialize') send({id:m.id,result:{}});
 if(m.method==='thread/start'||m.method==='thread/resume') {send({method:'thread/started',params:{thread:{id:'thread'}}}); send({id:m.id,result:{thread:{id:'thread',turns:[],cliVersion:'0.162.1',cwd:m.params.cwd,ephemeral:false,modelProvider:'openai'},model:m.params.model,modelProvider:'openai',cwd:m.params.cwd,reasoningEffort:m.params.config.model_reasoning_effort,approvalPolicy:'never',approvalsReviewer:'user',serviceTier:'default',sandbox:{type:'readOnly',networkAccess:false}}});}
 if(m.method==='turn/start'){send({method:'turn/started',params:{threadId:'thread',turn:{id:'turn',status:'inProgress',items:[]}}});send({id:m.id,result:{turn:{id:'turn',status:'inProgress',items:[]}}}); setImmediate(()=>tool('host_read',{path:'file.txt'}));}
 if(m.result&&m.id>100){if(!m.result.success)return;
 if(phase++===0){hash=JSON.parse(m.result.contentItems[0].text).sha256; tool('host_apply',{summary:'fixture edit',edits:[{path:'file.txt',beforeSha256:hash,content:'after'}]});}
 else if(phase===2)tool('host_check',{id:'check'});
 else send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed',items:[]}}});}
});`;
function hostFor(task: NativeTask, child: ReturnType<typeof spawn>, boundary = () => undefined, badStop = false) {
  const receipts: string[] = [];
  const rpc = fixtureStdioRpc(child.stdout!, child.stdin!);
  const host = new FixtureNativeHost(rpc, { reserve: e => { receipts.push(e.kind); return { check: boundary, finish: s => { receipts.push(s); } }; } }, boundary,
    async () => { child.kill(); await new Promise<void>(r => child.once('close', () => r())); if (badStop) throw new Error('cleanup failed'); },
    () => sha256(readFileSync(join(task.root, 'file.txt'))),
    async id => { assert.equal(id, 'check'); assert.equal(readFileSync(join(task.root, 'file.txt'), 'utf8'), 'after'); return { passed: true }; });
  return { host, receipts };
}
test('actual fixture subprocess performs digest-bound read apply check; restart retains stage and budget', async () => {
  const { dir, task, state } = setup();
  const child = spawn(process.execPath, ['-e', program], { stdio: ['pipe', 'pipe', 'pipe'] });
  const { host, receipts } = hostFor(task, child);
  const executor = new NativeExecutor(task, state, host);
  try {
    await executor.turn('offline fixture');
    assert.equal(state.value.stage, 'host_check'); assert.equal(state.value.counters.toolCalls, 3);
    assert.deepEqual(receipts, ['artifact','completed','files.apply','completed','command','completed']);
    assert.equal(nativeReadiness(host, 'live', true).ready, false);
    const source = state.value.source, counters = state.value.counters;
    await executor.close(); state.close();
    const modules = (name:string) => JSON.stringify(new URL('../../src/live-workflow/'+name+'.js',import.meta.url).href);
    const childResume = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import {NativeState} from ${modules('native-executor-state')};
      import {NativeExecutor} from ${modules('native-executor')};
      import {FixtureNativeHost,fixtureStdioRpc} from ${modules('native-executor-host')};
      import {spawn} from 'node:child_process';
      const task=JSON.parse(process.argv[2]);
      const state=new NativeState(process.argv[1],task);
      const child=spawn(process.execPath,['-e',process.argv[3]]);
      let freshChecks=0;
      const host=new FixtureNativeHost(fixtureStdioRpc(child.stdout,child.stdin),{
        reserve:()=>({check:()=>{freshChecks++},finish:()=>{}})
      },()=>undefined,async()=>{child.kill();await new Promise(r=>child.once('close',r));},()=>task.source,async()=>({passed:true}));
      const executor=new NativeExecutor(task,state,host);
      await executor.turn('resume continuation');
      process.stdout.write(JSON.stringify({checkpoint:state.value,freshChecks}));
      await executor.close();state.close();`, join(dir, 'state'), JSON.stringify({ ...task, source }),program.replace('n=100','n=200')], { encoding: 'utf8' });
    assert.equal(childResume.status, 0, childResume.stderr);
    const result = JSON.parse(childResume.stdout), resumed=result.checkpoint;
    assert.equal(resumed.stage,'host_check'); assert.equal(resumed.thread,'thread');
    assert.equal(resumed.counters.turns,counters.turns+1);assert.equal(resumed.counters.toolCalls,6);
    assert.ok(resumed.counters.wireBytes>counters.wireBytes);assert.ok(result.freshChecks>0);
    assert.deepEqual(resumed.seen,['call101','call102','call103','call201','call202','call203']);
  } finally { child.kill(); rmSync(dir, { recursive: true, force: true }); }
});
test('exact paths, stale digest, unknown tools, malformed arguments and exhausted budgets deny', async () => {
  for (const [tool, args] of [['host_read', {path:'../file.txt'}], ['host_read',{path:'file.txt',extra:1}], ['host_check',{id:'other'}], ['shell',{}], ['host_apply',{summary:'bad',edits:[{path:'file.txt',beforeSha256:sha256('stale'),content:'bad'}]}]] as const) {
    const { dir, task, state } = setup(); const child = spawn(process.execPath, ['-e','setInterval(()=>{},1000)']); const {host} = hostFor(task,child);
    try { await assert.rejects(nativeTool(task,state,host,tool,args,new AbortController().signal)); assert.equal(readFileSync(join(task.root,'file.txt'),'utf8'),'before'); }
    finally { child.kill();state.close();rmSync(dir,{recursive:true,force:true}); }
  }
  const {dir,state}=setup(); try { state.claim('once'); assert.throws(()=>state.claim('once'),/Replayed/); assert.throws(()=>state.charge('turns',5),/exhausted/); }
  finally {state.close();rmSync(dir,{recursive:true,force:true});}
});
test('cancel, revocation, expiry, disconnect stop; cleanup failure remains indeterminate', async () => {
  for (const reason of ['cancel','revocation','expiry','disconnect','cleanup']) {
    const {dir,task,state}=setup(); let revoked=false;
    const child=spawn(process.execPath,['-e',program.replace("setImmediate(()=>tool('host_read',{path:'file.txt'}));",'')]);
    const {host}=hostFor(task,child,()=>{if(revoked)throw new Error(reason);},reason==='cleanup');
    const executor=new NativeExecutor(task,state,host), controller=new AbortController();
    const running=executor.turn('wait',controller.signal);
    setTimeout(()=>{if(reason==='disconnect')child.kill();else if(reason==='cancel'||reason==='cleanup')controller.abort();else revoked=true;},70);
    try { await assert.rejects(running);assert.equal(state.value.status,reason==='cleanup'?'indeterminate':'stopped'); }
    finally {await executor.close();state.close();rmSync(dir,{recursive:true,force:true});}
  }
});
test('interrupted pending mutation is never automatically replayed; binding cannot broaden on resume',()=>{
  const {dir,task,state}=setup();state.update({pending:'files.apply'});state.close();
  try {assert.throws(()=>new NativeState(join(dir,'state'),task),/reconciliation/);assert.throws(()=>new NativeState(join(dir,'state'),{...task,writePaths:['other']}),/binding/);}
  finally {rmSync(dir,{recursive:true,force:true});}
});
test('owner routing is scoped and availability remains unverified',()=>{
  assert.equal(ownerRouting('coder').model,'gpt-6.1-sol');assert.equal(ownerRouting('reviewer').effort,'medium');
  assert.throws(()=>ownerRouting('architect'),/Astra/);assert.throws(()=>ownerRouting('classifier'),/qualified/);
  assert.equal(ownerRouting('weekly-summary').execution,'deterministic');
  assert.equal(ownerRouting('architect',{highTried:true,architecturePurpose:'bounded architecture decision'}).availability,'unverified');
});

test('checkpoint rejects concurrent owners', () => {
  const {dir,task,state}=setup(); const second=new NativeState(join(dir,'state'),task);
  try {state.charge('turns',1); assert.throws(()=>second.charge('turns',1),/Concurrent/);}
  finally {second.close();state.close();rmSync(dir,{recursive:true,force:true});}
});
test('serialized host configuration cannot qualify readiness', () => {
  assert.throws(()=>nativeReadiness({qualification:'offline-fixture',boundary:()=>undefined} as FixtureNativeHost,'live',true),/Trusted/);
});
test('replayed, malformed, builtin approval and unknown callbacks stop the subprocess', async () => {
  const variants=[
    program.replace("tool('host_apply',{summary:","tool('host_apply',{summary:").replace("callId:'call'+n", "callId:'same'"),
    program.replace("tool('host_read',{path:'file.txt'})", "tool('host_read',null)"),
    program.replace("method:'item/tool/call'", "method:'item/commandExecution/requestApproval'"),
    program.replace("tool('host_read',{path:'file.txt'})", "tool('unknown',{})")
  ];
  for(const script of variants){
    const {dir,task,state}=setup();const child=spawn(process.execPath,['-e',script]);const {host}=hostFor(task,child);const executor=new NativeExecutor(task,state,host);
    try{await assert.rejects(executor.turn('deny'));assert.equal(readFileSync(join(task.root,'file.txt'),'utf8'),'before');}
    finally{await executor.close();state.close();rmSync(dir,{recursive:true,force:true});}
  }
});
test('wire and runtime limits stop actual fixture processes', async () => {
  for(const key of ['wireBytes','runtimeMs'] as const){
    const {dir,task,state:initial}=setup();initial.close();rmSync(join(dir,'state'),{recursive:true});task.budget[key]=key==='wireBytes'?10:50;
    const state=new NativeState(join(dir,'state'),task);const child=spawn(process.execPath,['-e',program.replace("setImmediate(()=>tool('host_read',{path:'file.txt'}));",'')]);const {host}=hostFor(task,child);const executor=new NativeExecutor(task,state,host);
    try{await assert.rejects(executor.turn('limit'));assert.equal(state.value.status,'stopped');}
    finally{await executor.close();state.close();rmSync(dir,{recursive:true,force:true});}
  }
});

test('workspace child named ..evil is not an external private state directory',()=>{
  const {dir,task,state}=setup();
  try {assert.throws(()=>new NativeState(join(task.root,'..evil'),task),/outside workspace/);}
  finally {state.close();rmSync(dir,{recursive:true,force:true});}
});

test('output, result and callback budgets deny actual fixture traffic', async()=>{
  for(const key of ['outputBytes','resultBytes','toolCalls'] as const){
    const {dir,task,state:initial}=setup();initial.close();rmSync(join(dir,'state'),{recursive:true});task.budget[key]=key==='toolCalls'?1:3;
    const state=new NativeState(join(dir,'state'),task);
    const script=key==='outputBytes'?program.replace("setImmediate(()=>tool('host_read',{path:'file.txt'}));","setImmediate(()=>send({method:'item/agentMessage/delta',params:{threadId:'thread',turnId:'turn',delta:'large'}}));"):program;
    const child=spawn(process.execPath,['-e',script]);const {host}=hostFor(task,child);const executor=new NativeExecutor(task,state,host);
    try {await assert.rejects(executor.turn('limit'));assert.equal(readFileSync(join(task.root,'file.txt'),'utf8'),'before');}
    finally {await executor.close();state.close();rmSync(dir,{recursive:true,force:true});}
  }
});
test('effective native model mismatch fails before a turn or write',async()=>{
  const {dir,task,state}=setup();const child=spawn(process.execPath,['-e',program.replace('model:m.params.model',"model:'other-model'" )]);const {host}=hostFor(task,child);const executor=new NativeExecutor(task,state,host);
  try {await assert.rejects(executor.turn('model'),/configuration mismatch/);assert.equal(readFileSync(join(task.root,'file.txt'),'utf8'),'before');}
  finally {await executor.close();state.close();rmSync(dir,{recursive:true,force:true});}
});

test('malformed durable counters and indeterminate cleanup require owner reconciliation',()=>{
  for(const corruption of ['counter','indeterminate']){
    const {dir,task,state}=setup();state.close();const db=new DatabaseSync(join(dir,'state','native.sqlite'));
    const value=JSON.parse(String(db.prepare('SELECT value FROM checkpoint').get()!.value));
    if(corruption==='counter')value.counters.turns=-1;else value.status='indeterminate';
    db.prepare('UPDATE checkpoint SET value=?').run(JSON.stringify(value));db.close();
    try{assert.throws(()=>new NativeState(join(dir,'state'),task),corruption==='counter'?/counters/:/reconciliation/);}
    finally{rmSync(dir,{recursive:true,force:true});}
  }
});

test('canonical workspace validation rejects a symlink alias before creating state', () => {
  const { dir, task, state } = setup();
  const alias = join(dir, 'alias');
  const inside = join(task.root, 'owner-state');
  symlinkSync(task.root, alias, 'dir');
  try {
    assert.throws(() => new NativeState(inside, { ...task, root: alias }), /Canonical real workspace/);
    assert.equal(existsSync(inside), false);
  } finally {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const terminal = { method: 'turn/completed', params: {
  threadId: 'thread', turn: { id: 'turn', status: 'completed', items: [] },
} };
const terminalStatement = "else send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed',items:[]}}});";

function writeBatch(frames: unknown[]): string {
  const wire = frames.map(frame => JSON.stringify(frame)).join('\n') + '\n';
  return 'process.stdout.write(' + JSON.stringify(wire) + ');';
}

test('same-batch conflicting terminals, duplicate completion and denied callbacks never commit ready', async () => {
  const conflicts = [
    { ...terminal, params: { threadId: 'thread', turn: { id: 'turn', status: 'failed', items: [] } } },
    terminal,
    { id: 900, method: 'item/tool/call', params: {
      threadId: 'thread', turnId: 'turn', callId: 'after-terminal', tool: 'unknown', arguments: {},
    } },
    { method: 'error', params: { threadId: 'thread', turnId: 'turn', message: 'queued fault' } },
  ];
  for (const conflict of conflicts) {
    const { dir, task, state } = setup();
    const child = spawn(process.execPath, ['-e', program.replace(terminalStatement, 'else {' + writeBatch([terminal, conflict]) + '}')]);
    const { host } = hostFor(task, child);
    const executor = new NativeExecutor(task, state, host);
    const statuses: string[] = [];
    const update = state.update.bind(state);
    state.update = patch => { if (patch.status) statuses.push(patch.status); update(patch); };
    try {
      await assert.rejects(executor.turn('terminal conflict'));
      assert.equal(state.value.status, 'stopped');
      assert.equal(statuses.includes('ready'), false);
    } finally {
      await executor.close(); state.close(); rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('queued preack terminal fault is rejected when the native turn acknowledgement drains it', async () => {
  const { dir, task, state } = setup();
  const completion = program.indexOf("if(m.method==='turn/start')");
  const replies = program.indexOf(' if(m.result', completion);
  const failed = { ...terminal, params: { threadId: 'thread', turn: { id: 'turn', status: 'failed', items: [] } } };
  const ack = { id: 3, result: { turn: { id: 'turn', status: 'inProgress', items: [] } } };
  const script = program.slice(0, completion) + "if(m.method==='turn/start'){" +
    writeBatch([terminal, failed, ack]) + '}' + program.slice(replies);
  const child = spawn(process.execPath, ['-e', script]);
  const { host } = hostFor(task, child);
  const executor = new NativeExecutor(task, state, host);
  try {
    await assert.rejects(executor.turn('preack conflict'));
    assert.equal(state.value.status, 'stopped');
  } finally {
    await executor.close(); state.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('queued authority revocation at terminal settlement cannot return success', async () => {
  const { dir, task, state } = setup();
  let revoked = false;
  const child = spawn(process.execPath, ['-e', program]);
  const { host } = hostFor(task, child, () => { if (revoked) throw new Error('revoked at settlement'); });
  host.rpc.onNotification(event => {
    if (event.method === 'turn/completed') queueMicrotask(() => { revoked = true; });
  });
  const executor = new NativeExecutor(task, state, host);
  try {
    await assert.rejects(executor.turn('settlement authority'), /revoked/);
    assert.equal(state.value.status, 'stopped');
  } finally {
    await executor.close(); state.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('transport disconnect observed during the terminal receive batch rejects settlement', async () => {
  const { dir, task, state } = setup();
  const child = spawn(process.execPath, ['-e', program]);
  const { host } = hostFor(task, child);
  const executor = new NativeExecutor(task, state, host);
  // Close the actual metered fixture transport after its completion listener has
  // resolved done, while dispatching the same received notification batch.
  host.rpc.onNotification(event => {
    if (event.method === 'turn/completed') host.rpc.close();
  });
  try {
    await assert.rejects(executor.turn('observed disconnect'));
    assert.equal(state.value.status, 'stopped');
  } finally {
    await executor.close(); state.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('native notification and failed-turn diagnostics survive actual fixture cleanup without remote text',async()=>{
  const marker='DO_NOT_EXPOSE_TOKEN_OR_PROMPT';
  const cases=[{info:'unauthorized',kind:'unauthorized',http:null},
    {info:{httpConnectionFailed:{httpStatusCode:401}},kind:'httpConnectionFailed',http:401},
    {info:'rateLimitExceeded',kind:'rateLimitExceeded',http:null},
    {info:{responseStreamDisconnected:{httpStatusCode:502}},kind:'responseStreamDisconnected',http:502},
    {info:{unknownRemoteKind:marker},kind:'unknown',http:null}];
  for(const mode of ['notification','failed-turn'])for(const entry of cases){
    const {dir,task,state}=setup();
    const rawError={message:marker,additionalDetails:marker,misalignment:{explanation:marker},codexErrorInfo:entry.info};
    const notification=mode==='notification'
      ? {method:'error',params:{threadId:'thread',turnId:'turn',error:rawError,willRetry:false}}
      : {method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'failed',items:[],error:rawError}}};
    const completion="else send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed',items:[]}}});";
    const child=spawn(process.execPath,['-e',program.replace(completion,'else send('+JSON.stringify(notification)+');')]);
    const {host}=hostFor(task,child),executor=new NativeExecutor(task,state,host);
    try{
      await assert.rejects(executor.turn('safe fixture error'),error=>{
        assert.ok(error instanceof NativeProviderError);
        assert.deepEqual(error.diagnostic,{kind:entry.kind,httpStatusCode:entry.http,willRetry:false});
        assert.equal((error as Error & {cause?:unknown}).cause,undefined);
        assert.equal(String(error).includes(marker),false);return true;
      });
      assert.equal(state.value.status,'stopped');
      assert.deepEqual(executor.receipt.nativeDiagnostic,{kind:entry.kind,httpStatusCode:entry.http,willRetry:false});
      assert.equal(JSON.stringify(executor.receipt).includes(marker),false);
    }finally{await executor.close();state.close();rmSync(dir,{recursive:true,force:true});}
  }
});

function resumeFixture(history:unknown[],event:unknown,phase:'before-reply'|'bootstrap'|'active') {
  let script=program.replace('turns:[]','turns:'+JSON.stringify(history));
  const send=event===null?'':'send('+JSON.stringify(event)+');';
  if(phase==='before-reply')script=script.replace("send({method:'thread/started'",send+"send({method:'thread/started'");
  else if(phase==='bootstrap')script=script.replace("if(m.method==='turn/start')", "if(m.method==='thread/resume'){"+send+"} if(m.method==='turn/start')");
  else script=script.replace("setImmediate(()=>tool('host_read',{path:'file.txt'}));", "setImmediate(()=>{"+send+"tool('host_read',{path:'file.txt'});});");
  return script;
}
const oldUsage={method:'thread/tokenUsage/updated',params:{threadId:'thread',turnId:'old',tokenUsage:{fixtureHistoricalSecret:'discard'}}};

test('resume bootstrap discards only validated terminal history usage before new acknowledgement',async()=>{
  for(const phase of ['before-reply','bootstrap'] as const){
    const {dir,task,state}=setup();state.update({thread:'thread'});state.charge('turns',1);state.charge('toolCalls',2);
    const before=state.value.counters;
    const child=spawn(process.execPath,['-e',resumeFixture([{id:'old',status:'completed'}],oldUsage,phase)]);
    const {host}=hostFor(task,child),executor=new NativeExecutor(task,state,host);
    try{
      await executor.turn('resume historical usage');
      assert.equal(state.value.status,'ready');assert.equal(executor.receipt.observedTokenUsage,null);
      assert.equal(state.value.counters.turns,before.turns+1);assert.equal(state.value.counters.toolCalls,before.toolCalls+3);
      assert.ok(state.value.counters.wireBytes>before.wireBytes);assert.ok(state.value.counters.runtimeMs>before.runtimeMs);
      assert.equal(JSON.stringify(executor.receipt).includes('fixtureHistoricalSecret'),false);
    }finally{await executor.close();state.close();rmSync(dir,{recursive:true,force:true});}
  }
});
test('resume exceptions deny wrong thread, unknown turn, late history and historical effects',async()=>{
  const variants:[unknown,'bootstrap'|'active'][]=[
    [{...oldUsage,params:{...oldUsage.params,threadId:'other'}},'bootstrap'],
    [{...oldUsage,params:{...oldUsage.params,turnId:'future'}},'bootstrap'],
    [oldUsage,'active'],
    [{method:'item/agentMessage/delta',params:{threadId:'thread',turnId:'old',delta:'unsafe'}},'bootstrap'],
    [{method:'turn/completed',params:{threadId:'thread',turn:{id:'old',status:'completed',items:[]}}},'bootstrap'],
    [{method:'error',params:{threadId:'thread',turnId:'old',error:{codexErrorInfo:'unauthorized'},willRetry:false}},'bootstrap'],
    ...(['item/started','item/completed'] as const).map(method=>[{method,params:{threadId:'thread',turnId:'old',item:{type:'agentMessage',text:'unsafe'}}},'bootstrap'] as [unknown,'bootstrap']),
    [{id:900,method:'item/tool/call',params:{threadId:'thread',turnId:'old',callId:'old-call',tool:'host_read',arguments:{path:'file.txt'}}},'bootstrap'],
  ];
  for(const [event,phase] of variants){
    const {dir,task,state}=setup();state.update({thread:'thread'});
    const child=spawn(process.execPath,['-e',resumeFixture([{id:'old',status:'completed'}],event,phase)]);
    const {host}=hostFor(task,child),executor=new NativeExecutor(task,state,host);
    try{await assert.rejects(executor.turn('deny history'));assert.equal(state.value.status,'stopped');assert.equal(state.value.counters.toolCalls,0);assert.equal(readFileSync(join(task.root,'file.txt'),'utf8'),'before');}
    finally{await executor.close();state.close();rmSync(dir,{recursive:true,force:true});}
  }
});
test('malformed, unfinished, duplicate history and reused active ID deny resume',async()=>{
  for(const history of [[{id:'old',status:'inProgress'}],[{id:'',status:'completed'}],[{id:'old',status:'failed'},{id:'old',status:'completed'}],[{id:'turn',status:'interrupted'}],...[['completed'],{},null,undefined].map(status=>[{id:'old',status}])]){
    const {dir,task,state}=setup();state.update({thread:'thread'});
    const child=spawn(process.execPath,['-e',resumeFixture(history,null,'bootstrap')]);
    const {host}=hostFor(task,child),executor=new NativeExecutor(task,state,host);
    try{await assert.rejects(executor.turn('invalid history'),history[0]?.id==='turn'?/Native turn reused historical ID/:/Invalid resumed turn history/);assert.equal(state.value.status,'stopped');assert.equal(state.value.counters.toolCalls,0);}
    finally{await executor.close();state.close();rmSync(dir,{recursive:true,force:true});}
  }
});

test('historical allowset and observed tokens reset on each host-started turn',async()=>{
  const {dir,task,state}=setup();state.update({thread:'thread'});
  const current={method:'thread/tokenUsage/updated',params:{threadId:'thread',turnId:'turn',tokenUsage:{currentFixtureTokens:7}}};
  const script=resumeFixture([],oldUsage,'bootstrap').replace("let n=100,phase=0,hash='';","let n=100,phase=0,hash='',resumes=0;")
    .replace('turns:[]',"turns:(++resumes===1?[{id:'old',status:'completed'}]:[])")
    .replace(terminalStatement,'else {'+writeBatch([current,terminal])+'}');
  const child=spawn(process.execPath,['-e',script]);const {host}=hostFor(task,child),executor=new NativeExecutor(task,state,host);
  try{
    await executor.turn('first turn');assert.deepEqual(executor.receipt.observedTokenUsage,{currentFixtureTokens:7});
    const tools=state.value.counters.toolCalls;
    await assert.rejects(executor.turn('second turn'));
    assert.equal(executor.receipt.observedTokenUsage,null);assert.equal(state.value.counters.toolCalls,tools);
    assert.equal(state.value.status,'stopped');
  }finally{await executor.close();state.close();rmSync(dir,{recursive:true,force:true});}
});


async function failedCheckProcess(injectLateFrame:boolean){
  const {dir,task,state}=setup(), summary={id:'check',passed:false,exitCode:1,stdout:'actual failed check',stderr:''};
  const late={method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed',items:[{type:'agentMessage',text:'late final result'}]}}};
  const lateOutput=injectLateFrame?'':'send('+JSON.stringify(late)+');';
  const script=program.replace("setImmediate(()=>tool('host_read',{path:'file.txt'}));","setImmediate(()=>tool('host_check',{id:'check'}));")
    .replace("if(m.method==='initialize')","if(m.method==='turn/interrupt'){send({id:m.id,result:{}});"+lateOutput+"} if(m.method==='initialize')");
  const child=spawn(process.execPath,['-e',script]), incoming=new PassThrough();
  child.stdout!.pipe(incoming);const rpc=fixtureStdioRpc(incoming,child.stdin!);
  let checks=0,stops=0,interrupts=0,lateFrames=0;
  const terminals:{status:string;digest:string|undefined}[]=[], sources:string[]=[];
  const request=rpc.request.bind(rpc);
  rpc.request=(method,params,onResult)=>{
    if(method==='turn/interrupt'){
      interrupts++;
      // Trusted fixture wire injection after fatal stop, before the real request
      // and its cleanup timer. It traverses the meter, JSONL parser and receiver.
      if(injectLateFrame)incoming.write(JSON.stringify(late)+'\n');
    }
    return request(method,params,onResult);
  };
  rpc.onNotification(event=>{if(event.method==='turn/completed')lateFrames++;});
  const host=new FixtureNativeHost(rpc,{reserve(envelope){sources.push(envelope.source);return{check:()=>{},finish(status,digest){terminals.push({status,digest});}};}},
    ()=>{},async()=>{stops++;child.kill();await new Promise<void>(done=>child.once('close',()=>done()));},()=>task.source,async()=>{checks++;return summary;});
  const executor=new NativeExecutor(task,state,host);
  try{
    await assert.rejects(executor.turn('failed check'),error=>{assert.deepEqual(nativeCheckFailure(error),{source:task.source,digest:sha256(JSON.stringify(summary)),summary,receiptCompleted:true});return true;});
    assert.equal(checks,1);assert.equal(interrupts,1);assert.equal(stops,1);
    if(injectLateFrame)assert.equal(lateFrames,1);
    else assert.ok(lateFrames===0||lateFrames===1); // RPC may close before the child's later write.
    assert.deepEqual(sources,[task.source]);assert.deepEqual(terminals,[{status:'completed',digest:sha256(JSON.stringify(summary))}]);
    assert.equal(state.value.pending,null);assert.equal(state.value.status,'stopped');assert.equal(state.value.source,task.source);
    assert.equal(executor.receipt.finalResult,null);assert.ok(child.exitCode!==null||child.signalCode!==null);
    await assert.rejects(executor.turn('late continuation'));assert.equal(checks,1);assert.equal(executor.receipt.finalResult,null);
  }finally{await executor.close();state.close();incoming.destroy();rmSync(dir,{recursive:true,force:true});}
}

test('[B010] failed host_check interrupts and reaps the subprocess without accepting its late final result',()=>failedCheckProcess(false));
test('[B010] observed injected late completion is rejected before interrupt acknowledgement and subprocess reaping',()=>failedCheckProcess(true));

test('delayed bootstrap snapshot is discarded before delayed acknowledgement; fresh threads have no exception',async()=>{
  for(const resumed of [true,false]){
    const {dir,task,state}=setup();if(resumed)state.update({thread:'thread'});
    const script=resumeFixture([{id:'old',status:'completed'}],null,'bootstrap')
      .replace("if(m.method==='turn/start'){", "if(m.method==='turn/start'){setTimeout(()=>send("+JSON.stringify(oldUsage)+"),5);setTimeout(()=>{")
      .replace("setImmediate(()=>tool('host_read',{path:'file.txt'}));}","setImmediate(()=>tool('host_read',{path:'file.txt'}));},30);}");
    const child=spawn(process.execPath,['-e',script]);const {host}=hostFor(task,child),executor=new NativeExecutor(task,state,host);
    try{
      if(resumed){await executor.turn('delayed resume');assert.equal(state.value.status,'ready');assert.equal(executor.receipt.observedTokenUsage,null);}
      else{await assert.rejects(executor.turn('fresh thread old usage'),/Wrong notification turn/);assert.equal(state.value.counters.toolCalls,0);}
    }finally{await executor.close();state.close();rmSync(dir,{recursive:true,force:true});}
  }
});
