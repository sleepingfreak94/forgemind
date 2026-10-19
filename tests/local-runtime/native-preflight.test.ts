import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sourceIdentity } from '../../src/live-workflow/repository.js';
import { sha256 } from '../../src/live-workflow/validation.js';
import type { NativeTask } from '../../src/live-workflow/native-executor-contracts.js';
import { validateNativeTask, nativePacketBinding } from '../../src/live-workflow/native-task-validation.js';
import { encodeNativePacket, loadNativePacket, NativePacketError, NATIVE_PACKET_MAX_BYTES } from '../../src/live-workflow/native-packet.js';
import { preflightNativeTask } from '../../src/live-workflow/native-preflight.js';
import { verifyNativeLaunchPlan } from '../../src/live-workflow/native-executor-launch-contracts.js';

const posix=process.platform!=='win32'&&typeof process.getuid==='function';
function setup() {
  const directory=mkdtempSync(join(realpathSync(tmpdir()),'native-preflight-'));
  const root=join(directory,'repo');
  mkdirSync(root,{mode:0o700});
  const git=spawnSync('git',['init','--quiet',root],{encoding:'utf8'});
  assert.equal(git.status,0,git.stderr);
  writeFileSync(join(root,'file.txt'),'before');
  const task: NativeTask={project:'fixture',task:'input-check',root,source:sourceIdentity(root),
    model:'gpt-6.1-sol',effort:'medium',readPaths:['file.txt'],writePaths:['file.txt'],
    checks:[{id:'unit',executable:realpathSync(process.execPath),args:['--version'],timeoutMs:30000}],
    budget:{runtimeMs:30000,turns:null,toolCalls:null,retries:0,inputBytes:1048576,
      resultBytes:1048576,wireBytes:33554432,outputBytes:1048576}};
  return {directory,task,clean:()=>rmSync(directory,{recursive:true,force:true})};
}
function reason(code:string) {
  return (error:unknown)=>error instanceof NativePacketError&&error.code===code&&error.reason===code;
}
function executable(directory:string,output='codex-cli 0.162.1') {
  const path=join(directory,'codex-fixture');
  writeFileSync(path,'#!'+realpathSync(process.execPath)+'\n'+
    'if(process.argv.slice(2).join()!=="--version")process.exit(3);\n'+
    'if(Object.keys(process.env).some(k=>/TOKEN|SECRET|AUTH|SENTINEL/.test(k)))process.exit(4);\n'+
    'if(process.env.HOME!=="/dev/null"||process.env.CODEX_HOME!=="/dev/null")process.exit(5);\n'+
    'console.log('+JSON.stringify(output)+');\n',{mode:0o700});
  return path;
}

