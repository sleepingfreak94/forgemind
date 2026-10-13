import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, lstatSync } from 'node:fs';
import { relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinFile, verifyFile } from '../host-enforcement/manifest.js';
import type { PinnedFile } from '../host-enforcement/manifest.js';

export const NATIVE_SOL_MODEL = 'gpt-6.1-sol' as const;
export const NATIVE_CATALOG_SHA256 = 'b0ffc1c0e4e3a873df116e92afe103155a699303448484861225eb49f7838d45';
export const OFFICIAL_SOL_ENTRY_SHA256 = '9e7f6bcc65c0cf9e86cc97290447922e3b3834e54f4036a5ab916a4d5e2f9117';
export const NATIVE_CATALOG_PATH = fileURLToPath(new URL('../../../config/native-sol-model-catalog.json', import.meta.url));
const digest=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');

/** Exact metadata from Codex rust-v0.162.1, with only three capability reductions. */
export function validateNativeSolCatalog(bytes:Buffer):void {
  if(bytes.length!==66788||digest(bytes)!==NATIVE_CATALOG_SHA256)throw new Error('Native catalog bytes differ from reviewed asset');
  const value=JSON.parse(bytes.toString('utf8')) as {models?:Record<string,unknown>[]};
  if(Object.keys(value).join()!=='models'||!Array.isArray(value.models)||value.models.length!==1)throw new Error('Invalid native catalog shape');
  const model=value.models[0]!;
  if(model.slug!==NATIVE_SOL_MODEL||model.tool_mode!=='direct'||model.apply_patch_tool_type!==null||
    !Array.isArray(model.experimental_supported_tools)||model.experimental_supported_tools.length!==0)throw new Error('Native catalog capability reduction changed');
  const restored={...model,tool_mode:'code_mode_only',apply_patch_tool_type:'freeform',experimental_supported_tools:['send_user_message_async','clock']};
  if(digest(JSON.stringify(restored))!==OFFICIAL_SOL_ENTRY_SHA256)throw new Error('Native catalog does not reproduce pinned official entry');
}
function outside(root:string,path:string):boolean {
  const rel=relative(root,path);return rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel);
}
export function validateNativeCatalogPlacement(path:string,home:string,tmp:string):void {
  const canonical=realpathSync(path),stat=lstatSync(path);
  if(canonical!==path||stat.isSymbolicLink()||!stat.isFile()||stat.nlink!==1||stat.mode&0o022||
    ![0,process.getuid?.()].includes(stat.uid))throw new Error('Unsafe native catalog asset');
  if(!outside(realpathSync(home),canonical)||!outside(realpathSync(tmp),canonical))throw new Error('Native catalog must be outside writable native directories');
}
/** Fixed runtime-module-relative asset. There is no caller-selected catalog path. */
export function pinNativeSolCatalog(model:string,home:string,tmp:string):PinnedFile {
  if(model!==NATIVE_SOL_MODEL)throw new Error('Reviewed native catalog supports only Sol 6.1');
  validateNativeCatalogPlacement(NATIVE_CATALOG_PATH,home,tmp);
  const pin=pinFile(NATIVE_CATALOG_PATH);
  if(pin.path!==NATIVE_CATALOG_PATH)throw new Error('Native catalog canonical identity changed');
  validateNativeSolCatalog(readFileSync(NATIVE_CATALOG_PATH));
  validateNativeCatalogPlacement(NATIVE_CATALOG_PATH,home,tmp);
  verifyFile(pin);
  return pin;
}
