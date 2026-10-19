import { realpathSync } from 'node:fs';
import { serialize } from '../context-engine/validation.js';
import { sha256, sourcePath } from './validation.js';
import { validateBudget } from './native-executor-contracts.js';
import { validateNativeCheck } from './native-checks-contracts.js';
import type { NativeTask } from './native-executor-contracts.js';

/** Shared owner validation; keep callable and packet entry points equivalent. */
export function validateNativeTask(task: NativeTask): void {
  validateBudget(task.budget);
  if (task.model!=='gpt-6.1-sol'||!['medium','high'].includes(task.effort)||
      !/^[a-f0-9]{64}$/.test(task.source)||!task.project||!task.task||task.root!==realpathSync(task.root)) throw new Error('Invalid native task identity');
  for(const paths of [task.readPaths,task.writePaths]){
    if(!Array.isArray(paths)||new Set(paths).size!==paths.length)throw new Error('Exact native paths required');
    paths.forEach(sourcePath);
  }
  if(!Array.isArray(task.checks)||!task.checks.length||new Set(task.checks.map(c=>c.id)).size!==task.checks.length)throw new Error('Predefined native checks required');
  task.checks.forEach(check => validateNativeCheck(task.root, check));
}
/** Checkpoint source changes do not change the original parent permission. */
export function nativePacketBinding(packet:{schema:string;task:NativeTask;objective:string}):string{
  const {source:_source,...task}=packet.task;
  return sha256(serialize({schema:packet.schema,task,objective:packet.objective}));
}
