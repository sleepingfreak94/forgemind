import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chmodSync, cpSync, linkSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { SemanticMemory } from '../../src/memory/semantic.js';
import { boundLocalEmbeddingBackend, createLocalEmbeddingProvider, localEmbeddingIdentity, localEmbeddingPins,
  hasLocalEmbeddingLayout, localEmbeddingLimits, localModelFiles, verifyLocalEmbedding, readLocalEmbeddingConfig } from '../../src/memory/local-embedding.js';
import type { EmbeddingRequest } from '../../src/memory/semantic-contracts.js';
import { fixture } from './fixture.js';

const synthetic = Object.freeze({ model: 'synthetic-numeric-plumbing-only', version: 'test-v1', dimensions: 2 });
function request(text = 'example'): EmbeddingRequest {
  return { schemaVersion: 1, indexVersion: 'project-semantic-v1', provider: synthetic,
    purpose: 'query', text, projectId: 'project-a', workspaceRoot: '/synthetic-fixture', bindingDigest: 'a'.repeat(64) };
}
test('local provider default off; immutable identity binds revision/runtime/q8/dimensions', () => {
  assert.equal(createLocalEmbeddingProvider(), undefined);
  assert.ok(Object.isFrozen(localEmbeddingIdentity)); assert.ok(Object.isFrozen(localEmbeddingPins));
  assert.equal(localEmbeddingIdentity.dimensions, 384); assert.match(localEmbeddingIdentity.version, /transformers@4\.3\.1:q8-cpu/);
  assert.ok(localModelFiles.every(file => Object.isFrozen(file) && /^[a-f0-9]{64}$/.test(file.sha256)));
  assert.throws(() => verifyLocalEmbedding({ enabled: true, model: 'floating-model' }), /mismatch/);
  const getter = Object.defineProperty({}, 'enabled', { get() { throw new Error('getter invoked'); } });
  assert.throws(() => verifyLocalEmbedding(getter), /invalid local/);
});
test('synthetic injection validates bounds, identity and finite nonzero vectors', async () => {
  let calls = 0;
  const provider = boundLocalEmbeddingBackend(synthetic, async () => { calls++; return [3, 4]; });
  assert.deepEqual(await provider.embed(request()), [0.6, 0.8]); assert.equal(calls, 1);
  for (const value of ['', ' ', '\0', 'x'.repeat(2049)]) await assert.rejects(provider.embed(request(value)), /invalid bounded/);
  await assert.rejects(provider.embed({ ...request(), provider: { ...synthetic, version: 'drift' } }));
  await assert.rejects(provider.embed({ ...request(), bindingDigest: 'invalid' }));
  assert.equal(calls, 1);
  for (const vector of [[0, 0], [NaN, 1], [Infinity, 1], [1]]) {
    await assert.rejects(boundLocalEmbeddingBackend(synthetic, async () => vector).embed(request()));
  }
  const failed = boundLocalEmbeddingBackend(synthetic, async () => { throw new Error('backend failed'); });
  await assert.rejects(failed.embed(request()), /backend failed/);
});
test('synthetic plumbing: durable reopen, changed/deleted source invalidation and scoped memory', async () => {
  for (const mutation of ['change', 'delete'] as const) {
    const f = fixture(), foreign = fixture('project-b');
    try {
      const id = f.memory.add(f.input()); f.memory.validate(id, id);
      const other = foreign.memory.add(foreign.input('Foreign project record')); foreign.memory.validate(other, other);
      f.reopen();
      const provider = boundLocalEmbeddingBackend(synthetic, async () => [1, 0]);
      const service = new SemanticMemory(f.memory, provider);
      assert.deepEqual((await service.search('durability')).entries.map(hit => hit.id), [id]);
      assert.equal((await service.search('durability')).projectId, f.projectId);
      if (mutation === 'change') writeFileSync(join(f.root, f.path), '# Changed source\nStatus: Accepted\n');
      else rmSync(join(f.root, f.path));
      assert.deepEqual((await service.search('durability')).entries, []);
    } finally { f.dispose(); foreign.dispose(); }
  }
});
test('CLI default off and missing config explicit; unconfigured recall uses scoped memory', () => {
  const cli = fileURLToPath(new URL('../../src/local-runtime/embedding-cli.js', import.meta.url));
  const f = fixture();
  try {
    const id = f.memory.add(f.input()); f.memory.validate(id, id);
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    const status = run('status'); assert.equal(status.status, 0); assert.equal(JSON.parse(status.stdout).status, 'provider-needed');
    const missing = run('status', '--config', join(f.base, 'missing.json'));
    assert.equal(missing.status, 2); assert.equal(JSON.parse(missing.stdout).status, 'provider-needed');
    const recall = run('recall', '--workspace', f.root, '--state-dir', f.directory, '--query', 'durability');
    assert.equal(recall.status, 0, recall.stderr); assert.deepEqual(JSON.parse(recall.stdout).entries, []);
    assert.equal(JSON.parse(recall.stdout).status, 'provider-needed');
    assert.equal(run('recall', '--workspace', f.root, '--state-dir', f.directory, '--query', 'q', '--limit', '11').status, 2);
  } finally { f.dispose(); }
});

