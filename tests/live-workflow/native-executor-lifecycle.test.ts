import { createProductionNativeHost } from '../../src/live-workflow/native-executor-host.js';
import { ChatGPTPlanSession } from '../../src/live-workflow/chatgpt-plan.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { projectFixture } from './native-executor-project.test.js';
import { NativeLifecycle } from '../../src/live-workflow/native-executor-lifecycle.js';
import type { NativeLaunchPlan } from '../../src/live-workflow/native-executor-launch-contracts.js';
import { sha256 } from '../../src/live-workflow/validation.js';
import { nativeTool } from '../../src/live-workflow/native-executor-tools.js';

function binding(lifecycle:NativeLifecycle,task:ReturnType<typeof projectFixture>['task']):NativeLaunchPlan{
  // A fake manifest exercises policy only. It cannot pass transport's prepared
  // plan registry or launch a native process.
  return {domain:'native-runtime-v1',runtimeBinding:'b'.repeat(64),taskId:task.task,grantId:lifecycle.grantId,leaseId:lifecycle.leaseId,fencingEpoch:lifecycle.fencingEpoch,model:task.model,effort:task.effort,grantDigest:lifecycle.grantDigest,authorityBinding:lifecycle.authorityBinding,budgetBinding:lifecycle.budgetBinding,deadlineEpochMs:lifecycle.deadline} as NativeLaunchPlan;
}
test('runtime-only receipt survives validated S0 to S1 while new lifecycle epoch fences previous process',async()=>{
  const f=projectFixture(),directory=join(f.dir,'lifecycle'),deadline=Date.now()+10000;
  const lifecycle=new NativeLifecycle(directory,f.task,deadline,()=>f.owner.active(),'a'.repeat(64));
  let next:NativeLifecycle|undefined;
  try{
    const receipt=lifecycle.reserve(binding(lifecycle,f.task));receipt.checkActive();
    await nativeTool(f.task,f.state,f.host,'host_apply',{summary:'repair',edits:[{path:'value.txt',beforeSha256:sha256('before'),content:'after'}]},new AbortController().signal);
    receipt.checkActive();assert.notEqual(f.state.value.source,f.task.source);
    next=new NativeLifecycle(directory,{...f.task,source:f.state.value.source},deadline,()=>f.owner.active(),'a'.repeat(64));
    assert.throws(()=>receipt.checkActive(),/Stale|Inactive/);
    assert.throws(()=>receipt.finish('failed'),/inactive-reservation/);
    assert.equal(lifecycle.export().runtimes[0]!.status,'indeterminate');
  }finally{next?.close();lifecycle.close();f.close();}
});
test('runtime plan cannot change approved effort, permission binding or budget',()=>{
  const f=projectFixture(),lifecycle=new NativeLifecycle(join(f.dir,'lifecycle'),f.task,Date.now()+10000,()=>f.owner.active(),'a'.repeat(64));
  try{
    const plan=binding(lifecycle,f.task);
    for(const changed of [{...plan,effort:'high'},{...plan,budgetBinding:'c'.repeat(64)},{...plan,authorityBinding:'d'.repeat(64)}])assert.throws(()=>lifecycle.reserve(changed as NativeLaunchPlan),/differs from authority/);
  }finally{lifecycle.close();f.close();}
});

test('completion requires the exact completed terminal policy receipt and fresh authority',()=>{
  const f=projectFixture();let revoked=false;
  const lifecycle=new NativeLifecycle(join(f.dir,'settlement'),f.task,Date.now()+10000,()=>{if(revoked)throw new Error('Revoked at return');},'a'.repeat(64));
  try{
    const receipt=lifecycle.reserve(binding(lifecycle,f.task));
    receipt.finish('completed');lifecycle.assertCompleted(receipt);
    assert.throws(()=>lifecycle.assertCompleted({...receipt,receiptId:'another-receipt'}),/not completed/);
    revoked=true;assert.throws(()=>lifecycle.assertCompleted(receipt),/Revoked at return/);
  }finally{lifecycle.close();f.close();}
});
test('authority invalidation during completed settlement records failed rather than orphan running',()=>{
  const f=projectFixture();let revoked=false;
  const lifecycle=new NativeLifecycle(join(f.dir,'settlement'),f.task,Date.now()+10000,()=>{if(revoked)throw new Error('Revoked during cleanup');},'a'.repeat(64));
  try{
    const receipt=lifecycle.reserve(binding(lifecycle,f.task));revoked=true;
    receipt.finish('completed');
    assert.equal(lifecycle.export().runtimes[0]!.status,'failed');
    assert.equal(lifecycle.export().receipts.filter(record=>record.event==='external.finished')[0]!.outcome,'failed');
    assert.throws(()=>lifecycle.assertCompleted(receipt),/Revoked/);
  }finally{lifecycle.close();f.close();}
});

test('factory account precheck rejection terminalizes an already reserved runtime exactly once',async()=>{
  const f=projectFixture(),lifecycle=new NativeLifecycle(join(f.dir,'factory'),f.task,Date.now()+10000,()=>f.owner.active(),'a'.repeat(64));
  try{
    const plan=binding(lifecycle,f.task),receipt=lifecycle.reserve(plan);
    await assert.rejects(createProductionNativeHost({plan,lifecycle:receipt,session:new ChatGPTPlanSession(),authority:f.owner,project:f.project,boundary:()=>f.owner.active(),check:async()=>({passed:true}),signal:new AbortController().signal}),/Unrecognized/);
    assert.equal(lifecycle.export().runtimes[0]!.status,'failed');
    const terminals=lifecycle.export().receipts.filter(record=>record.event==='external.finished');
    assert.equal(terminals.length,1);assert.equal(terminals[0]!.outcome,'failed');
    assert.throws(()=>lifecycle.assertCompleted(receipt),/not completed/);
  }finally{lifecycle.close();f.close();}
});
