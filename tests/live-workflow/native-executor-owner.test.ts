import test from 'node:test';
import assert from 'node:assert/strict';
import { projectFixture } from './native-executor-project.test.js';
import { NativeState } from '../../src/live-workflow/native-executor-state.js';
import { join } from 'node:path';

test('owner rejects path/check expansion and checks live parent authority for outstanding actions',()=>{
  const f=projectFixture();
  try{
    assert.throws(()=>f.owner.reserve({kind:'files.apply',source:f.task.source,detail:{edits:[{path:'other.txt'}]}}),/exact grant/);
    assert.throws(()=>f.owner.reserve({kind:'command',source:f.task.source,detail:{command:{...f.task.checks[0],args:['arbitrary']}}}),/Changed/);
    const receipt=f.owner.reserve({kind:'artifact',source:f.task.source,detail:{operation:'native.read',path:'value.txt'}});
    receipt.check();receipt.finish('completed');assert.throws(()=>receipt.check(),/Finished/);
  }finally{f.close();}
});
test('uncapped counters persist without resetting and bounded retries remain denied by zero allowance',()=>{
  const f=projectFixture();
  try{
    f.state.charge('turns',1000);f.state.charge('toolCalls',1000);
    assert.throws(()=>f.state.charge('retries',1),/exhausted/);
    f.state.close();
    const next=new NativeState(join(f.dir,'state'),f.task);
    assert.equal(next.value.counters.turns,1000);assert.equal(next.value.counters.toolCalls,1000);next.close();
  }finally{f.close();}
});
