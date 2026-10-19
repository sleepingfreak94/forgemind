import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeProject } from '../../src/live-workflow/native-executor-project.js';
import { NativeOwner } from '../../src/live-workflow/native-executor-owner.js';
import { NativeState } from '../../src/live-workflow/native-executor-state.js';
import { FixtureNativeHost, fixtureStdioRpc } from '../../src/live-workflow/native-executor-host.js';
import { nativeTool } from '../../src/live-workflow/native-executor-tools.js';
import { PassThrough } from 'node:stream';
import { sourceIdentity } from '../../src/live-workflow/repository.js';
import { sha256 } from '../../src/live-workflow/validation.js';
import type { NativeTask } from '../../src/live-workflow/native-executor-contracts.js';

// Functional fixtures include real Git/SQLite work under parallel suite load.
// This test-only allowance does not alter production budgets; expiry is tested below.
export function projectFixture(runtimeMs = 30000) {
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'fm-project-native-'))),root=join(dir,'repo');mkdirSync(root);
  execFileSync('/usr/bin/git',['init','-q',root]);writeFileSync(join(root,'value.txt'),'before');
  const task:NativeTask={project:'fixture',task:'change',root,source:sourceIdentity(root),model:'gpt-6.1-sol',effort:'medium',readPaths:['value.txt'],writePaths:['value.txt'],checks:[{id:'check',executable:realpathSync(process.execPath),args:[],timeoutMs:1000}],budget:{runtimeMs,turns:null,toolCalls:null,retries:0,inputBytes:100000,resultBytes:100000,wireBytes:100000,outputBytes:10000}};
  const owner=new NativeOwner(join(dir,'owner'),task,Date.now()+runtimeMs,()=>undefined);
  const project=new NativeProject(root,owner,(...args)=>owner.phase(...args),()=>owner.active());
  const state=new NativeState(join(dir,'state'),task);
  const host=new FixtureNativeHost(fixtureStdioRpc(new PassThrough(),new PassThrough()),owner,()=>owner.active(),async()=>undefined,()=>project.source(),async()=>({passed:readFileSync(join(root,'value.txt'),'utf8')==='after'}),project);
  return {dir,root,task,owner,project,state,host,close:()=>{host.rpc.close();state.close();owner.close();rmSync(dir,{recursive:true,force:true});}};
}

test('authorized source transition advances owner and state; S1 check succeeds while S0 reservations fail',async()=>{
  const f=projectFixture(),s0=f.task.source;
  try{
    await nativeTool(f.task,f.state,f.host,'host_apply',{summary:'repair',edits:[{path:'value.txt',beforeSha256:sha256('before'),content:'after'}]},new AbortController().signal);
    assert.notEqual(f.state.value.source,s0);assert.equal(f.state.value.source,f.owner.source);
    assert.equal(f.owner.export().phases.length,1);
    const result=JSON.parse(await nativeTool(f.task,f.state,f.host,'host_check',{id:'check'},new AbortController().signal));
    assert.equal(result.passed,true);f.host.boundary();
    assert.throws(()=>f.owner.reserve({kind:'artifact',source:s0,detail:{operation:'native.read',path:'value.txt'}}),/Stale/);
  }finally{f.close();}
});
test('unrelated drift after an authorized edit cannot be advanced into the source ledger',async()=>{
  const f=projectFixture(),original=f.project.commitAppliedSource.bind(f.project);
  f.project.commitAppliedSource=(before,result)=>{writeFileSync(join(f.root,'unexpected.txt'),'drift');return original(before,result);};
  try{
    await assert.rejects(nativeTool(f.task,f.state,f.host,'host_apply',{summary:'repair',edits:[{path:'value.txt',beforeSha256:sha256('before'),content:'after'}]},new AbortController().signal),/Unrelated source drift/);
    assert.equal(f.owner.source,f.task.source);assert.equal(f.state.value.pending,'files.apply');
  }finally{f.close();}
});
test('durable owner phase followed by failed NativeState update leaves mutation pending and cannot resume',async()=>{
  const f=projectFixture(),update=f.state.update.bind(f.state);
  f.state.update=patch=>{if(patch.source)throw new Error('checkpoint fault');update(patch);};
  try{
    await assert.rejects(nativeTool(f.task,f.state,f.host,'host_apply',{summary:'repair',edits:[{path:'value.txt',beforeSha256:sha256('before'),content:'after'}]},new AbortController().signal),/checkpoint fault/);
    assert.notEqual(f.owner.source,f.task.source);assert.equal(f.state.value.pending,'files.apply');
    assert.throws(()=>new NativeState(join(f.dir,'state'),f.task),/reconciliation/);
  }finally{f.close();}
});

test('native owner expires at the exact requested deadline before admitting any action',t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const f=projectFixture(1000);
  try{
    const before=f.owner.export().receipts.length;
    t.mock.timers.tick(999);f.owner.active();
    t.mock.timers.tick(1);
    assert.throws(()=>f.owner.active(),/Native owner expired or closed/);
    assert.throws(()=>f.owner.reserve({kind:'artifact',source:f.task.source,detail:{operation:'native.read',path:'value.txt'}}),/Native owner expired or closed/);
    assert.equal(f.owner.export().receipts.length,before);
  }finally{f.close();}
});
