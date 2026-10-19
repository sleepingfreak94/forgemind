import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceIdentity } from '../../src/live-workflow/repository.js';
import { nativeWorkerMain, parseNativeWorkerArguments } from '../../src/local-runtime/native-cli.js';
import { nativePreflightReport } from '../../src/live-workflow/native-preflight.js';
import { encodeNativePacket, loadNativePacket } from '../../src/live-workflow/native-packet.js';
import type { NativeTask } from '../../src/live-workflow/native-executor-contracts.js';
const cli=fileURLToPath(new URL('../../src/local-runtime/native-cli.js',import.meta.url));
const posix={skip:process.platform==='win32'};
function fixture(){
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'native-cli-preflight-'))),root=join(dir,'project');mkdirSync(root);execFileSync('/usr/bin/git',['init','-q',root]);writeFileSync(join(root,'input.txt'),'input');
 const codex=join(dir,'codex');writeFileSync(codex,'#!/bin/sh\nprintf "codex-cli 0.162.1\\n"\n',{mode:0o700});
 const task:NativeTask={project:'fixture',task:'preflight',root,source:sourceIdentity(root),model:'gpt-6.1-sol',effort:'medium',readPaths:['input.txt'],writePaths:[],checks:[{id:'strict',executable:realpathSync(process.execPath),args:[],timeoutMs:1000}],budget:{runtimeMs:10000,turns:1,toolCalls:1,inputBytes:100000,resultBytes:100000,wireBytes:100000,outputBytes:10000,retries:0}};
 const packet=join(dir,'packet.json'),state=join(dir,'never-created'),connection=join(dir,'never-opened-account');
 return{dir,task,packet,state,connection,codex,close:()=>rmSync(dir,{recursive:true,force:true})};
}
test('--preflight works without a terminal, account or run-state creation',posix,()=>{
 const f=fixture();try{
  writeFileSync(f.packet,encodeNativePacket(f.task,'Read and review input'),{mode:0o600});
  const r=spawnSync(process.execPath,[cli,'--preflight','--packet',f.packet,'--connection',f.connection,'--codex',f.codex,'--state',f.state],{encoding:'utf8',timeout:10000});
  assert.equal(r.status,0,r.stderr);const report=JSON.parse(r.stdout);assert.equal(report.ready,true);assert.equal(report.schema,'native-preflight-v1');assert.equal(report.packet.maximumBytes,65536);
  assert(!existsSync(f.state));assert(!existsSync(f.connection));
 }finally{f.close();}
});
test('--preflight reports packet-too-large before opening an account or creating state',posix,()=>{
 const f=fixture();try{
  writeFileSync(f.packet,'x'.repeat(230689),{mode:0o600});
  const r=spawnSync(process.execPath,[cli,'--preflight','--packet',f.packet,'--connection',f.connection,'--codex',f.codex,'--state',f.state],{encoding:'utf8',timeout:10000});
  assert.equal(r.status,2);assert.deepEqual(JSON.parse(r.stdout).issues,[{code:'packet-too-large'}]);assert(!existsSync(f.state));assert(!existsSync(f.connection));
 }finally{f.close();}
});

test('worker rejects replaced permissions and wrong parent binding before account/state access',posix,async()=>{
 const f=fixture();try{
  writeFileSync(f.packet,encodeNativePacket(f.task,'Read only'),{mode:0o600});
  const admitted=loadNativePacket(f.packet,f.state);
  const args=['--packet',f.packet,'--connection',f.connection,'--codex',f.codex,'--state',f.state];
  assert.throws(()=>parseNativeWorkerArguments(args));
  const tail=['--expected-packet-digest',admitted.fileDigest,'--expected-parent-binding',admitted.parentBinding];
  writeFileSync(f.packet,encodeNativePacket({...f.task,writePaths:['input.txt']},'Read only'),{mode:0o600});
  await assert.rejects(nativeWorkerMain([...args,...tail]),error=>nativePreflightReport(error)?.issues[0]?.code==='packet-changed');
  writeFileSync(f.packet,encodeNativePacket(f.task,'Read only'),{mode:0o600});
  await assert.rejects(nativeWorkerMain([...args,...tail.slice(0,3),'0'.repeat(64)]),error=>nativePreflightReport(error)?.issues[0]?.code==='packet-changed');
  assert(!existsSync(f.state));assert(!existsSync(f.connection));
 }finally{f.close();}
});