test('packet encoder counts actual pretty JSON UTF8 bytes and final newline at 65536/65537',()=>{
  const f=setup();
  try {
    for(const seed of ['a','é界🙂']){
      const base=encodeNativePacket(f.task,seed);
      const objective=seed+'x'.repeat(NATIVE_PACKET_MAX_BYTES-Buffer.byteLength(base));
      const exact=encodeNativePacket(f.task,objective);
      assert.equal(Buffer.byteLength(exact),65536);assert.ok(exact.endsWith('\n'));
      assert.equal(JSON.parse(exact).objective,objective);
      assert.throws(()=>encodeNativePacket(f.task,objective+'x'),reason('packet-too-large'));
    }
  } finally {f.clean();}
});
test('packet loader accepts 65536 valid JSON bytes and classifies 65537 and old 230689 before parsing',{skip:!posix},()=>{
  const f=setup();
  try {
    const path=join(f.directory,'packet.json'),state=join(f.directory,'absent-state');
    const base=encodeNativePacket(f.task,'é');
    const exact=encodeNativePacket(f.task,'é'+'x'.repeat(65536-Buffer.byteLength(base)));
    writeFileSync(path,exact,{mode:0o600});
    const loaded=loadNativePacket(path,state);
    assert.equal(loaded.fileDigest,sha256(exact));
    assert.equal(loaded.parentBinding,nativePacketBinding(loaded.packet));assert.equal(loaded.path,path);
    const larger=JSON.stringify({...loaded.packet,objective:loaded.packet.objective+'x'},null,2)+'\n';
    assert.equal(Buffer.byteLength(larger),65537);JSON.parse(larger);
    writeFileSync(path,larger);
    assert.throws(()=>loadNativePacket(path,state),reason('packet-too-large'));
    writeFileSync(path,Buffer.alloc(230689,33)); // Deliberately invalid JSON: size must win.
    assert.throws(()=>loadNativePacket(path,state),reason('packet-too-large'));
    assert.equal(existsSync(state),false);
  } finally {f.clean();}
});
test('packet privacy, canonical paths, hardlinks, project location, invalid JSON and safe messages',{skip:!posix},()=>{
  const f=setup();
  try {
    const path=join(f.directory,'packet.json'),state=join(f.directory,'state'),raw=encodeNativePacket(f.task,'check');
    writeFileSync(path,raw,{mode:0o600});
    chmodSync(path,0o644);assert.throws(()=>loadNativePacket(path,state),reason('packet-private'));chmodSync(path,0o600);
    chmodSync(f.directory,0o755);assert.throws(()=>loadNativePacket(path,state),reason('packet-private'));chmodSync(f.directory,0o700);
    const linked=join(f.directory,'linked');linkSync(path,linked);
    assert.throws(()=>loadNativePacket(path,state),reason('packet-private'));rmSync(linked);
    symlinkSync(path,linked);assert.throws(()=>loadNativePacket(linked,state),reason('packet-private'));rmSync(linked);
    const inside=join(f.task.root,'packet.json');writeFileSync(inside,raw,{mode:0o600});
    assert.throws(()=>loadNativePacket(inside,state),reason('packet-in-project'));
    writeFileSync(path,'{"private-secret-value"');
    assert.throws(()=>loadNativePacket(path,state),(error:unknown)=>{
      assert.ok(reason('packet-invalid')(error));assert.doesNotMatch(String(error),/private-secret-value/);return true;
    });
    writeFileSync(path,JSON.stringify({schema:'native-owner-packet-v1',task:{},objective:'x'}));
    assert.throws(()=>loadNativePacket(path,state),reason('packet-task-invalid'));
  } finally {f.clean();}
});
test('packet checkpoint source override preserves initial binding and original file digest',{skip:!posix},()=>{
  const f=setup();
  try {
    const path=join(f.directory,'packet.json'),state=join(f.directory,'state'),checkpoint=join(state,'checkpoint');
    const raw=encodeNativePacket(f.task,'check'),original=JSON.parse(raw);
    writeFileSync(path,raw,{mode:0o600});mkdirSync(checkpoint,{recursive:true,mode:0o700});
    const dbPath=join(checkpoint,'native.sqlite'),db=new DatabaseSync(dbPath);
    db.exec('CREATE TABLE checkpoint(id INTEGER PRIMARY KEY,value TEXT)');
    db.prepare('INSERT INTO checkpoint VALUES(1,?)').run(JSON.stringify({source:'a'.repeat(64)}));db.close();chmodSync(dbPath,0o600);
    const loaded=loadNativePacket(path,state);
    assert.equal(loaded.packet.task.source,'a'.repeat(64));assert.equal(f.task.source,original.task.source);
    assert.equal(loaded.parentBinding,nativePacketBinding(original));assert.equal(loaded.fileDigest,sha256(raw));
    chmodSync(dbPath,0o644);assert.throws(()=>loadNativePacket(path,state),reason('checkpoint-private'));
  } finally {f.clean();}
});
test('shared validation preserves strict 30sec checks, model/effort, 32MiB wire and retry enum',()=>{
  const f=setup();
  try {
    validateNativeTask(f.task);
    for(const retries of [0,1,2])validateNativeTask({...f.task,budget:{...f.task.budget,retries:retries as 0|1|2}});
    for(const change of [
      {...f.task,model:'other'}, {...f.task,effort:'xhigh'},
      {...f.task,checks:[{...f.task.checks[0]!,timeoutMs:30001}]},
      {...f.task,budget:{...f.task.budget,wireBytes:33554433}},
      {...f.task,budget:{...f.task.budget,retries:3}},
      {...f.task,readPaths:['../escape']},
    ])assert.throws(()=>validateNativeTask(change as NativeTask));
  } finally {f.clean();}
});
test('preflight is immutable, offline, leaves missing private run leaf absent and grants no execution',{skip:!posix},async()=>{
  const f=setup();
  try {
    const codexExecutable=executable(f.directory),runDirectory=join(f.directory,'not-created');
    const options={task:f.task,objective:'validate',codexExecutable,runDirectory};
    const report=await preflightNativeTask(options);
    assert.equal(report.schema,'native-preflight-v1');assert.equal(report.ready,true);assert.equal(report.source,f.task.source);
    assert.deepEqual(report.issues,[]);assert.ok(report.checks.every(c=>c.status==='passed'));
    for(const value of [report,report.checks,report.issues,...report.checks])assert.ok(Object.isFrozen(value));
    assert.equal(existsSync(runDirectory),false);
    assert.throws(()=>verifyNativeLaunchPlan(report as never),/Owner-prepared native launch plan required/);
    assert.equal('grantId' in report,false);assert.equal('session' in report,false);
    assert.deepEqual(readFileSync(join(f.task.root,'file.txt'),'utf8'),'before');
  } finally {f.clean();}
});
test('programmatic objective has its own budget independent of packet-file cap',{skip:!posix},async()=>{
  const f=setup();
  try {
    const codexExecutable=executable(f.directory),objective='é'.repeat(40000);
    assert.throws(()=>encodeNativePacket(f.task,objective),reason('packet-too-large'));
    assert.equal((await preflightNativeTask({task:f.task,objective,codexExecutable})).ready,true);
    f.task.budget.inputBytes=100;
    const report=await preflightNativeTask({task:f.task,objective,codexExecutable});
    assert.deepEqual(report.issues,[{code:'objective-too-large'}]);
    assert.ok(Object.isFrozen(report.issues[0]));
    assert.equal(report.checks.find(c=>c.id==='codex-version')?.status,'skipped');
  } finally {f.clean();}
});
test('source drift, bad task and empty objective fail before any executable probe',async()=>{
  const f=setup();
  try {
    // Node would return the wrong version if probed. These failures must skip it.
    const codexExecutable=realpathSync(process.execPath);
    writeFileSync(join(f.task.root,'file.txt'),'after');
    const drift=await preflightNativeTask({task:f.task,objective:'x',codexExecutable});
    assert.equal(drift.ready,false);assert.deepEqual(drift.issues,[{code:'source-drift'}]);
    assert.notEqual(drift.source,f.task.source);assert.equal(drift.checks.at(-1)?.status,'skipped');
    const invalid=await preflightNativeTask({task:{...f.task,checks:[]},objective:'',codexExecutable});
    assert.deepEqual(invalid.issues,[{code:'task-invalid'},{code:'objective-invalid'}]);assert.equal(invalid.source,null);
    const budget=await preflightNativeTask({task:{...f.task,budget:{...f.task.budget,wireBytes:33554433}},objective:'x',codexExecutable});
    assert.ok(budget.issues.some(i=>i.code==='budget-invalid'));assert.equal(budget.checks.at(-1)?.status,'skipped');
  } finally {f.clean();}
});
test('run directory metadata rejects public, in-project, symlink and missing-parent paths',{skip:!posix},async()=>{
  const f=setup();
  try {
    const codexExecutable=realpathSync(process.execPath),options={task:f.task,objective:'x',codexExecutable};
    const publicDir=join(f.directory,'public');mkdirSync(publicDir,{mode:0o755});chmodSync(publicDir,0o755);
    const linked=join(f.directory,'linked');symlinkSync(f.directory,linked);
    for(const runDirectory of [publicDir,join(publicDir,'new'),linked,join(linked,'new'),join(f.directory,'missing','new')]){
      const report=await preflightNativeTask({...options,runDirectory});
      assert.deepEqual(report.issues,[{code:'run-directory-private'}]);assert.equal(report.checks.at(-1)?.status,'skipped');
    }
    const inside=await preflightNativeTask({...options,runDirectory:join(f.task.root,'new')});
    assert.deepEqual(inside.issues,[{code:'run-directory-in-project'}]);
  } finally {f.clean();}
});
test('explicit executable version mismatch and spawn failure expose fixed safe codes',{skip:!posix},async()=>{
  const f=setup();
  try {
    const codexExecutable=executable(f.directory,'secret remote diagnostic');
    const options={task:f.task,objective:'x',codexExecutable};
    const mismatch=await preflightNativeTask(options);
    assert.deepEqual(mismatch.issues,[{code:'codex-version-invalid'}]);
    assert.doesNotMatch(JSON.stringify(mismatch),/secret remote/);
    writeFileSync(codexExecutable,'#!/nonexistent/interpreter\n');
    assert.deepEqual((await preflightNativeTask(options)).issues,[{code:'codex-version-failed'}]);
    chmodSync(codexExecutable,0o600);
    assert.deepEqual((await preflightNativeTask(options)).issues,[{code:'codex-path-invalid'}]);
    assert.deepEqual((await preflightNativeTask({...options,codexExecutable:'codex'})).issues,[{code:'codex-path-invalid'}]);
  } finally {f.clean();}
});

test('source changes during the offline version probe cannot return a stale ready report',{skip:!posix},async()=>{
 const f=setup();try{
  const codexExecutable=join(f.directory,'changing-version-fixture');
  writeFileSync(codexExecutable,'#!'+realpathSync(process.execPath)+'\n'+
   'require("node:fs").writeFileSync('+JSON.stringify(join(f.task.root,'file.txt'))+',"changed during probe");console.log("codex-cli 0.162.1");\n',{mode:0o700});
  const report=await preflightNativeTask({task:f.task,objective:'x',codexExecutable});
  assert.equal(report.ready,false);assert.deepEqual(report.issues,[{code:'source-drift'}]);
  assert.equal(report.checks.at(-1)?.id,'source-after-probe');assert.notEqual(report.source,f.task.source);
 }finally{f.clean();}
});