test('untrusted runtime pins and nonprivate config rejected before inference', () => {
  // Run all original assertions against the compiled validator on both path APIs.
  // Only filesystem owner metadata is simulated; no production checks are disabled.
  const source = fileURLToPath(new URL('../../src/memory/local-embedding.js', import.meta.url));
  const script = "import assert from 'node:assert/strict';\nimport {readFileSync} from 'node:fs';\nimport {createHash} from 'node:crypto';\nimport {posix,win32} from 'node:path';\nimport {fileURLToPath} from 'node:url';\nimport vm from 'node:vm';\nconst source=readFileSync(process.argv[1],'utf8'),rows=[];\nfor(const [name,paths,base] of [['posix',posix,'/private/fixture'],['win32',win32,'C:\\\\private\\\\fixture']]){\n  const context=vm.createContext({Buffer,URL,process:{getuid:()=>12345}});\n  const runtimeDirectory=paths.join(base,'node_modules','@huggingface','transformers');\n  const modelDirectory=paths.join(base,'models','Xenova','all-MiniLM-L6-v2');\n  const modulePath=paths.join(runtimeDirectory,'dist/transformers.node.mjs'),configPath=paths.join(base,'config.json');\n  const metadata=p=>({isSymbolicLink:()=>false,isDirectory:()=>p!==modulePath&&p!==configPath,\n    isFile:()=>p===modulePath||p===configPath,nlink:1,uid:12345,mode:p===configPath?0o644:0o700,size:32});\n  const denied=()=>{throw new Error('inspection must not import, spawn or infer')};\n  const imports={\n    'node:crypto':{createHash},\n    'node:path':Object.fromEntries(['basename','dirname','isAbsolute','join','resolve'].map(k=>[k,paths[k]])),\n    'node:fs':{realpathSync:p=>p,lstatSync:metadata,readdirSync:()=>[],\n      readFileSync:p=>{assert.equal(p,modulePath);return Buffer.from('throw new Error(\"must never import\")')}},\n    'node:url':{fileURLToPath},'node:child_process':{spawn:denied},'./semantic.js':{normalizeVector:denied}\n  };\n  const subject=new vm.SourceTextModule(source,{context});\n  await subject.link(specifier=>{\n    assert.ok(Object.hasOwn(imports,specifier),specifier);\n    const values=imports[specifier];\n    return new vm.SyntheticModule(Object.keys(values),function(){for(const [k,v] of Object.entries(values))this.setExport(k,v)},{context});\n  });\n  await subject.evaluate();\n  const ns=subject.namespace,{moduleSha256,...pins}=ns.localEmbeddingPins;\n  context.fixture={schemaVersion:1,enabled:true,...pins,runtimeDirectory,modelDirectory};\n  const config=vm.runInContext('JSON.parse(JSON.stringify(fixture))',context);\n  assert.throws(()=>ns.verifyLocalEmbedding(config),/module pin mismatch/);\n  const drift=vm.runInContext('({...JSON.parse(JSON.stringify(fixture)),revision:\"floating\"})',context);\n  assert.throws(()=>ns.verifyLocalEmbedding(drift),/pins/);\n  assert.throws(()=>ns.readLocalEmbeddingConfig(configPath),/private/);\n  rows.push({platform:name,modulePinRejected:true,configurationPinRejected:true,nonprivateConfigRejected:true});\n}\nconsole.log(JSON.stringify({sourceSha256:createHash('sha256').update(source).digest('hex'),rows,\n  qualification:'Actual compiled validator; simulated canonical owner metadata. Path/pin contract only; no native ownership or Windows execution claim.'}));";
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', script, source],
    { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.rows, ['posix', 'win32'].map(platform => ({ platform,
    modulePinRejected: true, configurationPinRejected: true, nonprivateConfigRejected: true })));
});
test('worker refuses startup without permission mode or with a network grant before input', () => {
  const worker = fileURLToPath(new URL('../../src/memory/local-embedding-worker.js', import.meta.url));
  const source = fileURLToPath(new URL('../../src/', import.meta.url));
  for (const flags of [[], ...['--allow-net', '--allow-fs-write=*', '--allow-child-process'].map(grant =>
    ['--permission', grant, '--allow-fs-read=' + source])]) {
    const result = spawnSync(process.execPath, [...flags, worker], { encoding: 'utf8', input: '' });
    assert.equal(result.status, 2, result.stderr); assert.match(result.stderr, /permission boundary unavailable/);
  }
});

