import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync,readFileSync,renameSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { executionFixture } from './chatgpt-execution-fixture.js';
import { ChatGPTStore } from '../../src/live-workflow/chatgpt-store.js';
import { ChatGPTExecutionLedger,ChatGPTRefreshDeferred } from '../../src/live-workflow/chatgpt-execution-ledger.js';
import { ChatGPTExecutionLease } from '../../src/live-workflow/chatgpt-execution-leases.js';
import { createChatGPTRefresh } from '../../src/live-workflow/chatgpt-refresh.js';
const module=new URL('../../src/live-workflow/chatgpt-plan.js',import.meta.url).href;
function worker(directory:string,crash=false){
  const script=`const {openChatGPTPlanSession}=await import(process.argv[1]);
  const session=await openChatGPTPlanSession(process.argv[2],{isTTY:true,confirm:async()=>{throw Error('prompt')}});
  const lease=session.admitExecution({runBinding:'a'.repeat(64),deadline:Date.now()+20000,signal:new AbortController().signal,check:()=>{}});
  console.log('ready');${crash?'process.exit(0);':`const timer=setInterval(()=>lease.assertActive(),100);process.stdin.once('data',()=>{clearInterval(timer);lease.assertActive();lease.settle('failed',null);console.log('settled');process.stdin.destroy();});`}`;
  const child=spawn(process.execPath,['--input-type=module','-e',script,module,directory],{stdio:['pipe','pipe','pipe']});
  const close=new Promise<void>((resolve,reject)=>{child.once('close',code=>code===0?resolve():reject(new Error('Fixture subprocess failed')));});
  void close.catch(()=>undefined);
  const ready=new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Fixture admission timeout')),5000);child.stdout.once('data',data=>{clearTimeout(timer);assert.match(String(data),/ready/);resolve();});child.once('error',reject);});
  return {child,ready,close};
}
const good=()=>Response.json({access_token:'synthetic-next-access',refresh_token:'synthetic-next-refresh',token_type:'Bearer',scope:'chatgpt.tokens.use.direct',expires_in:3600});
test('two real processes share generation; renewal defers without credential lock or POST until both release',async()=>{
  const f=executionFixture(),a=worker(f.directory),b=worker(f.directory);let posts=0;
  const ensure=createChatGPTRefresh({projectRoot:process.cwd(),transport:async()=>{posts++;return good();}});
  const original=readFileSync(join(f.directory,'chatgpt-connection.json'),'utf8');
  try{
    await Promise.all([a.ready,b.ready]);
    await assert.rejects(ensure(f.directory,{minimumLifetimeMs:900000}),ChatGPTRefreshDeferred);
    assert.equal(posts,0);assert.equal(existsSync(join(f.directory,'chatgpt.lock')),false);assert.equal(existsSync(join(f.directory,'chatgpt-refresh-pending.json')),false);
    assert.equal(readFileSync(join(f.directory,'chatgpt-connection.json'),'utf8'),original);
    a.child.stdin.end('stop');await a.close;
    await assert.rejects(ensure(f.directory,{minimumLifetimeMs:900000}),ChatGPTRefreshDeferred);assert.equal(posts,0);
    b.child.stdin.end('stop');await b.close;
    await ensure(f.directory,{minimumLifetimeMs:900000});assert.equal(posts,1);
    await ensure(f.directory,{minimumLifetimeMs:900000});assert.equal(posts,1);
  }finally{a.child.kill();b.child.kill();f.close();}
});
test('refresh intent fences admission; crashed lease blocks rotation without deadline stealing',async()=>{
  const f=executionFixture(),session=await f.open(),ledger=new ChatGPTExecutionLedger(f.directory);
  try{
    const intent=ledger.beginRefresh('a'.repeat(64),()=>{});
    assert.throws(()=>session.admitExecution({runBinding:'b'.repeat(64),deadline:Date.now()+1000,signal:new AbortController().signal,check:()=>{}}),ChatGPTRefreshDeferred);
    ledger.finishRefresh(intent);
    const crashed=worker(f.directory,true);await crashed.ready;await crashed.close;
    assert.throws(()=>ledger.beginRefresh('a'.repeat(64),()=>{}),ChatGPTRefreshDeferred);
  }finally{ledger.close();f.close();}
});
test('cancellation, expiry, explicit renewal and review reset deny leases; prelaunch failure can settle once',async()=>{
  for(const reason of ['cancel','expiry','renewal','review']){
    const f=executionFixture(),session=await f.open(),controller=new AbortController();
    const lease=session.admitExecution({runBinding:'b'.repeat(64),deadline:Date.now()+(reason==='expiry'?20:10000),signal:controller.signal,check:()=>{}});
    try{
      if(reason==='cancel')controller.abort();
      else if(reason==='expiry')await new Promise(r=>setTimeout(r,30));
      else{const store=new ChatGPTStore(f.directory);try{store.lock();if(reason==='review')store.forgetBillingReview();else store.save({...store.connection()!,accessToken:'synthetic-reconnected'});}finally{store.close();}}
      assert.throws(()=>lease.assertActive());assert.throws(()=>lease.settle('completed',null),/prelaunch/);lease.settle('failed',null);assert.throws(()=>lease.settle('failed',null),/replay/);
    }finally{f.close();}
  }
  assert.throws(()=>ChatGPTExecutionLease.prototype.settle.call({} as ChatGPTExecutionLease,'failed',null),/replay/);
});
test('launched lease rejects forged cleanup and remains blocking after uncertain cleanup',async()=>{
  const f=executionFixture(),session=await f.open();const lease=session.admitExecution({runBinding:'b'.repeat(64),deadline:Date.now()+10000,signal:new AbortController().signal,check:()=>{}});
  try{lease.beginLaunch('c'.repeat(64));assert.throws(()=>lease.settle('failed',{runtimeBinding:'c'.repeat(64),receiptId:'fake',executionLeaseId:lease.receipt().id}),/Invalid/);lease.retainIndeterminate();const ledger=new ChatGPTExecutionLedger(f.directory);try{assert.throws(()=>ledger.beginRefresh('a'.repeat(64),()=>{}),ChatGPTRefreshDeferred);}finally{ledger.close();}}
  finally{f.close();}
});
test('ledger replacement invalidates an existing handle instead of releasing another ledger',async()=>{
  const f=executionFixture(),session=await f.open();const lease=session.admitExecution({runBinding:'b'.repeat(64),deadline:Date.now()+10000,signal:new AbortController().signal,check:()=>{}});
  try{const path=join(f.directory,'chatgpt-execution.sqlite');renameSync(path,path+'.old');writeFileSync(path,readFileSync(path+'.old'),{mode:0o600});assert.throws(()=>lease.assertActive(),/replaced/);assert.throws(()=>lease.settle('failed',null),/replaced/);assert.throws(()=>lease.retainIndeterminate(),/replaced/);}
  finally{f.close();}
});


