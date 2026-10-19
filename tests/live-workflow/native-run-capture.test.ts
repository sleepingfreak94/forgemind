import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, existsSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { decodeNativeCapture } from '../../src/live-workflow/native-capture-codec.js';
import { beginNativeRunCapture, captureJson, NativeCaptureError } from '../../src/live-workflow/native-run-capture.js';
import { projectFixture } from './native-executor-project.test.js';
import { readOwnerArtifactBundle } from '../../src/live-workflow/owner-artifact-io.js';
import { sha256 } from '../../src/live-workflow/validation.js';
import { executionFixture } from './chatgpt-execution-fixture.js';
import { runNativeTask, nativeRunErrorDetails } from '../../src/live-workflow/native-executor-run.js';
const native={skip:process.platform!=='darwin'};
test('capture selects receipt data without executing getters/proxies or toJSON',()=>{
 let traps=0;const getter=Object.defineProperty({},'secret',{enumerable:true,get(){traps++;return 'SECRET';}});
 const proxy=new Proxy({}, {ownKeys(){traps++;return [];}});
 for(const value of [getter,proxy,{toJSON(){traps++;return 'SECRET';}}])assert.throws(()=>captureJson(value),NativeCaptureError);
 const revoked=Proxy.revocable({},{});revoked.revoke();assert.throws(()=>captureJson(revoked.proxy),NativeCaptureError);
 assert.equal(traps,0);assert.equal(JSON.stringify(captureJson({present:1,optional:undefined})),'{"present":1}');
});
test('capture exists before execution and accepted bundle retains the complete selected result',native,()=>{
 const f=projectFixture(),run=join(f.dir,'capture-run');mkdirSync(run,{mode:0o700});
 try{
  const capture=beginNativeRunCapture(f.task,run,'a'.repeat(64),10000);
  assert(existsSync(join(capture.directory,'start.json')));
  const envelope={status:'completed',source:f.task.source,checks:[{id:'test',passed:true}],native:{message:'complete evidence'}};
  capture.finish(envelope);capture.close();
  const id=capture.directory.split('/').at(-1)!;
  const bundle=readOwnerArtifactBundle({root:join(run,'capture'),project:f.root,scope:{taskId:'capture-'+sha256(f.task.task).slice(0,32),sourceSha256:f.task.source,requestSha256:'a'.repeat(64)}},id);
  assert.deepEqual(JSON.parse(bundle.files.get('terminal.json')!.toString()),envelope);
  assert.equal(bundle.manifest.trust,'evidence-only');
 }finally{f.close();}
});
test('failed capture retains explicit terminal failure and private Markdown resume point',native,()=>{
 const f=projectFixture(),run=join(f.dir,'failed-run');mkdirSync(run,{mode:0o700});
 try{
  const capture=beginNativeRunCapture(f.task,run,'b'.repeat(64),10000);
  capture.finish({status:'stopped',phase:'native-turn',code:'native-provider-error'},{phase:'native-turn',code:'native-provider-error'});capture.close();
  const files=readdirSync(join(run,'failures'));assert.equal(files.length,1);
  const md=readFileSync(join(run,'failures',files[0]!),'utf8');assert(md.includes('native-provider-error'));assert(md.includes(f.task.source));
  assert.throws(()=>capture.finish({}),NativeCaptureError);
 }finally{f.close();}
});
test('capture overflow rejects acceptance and keeps incomplete evidence without overwriting earlier attempts',native,()=>{
 const f=projectFixture(),run=join(f.dir,'overflow-run');mkdirSync(run,{mode:0o700});
 try{
  const capture=beginNativeRunCapture(f.task,run,'c'.repeat(64),10000);
  assert.throws(()=>capture.finish({body:'x'.repeat(16*1024*1024)}),NativeCaptureError);capture.close();
  assert(!existsSync(join(capture.directory,'accepted.json')));assert(existsSync(join(capture.directory,'failure.json')));
  const next=beginNativeRunCapture(f.task,run,'c'.repeat(64),10000);assert.notEqual(next.directory,capture.directory);next.close();
 }finally{f.close();}
});

test('oversized or refused failure terminal still retains primary phase/code in one Markdown resume record',native,()=>{
 for(const envelope of [{body:'x'.repeat(16*1024*1024)},Object.defineProperty({},'body',{enumerable:true,get(){throw new Error('must not execute');}})]){
  const f=projectFixture(),run=join(f.dir,'fallback-run');mkdirSync(run,{mode:0o700});
  try{
   const capture=beginNativeRunCapture(f.task,run,'d'.repeat(64),10000);
   assert.throws(()=>capture.finish(envelope,{phase:'native-turn',code:'native-provider-error'}),NativeCaptureError);
   const files=readdirSync(join(run,'failures'));assert.equal(files.length,1);
   const path=join(run,'failures',files[0]!),before=readFileSync(path,'utf8');
   assert.match(before,/Phase: native-turn/);assert.match(before,/Code: native-provider-error/);
   assert.match(before,/capture may be incomplete/);assert(before.includes(f.task.source));
   assert(!existsSync(join(capture.directory,'accepted.json')));
   assert.throws(()=>capture.finish({status:'stopped'},{phase:'capture',code:'changed'}),NativeCaptureError);
   capture.close();assert.equal(readFileSync(path,'utf8'),before);assert.equal(readdirSync(join(run,'failures')).length,1);
  }finally{f.close();}
 }
});