test('record contract and JSON frame derive from bounded text and configuration paths', async () => {
  const { moduleSha256: _module, ...pins } = localEmbeddingPins;
  const config = { schemaVersion: 1, enabled: true, ...pins, runtimeDirectory: '', modelDirectory: '' };
  const fixed = Buffer.byteLength(JSON.stringify({ config, text: '' }));
  assert.equal(localEmbeddingLimits.transportFramingBytes, fixed);
  assert.equal(localEmbeddingLimits.transportBytes, fixed + 6 * (32768 + 2 * 4096));
  let calls = 0;
  const provider = boundLocalEmbeddingBackend(synthetic, async () => { calls++; return [3, 4]; });
  for (const text of ['"'.repeat(32768), '\\'.repeat(32768), 'x' + '\u0001'.repeat(32767), '😀'.repeat(8192)]) {
    assert.equal(Buffer.byteLength(text), 32768);
    await provider.embed({ ...request(text), purpose: 'record' });
    const frame = JSON.stringify({ config: { ...config, runtimeDirectory: '\u0001'.repeat(4096),
      modelDirectory: '\u0001'.repeat(4096) }, text });
    assert.ok(Buffer.byteLength(frame) <= localEmbeddingLimits.transportBytes);
  }
  assert.equal(calls, 4);
  await assert.rejects(provider.embed({ ...request('x'.repeat(32769)), purpose: 'record' }), /invalid bounded/);
  assert.equal(calls, 4);
});
test('worker rejects serialized input above the derived frame cap before runtime loading', () => {
  const worker = fileURLToPath(new URL('../../src/memory/local-embedding-worker.js', import.meta.url));
  const source = fileURLToPath(new URL('../../src/', import.meta.url));
  const result = spawnSync(process.execPath, ['--permission', '--allow-fs-read=' + source, worker],
    { encoding: 'utf8', input: 'x'.repeat(localEmbeddingLimits.transportBytes + 1) });
  assert.equal(result.status, 2, result.stderr); assert.match(result.stderr, /Pinned offline embedding failed/);
});
test('portable child and read-grant paths work in a checkout with URL-escaped characters', () => {
  const f = fixture();
  try {
    const checkout = join(f.base, 'checkout space # percent %');
    mkdirSync(checkout);
    cpSync(fileURLToPath(new URL('../../src/', import.meta.url)), join(checkout, 'src'), { recursive: true });
    cpSync(fileURLToPath(new URL('./', import.meta.url)), join(checkout, 'tests/memory'), { recursive: true });
    writeFileSync(join(checkout, 'package.json'), JSON.stringify({ type: 'module' }));
    const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap',
      '--test-name-pattern=CLI default off|worker refuses startup',
      join(checkout, 'tests/memory/local-embedding.test.js')], { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /# tests 2\b/); assert.match(result.stdout, /# pass 2\b/);
    assert.match(result.stdout, /# skipped 0\b/);
  } finally { f.dispose(); }
});
test('Windows drive and escaped-space file URLs convert to native paths', () => {
  assert.equal(fileURLToPath('file:///C:/work/escaped%20space/embedding-cli.js', { windows: true }),
    'C:\\work\\escaped space\\embedding-cli.js');
});

test('portable layout uses exact POSIX and Windows components without filesystem ownership claims', () => {
  for (const paths of [posix, win32]) {
    const base = paths === win32 ? 'C:\\private\\cache' : '/private/cache';
    const runtime = paths.join(base, 'node_modules', '@huggingface', 'transformers');
    const model = paths.join(base, 'models', 'Xenova', 'all-MiniLM-L6-v2');
    assert.equal(hasLocalEmbeddingLayout(runtime, model, paths), true);
    for (const parts of [
      ['other_node_modules', '@huggingface', 'transformers'],
      ['node_modules', '@huggingface-other', 'transformers'],
      ['node_modules', '@huggingface', 'other-transformers'],
      ['node_modules', '@huggingface', 'transformers', 'child'],
      ['node_modules', '@huggingface', 'Transformers']
    ]) assert.equal(hasLocalEmbeddingLayout(paths.join(base, ...parts), model, paths), false);
    for (const parts of [
      ['OtherXenova', 'all-MiniLM-L6-v2'], ['Xenova', 'other-all-MiniLM-L6-v2'],
      ['Xenova', 'all-MiniLM-L6-v2', 'child'], ['xenova', 'all-MiniLM-L6-v2']
    ]) assert.equal(hasLocalEmbeddingLayout(runtime, paths.join(base, ...parts), paths), false);
  }
  assert.equal(hasLocalEmbeddingLayout('C:\\private\\node_modules\\@huggingface\\transformers',
    'C:\\private\\models\\Xenova\\all-MiniLM-L6-v2', posix), false);
  assert.equal(hasLocalEmbeddingLayout('/private/node_modules/@huggingface\\transformers',
    '/private/models/Xenova/all-MiniLM-L6-v2', posix), false);
  const share = '\\\\server\\share\\private';
  assert.equal(hasLocalEmbeddingLayout(win32.join(share, 'node_modules', '@huggingface', 'transformers'),
    win32.join(share, 'models', 'Xenova', 'all-MiniLM-L6-v2'), win32), true);
});
test('missing owner identity fails closed before filesystem or runtime access', () => {
  const url = new URL('../../src/memory/local-embedding.js', import.meta.url).href;
  const script = 'import assert from "node:assert/strict";' +
    'import {verifyLocalEmbedding,localEmbeddingPins} from ' + JSON.stringify(url) + ';' +
    'Object.defineProperty(process,"getuid",{value:undefined});' +
    'const {moduleSha256,...pins}=localEmbeddingPins;' +
    'assert.throws(()=>verifyLocalEmbedding({schemaVersion:1,enabled:true,...pins,' +
    'runtimeDirectory:"/absent/node_modules/@huggingface/transformers",' +
    'modelDirectory:"/absent/models/Xenova/all-MiniLM-L6-v2"}),/ownership checks unavailable/);';
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
test('canonical ownership, symlink and hardlink boundaries precede runtime pins',
  { skip: typeof process.getuid !== 'function' && 'POSIX ownership checks unavailable; native ACL enforcement deferred' }, () => {
  const f = fixture();
  try {
    const runtimeDirectory = join(f.base, 'node_modules/@huggingface/transformers');
    const modelDirectory = join(f.base, 'models/Xenova/all-MiniLM-L6-v2');
    mkdirSync(join(runtimeDirectory, 'dist'), { recursive: true });
    mkdirSync(modelDirectory, { recursive: true });
    const module = join(runtimeDirectory, 'dist/transformers.node.mjs');
    writeFileSync(module, 'untrusted; never execute');
    const { moduleSha256: _module, ...pins } = localEmbeddingPins;
    const config = { schemaVersion: 1, enabled: true, ...pins, runtimeDirectory, modelDirectory };
    const alias = join(f.base, 'alias'); symlinkSync(runtimeDirectory, alias, 'dir');
    assert.throws(() => verifyLocalEmbedding({ ...config, runtimeDirectory: alias }), /canonical/);
    const parent = join(f.base, 'parent'); symlinkSync(join(f.base, 'node_modules'), parent, 'dir');
    assert.throws(() => verifyLocalEmbedding({ ...config,
      runtimeDirectory: join(parent, '@huggingface/transformers') }), /canonical/);
    assert.throws(() => verifyLocalEmbedding({ ...config,
      runtimeDirectory: runtimeDirectory + '/../transformers' }), /canonical/);
    linkSync(module, join(f.base, 'module-hardlink'));
    assert.throws(() => verifyLocalEmbedding(config), /trusted owner/);
    rmSync(join(f.base, 'module-hardlink'));
    chmodSync(runtimeDirectory, 0o777);
    assert.throws(() => verifyLocalEmbedding(config), /trusted owner/);
    chmodSync(runtimeDirectory, 0o755);
    const alternate = join(f.base, 'other-transformers'); mkdirSync(alternate);
    assert.throws(() => verifyLocalEmbedding({ ...config, runtimeDirectory: alternate }), /layout/);
    assert.throws(() => verifyLocalEmbedding(config), /module pin mismatch/);
    const privateConfig = join(f.base, 'config.json');
    writeFileSync(privateConfig, JSON.stringify(config), { mode: 0o644 });
    chmodSync(privateConfig, 0o644);
    assert.throws(() => readLocalEmbeddingConfig(privateConfig), /private/);
  } finally { f.dispose(); }
});