test('a recognized handle cannot be mixed with another account, run or extended deadline',async()=>{
  const a=executionFixture(),b=executionFixture(),first=await a.open(),second=await b.open();
  const deadline=Date.now()+10000,lease=first.admitExecution({runBinding:'a'.repeat(64),deadline,signal:new AbortController().signal,check:()=>{}});
  try{
    first.assertExecution(lease,'a'.repeat(64),deadline);
    assert.throws(()=>second.assertExecution(lease,'a'.repeat(64),deadline),/mismatch/);
    assert.throws(()=>first.assertExecution(lease,'b'.repeat(64),deadline),/mismatch/);
    assert.throws(()=>first.assertExecution(lease,'a'.repeat(64),deadline+1),/mismatch/);
    lease.settle('failed',null);
  }finally{a.close();b.close();}
});


test('execution admission permits a bounded deadline below credential expiry and rejects equality',async()=>{
  const f=executionFixture(1000000),session=await f.open(),expiry=session.binding().expiresAt;
  try{
    assert.throws(()=>session.admitExecution({runBinding:'a'.repeat(64),deadline:expiry,signal:new AbortController().signal,check:()=>{}}),/lifetime/);
    const lease=session.admitExecution({runBinding:'a'.repeat(64),deadline:expiry-1,signal:new AbortController().signal,check:()=>{}});lease.settle('failed',null);
  }finally{f.close();}
});


test('durable binding tampering cannot release a lease and remains refresh-blocking',async()=>{
  const f=executionFixture(),session=await f.open(),lease=session.admitExecution({runBinding:'a'.repeat(64),deadline:Date.now()+10000,signal:new AbortController().signal,check:()=>{}});
  try{
    const db=new DatabaseSync(join(f.directory,'chatgpt-execution.sqlite'));db.prepare('UPDATE leases SET run=? WHERE id=?').run('b'.repeat(64),lease.receipt().id);db.close();
    assert.throws(()=>lease.settle('failed',null),/binding changed/);lease.retainIndeterminate();
    const ledger=new ChatGPTExecutionLedger(f.directory);try{assert.throws(()=>ledger.beginRefresh('a'.repeat(64),()=>{}),ChatGPTRefreshDeferred);}finally{ledger.close();}
  }finally{f.close();}
});


test('conditional pending cleanup never deletes a marker created after observing captured absence',()=>{
  const f=executionFixture(),store=new ChatGPTStore(f.directory);
  try{
    store.lock();const connection=store.connection()!,snapshot=store.pendingRefreshSnapshot.bind(store);
    store.pendingRefreshSnapshot=()=>{const value=snapshot();if(value===null)store.beginRefresh(connection);return value;};
    store.finishRefresh(null);assert.equal(existsSync(join(f.directory,'chatgpt-refresh-pending.json')),true);
    store.pendingRefreshSnapshot=snapshot;
  }finally{store.close();f.close();}
});