test('callable runner preserves primary failure and Markdown when terminal publication is unavailable',native,async()=>{
 const f=projectFixture(),account=executionFixture(),run=join(f.dir,'callable-capture');mkdirSync(run,{mode:0o700});
 try{
  const session=await account.open(),codex=join(f.dir,'version-only-codex');
  writeFileSync(codex,'#!'+realpathSync(process.execPath)+'\nconsole.log("codex-cli 0.162.1");\n',{mode:0o700});
  session.prepare=async()=>{
   const attempt=readdirSync(join(run,'capture'))[0]!;
   assert(existsSync(join(run,'capture',attempt,'start.json')));
   writeFileSync(join(run,'capture',attempt,'terminal.json'),'existing fixture',{flag:'wx',mode:0o600});
   throw new Error('Fixture account failure');
  };
  await assert.rejects(runNativeTask({task:f.task,objective:'review',runDirectory:run,codexExecutable:codex,session,
   parent:{binding:'e'.repeat(64),check:()=>{}},signal:new AbortController().signal}),error=>{
    const facts=nativeRunErrorDetails(error);assert.equal(facts?.phase,'authentication');assert.equal(facts?.code,'account-or-authority');
    assert.equal((facts?.receipts as {capture:{status:string}}).capture.status,'incomplete');return true;
   });
  const files=readdirSync(join(run,'failures'));assert.equal(files.length,1);
  const md=readFileSync(join(run,'failures',files[0]!),'utf8');assert.match(md,/Phase: authentication/);assert.match(md,/Code: account-or-authority/);
 }finally{account.close();f.close();}
});


test('large selected check logs recover losslessly with unchanged result fields and one terminal settlement',native,()=>{
 const f=projectFixture(),run=join(f.dir,'chunked-run');mkdirSync(run,{mode:0o700});
 try{
  const capture=beginNativeRunCapture(f.task,run,'f'.repeat(64),10000);
  const envelope={status:'completed',checks:[{stdout:'é'.repeat(600000),stderr:'界'.repeat(400000)}],native:{result:'selected'}};
  const original=Buffer.from(JSON.stringify(envelope));capture.finish(envelope);capture.close();
  const options={root:join(run,'capture'),project:f.root,scope:{taskId:'capture-'+sha256(f.task.task).slice(0,32),sourceSha256:f.task.source,requestSha256:'f'.repeat(64)}};
  const id=capture.directory.split('/').at(-1)!,bundle=readOwnerArtifactBundle(options,id);
  assert.deepEqual(decodeNativeCapture(bundle),original);assert.deepEqual(JSON.parse(decodeNativeCapture(bundle).toString()),envelope);
  const manifest=readFileSync(join(capture.directory,'accepted.json'),'utf8');
  assert.throws(()=>capture.finish({status:'stopped'}),NativeCaptureError);capture.close();
  assert.equal(readFileSync(join(capture.directory,'accepted.json'),'utf8'),manifest);
  assert(!existsSync(join(run,'failures')));
 }finally{f.close();}
});

test('large failure logs retain one accepted terminal and one primary Markdown note without resettlement',native,()=>{
 const f=projectFixture(),run=join(f.dir,'chunked-failure');mkdirSync(run,{mode:0o700});
 try{
  const capture=beginNativeRunCapture(f.task,run,'a'.repeat(64),10000);
  const envelope={status:'stopped',phase:'checks',code:'check-failed',checks:[{stdout:'界'.repeat(800000),stderr:'é'.repeat(100)}]};
  capture.finish(envelope,{phase:'checks',code:'check-failed'});
  const files=readdirSync(join(run,'failures'));assert.equal(files.length,1);
  const path=join(run,'failures',files[0]!),note=readFileSync(path,'utf8');assert.match(note,/Phase: checks/);assert.match(note,/Code: check-failed/);
  const options={root:join(run,'capture'),project:f.root,scope:{taskId:'capture-'+sha256(f.task.task).slice(0,32),sourceSha256:f.task.source,requestSha256:'a'.repeat(64)}};
  assert.deepEqual(decodeNativeCapture(readOwnerArtifactBundle(options,capture.directory.split('/').at(-1)!)),Buffer.from(JSON.stringify(envelope)));
  assert.throws(()=>capture.finish(envelope,{phase:'capture',code:'changed'}),NativeCaptureError);capture.close();
  assert.equal(readdirSync(join(run,'failures')).length,1);assert.equal(readFileSync(path,'utf8'),note);
 }finally{f.close();}
});
