import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { inferenceProfile, runtimeFiles, supervised } from '../../src/live-workflow/process.js';

test('inference preferences support preserves filesystem, child process, and off-broker denial',
  { skip: process.platform !== 'darwin', timeout: 15000 }, async () => {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'fm-inference-denial-'))), scratch=join(root,'scratch');
  mkdirSync(scratch); const secret=join(root,'fixture-secret');writeFileSync(secret,'not available to worker');
  const server=createServer(socket=>socket.end('unexpected'));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const executable=realpathSync(process.execPath), files=runtimeFiles(executable);
  // Pick a distinct broker port: the local listening server must remain unreachable.
  const port=address.port===65535?65534:address.port+1;
  const profile=inferenceProfile(executable,scratch,port,files);
  const script=`const fs=require('node:fs'),cp=require('node:child_process'),net=require('node:net');
    let denied=0;try{fs.readFileSync(${JSON.stringify(secret)})}catch{denied++}
    try{fs.writeFileSync(${JSON.stringify(secret)},'overwritten')}catch{denied++}
    const child=cp.spawnSync('/usr/bin/true');if(child.error||child.status!==0)denied++;
    const socket=net.connect(${address.port},'127.0.0.1');socket.on('connect',()=>process.exit(2));
    socket.on('error',()=>{denied++;console.log(denied);process.exit(denied===4?0:3)});
    setTimeout(()=>process.exit(4),2000);`;
  try {
    const result=await supervised({executable,args:['-e',script],cwd:scratch,env:{HOME:scratch,TMPDIR:scratch,OPENSSL_CONF:"/dev/null"},profile,
      timeoutMs:5000,maxOutputBytes:8192,dependencies:files});
    assert.equal(result.code,0,result.stderr);assert.equal(result.stdout.trim(),'4');
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(root,{recursive:true,force:true}); }
});

test('inference profile confines controlled preference domain and shared-memory operations',
  { skip: process.platform !== 'darwin', timeout: 30000 }, async () => {
  const { execFileSync } = await import('node:child_process');
  const { randomBytes } = await import('node:crypto');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fm-prefs-denial-'))), scratch = join(root, 'scratch');
  mkdirSync(scratch);
  const executable = join(root, 'preferences-probe'), id = randomBytes(6).toString('hex');
  const domain = 'com.forgemind.fixture.' + id, object = '/fm-prefs-' + id;
  const source = join(process.cwd(), 'tests/live-workflow/fixtures/preferences-probe.c');
  try {
    execFileSync('/usr/bin/clang', ['-framework', 'CoreFoundation', source, '-o', executable]);
    execFileSync(executable, ['seed', domain, object]);
    execFileSync(executable, ['read', domain, object], { cwd: scratch, env: { HOME: scratch, TMPDIR: scratch } });
    const files = runtimeFiles(executable);
    const result = await supervised({ executable, args: ['probe', domain, object], cwd: scratch,
      env: { HOME: scratch, TMPDIR: scratch }, profile: inferenceProfile(executable, scratch, 49151, files),
      timeoutMs: 10000, maxOutputBytes: 16384, dependencies: files });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { preferenceReadDenied: 1, preferenceWriteDenied: 1,
      unlistedShmDenied: 1, cacheReadAllowed: 1, cacheWriteDenied: 1 });
    execFileSync(executable, ['read', domain, object], { cwd: scratch, env: { HOME: scratch, TMPDIR: scratch } });
  } finally {
    try { execFileSync(executable, ['cleanup', domain, object]); } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('inference managed configuration uses three exact read literals without directory grants', () => {
  const profile = inferenceProfile(realpathSync(process.execPath), '/private/fixture-scratch', 49151, []);
  for (const name of ['requirements.toml', 'managed_config.toml', 'config.toml'])
    assert.ok(profile.includes(`(literal "/private/etc/codex/${name}")`));
  assert.equal((profile.match(/\(literal "\/private\/etc\/codex\//g) ?? []).length, 3);
  assert.doesNotMatch(profile, /\(subpath "(?:\/private)?\/etc/);
  assert.doesNotMatch(profile, /allow user-preference-write|allow ipc-posix-shm-write|allow process-fork/);
});
