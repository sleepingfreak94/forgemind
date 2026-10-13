import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,realpathSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,linkSync,chmodSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { NATIVE_CATALOG_PATH,NATIVE_CATALOG_SHA256,OFFICIAL_SOL_ENTRY_SHA256,validateNativeSolCatalog,validateNativeCatalogPlacement,pinNativeSolCatalog } from '../../src/live-workflow/native-executor-catalog.js';

test('fixed direct catalog reproduces the official Sol entry after reversing exactly three reductions',()=>{
  const bytes=readFileSync(NATIVE_CATALOG_PATH);validateNativeSolCatalog(bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),NATIVE_CATALOG_SHA256);
  const models=JSON.parse(bytes.toString()).models;assert.equal(models.length,1);
  const original={...models[0],tool_mode:'code_mode_only',apply_patch_tool_type:'freeform',experimental_supported_tools:['send_user_message_async','clock']};
  assert.equal(createHash('sha256').update(JSON.stringify(original)).digest('hex'),OFFICIAL_SOL_ENTRY_SHA256);
  for(const change of [{tool_mode:'code_mode_only'},{slug:'unknown-model'},{experimental_supported_tools:['clock']},{apply_patch_tool_type:'freeform'},{context_window:1}]){
    const modified=JSON.parse(bytes.toString());Object.assign(modified.models[0],change);
    assert.throws(()=>validateNativeSolCatalog(Buffer.from(JSON.stringify(modified))),/differ from reviewed asset/);
  }
});
test('catalog rejects links, mutable permissions and placement inside native writable directories',()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'fm-catalog-'))),home=join(root,'home'),tmp=join(root,'tmp');
  mkdirSync(home,{mode:0o700});mkdirSync(tmp,{mode:0o700});
  const asset=join(root,'catalog.json');writeFileSync(asset,readFileSync(NATIVE_CATALOG_PATH),{mode:0o644});
  try{
    validateNativeCatalogPlacement(asset,home,tmp);
    const alias=join(root,'alias.json');symlinkSync(asset,alias);assert.throws(()=>validateNativeCatalogPlacement(alias,home,tmp),/Unsafe/);
    const linked=join(root,'linked.json');linkSync(asset,linked);assert.throws(()=>validateNativeCatalogPlacement(asset,home,tmp),/Unsafe/);rmSync(linked);
    chmodSync(asset,0o666);assert.throws(()=>validateNativeCatalogPlacement(asset,home,tmp),/Unsafe/);chmodSync(asset,0o644);
    const writable=join(home,'catalog.json');writeFileSync(writable,readFileSync(asset));assert.throws(()=>validateNativeCatalogPlacement(writable,home,tmp),/outside writable/);
    assert.throws(()=>pinNativeSolCatalog('unknown-model',home,tmp),/only Sol/);
    const pin=pinNativeSolCatalog('gpt-6.1-sol',home,tmp);assert.equal(pin.path,NATIVE_CATALOG_PATH);assert.equal(pin.digest,NATIVE_CATALOG_SHA256);
  }finally{rmSync(root,{recursive:true,force:true});}
});
