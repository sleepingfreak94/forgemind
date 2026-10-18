import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { safePath, sourcePath } from './validation.js';
import type { CheckCommand } from './contracts.js';

/** Native-only, owner-defined check. Workers select its ID, never its commands. */
export interface CompiledTestCheck {
  kind: 'typescript-tests';
  id: string;
  compilerExecutable: string;
  nodeExecutable: string;
  project: string;
  testPaths: string[];
  timeoutMs: number;
}
export type NativeCheck = CheckCommand | CompiledTestCheck;
export function isCompiledTestCheck(check: NativeCheck): check is CompiledTestCheck {
  return 'kind' in check && check.kind === 'typescript-tests';
}
export function validateNativeCheck(root: string, check: NativeCheck): void {
  if (!check || typeof check !== 'object' || !check.id || typeof check.id !== 'string' ||
      !Number.isSafeInteger(check.timeoutMs) || check.timeoutMs < 1 || check.timeoutMs > 30000)
    throw new Error('Invalid native check');
  const executable = (path: string) => {
    if (typeof path !== 'string' || !isAbsolute(path) || path !== realpathSync(path))
      throw new Error('Invalid native check executable');
  };
  if (isCompiledTestCheck(check)) {
    if (Object.keys(check).sort().join() !== 'compilerExecutable,id,kind,nodeExecutable,project,testPaths,timeoutMs')
      throw new Error('Unexpected compiled check fields');
    executable(check.compilerExecutable); executable(check.nodeExecutable);
    sourcePath(check.project);
    if (!check.project.endsWith('.json')) throw new Error('TypeScript project configuration required');
    safePath(root, check.project);
    if (!Array.isArray(check.testPaths) || !check.testPaths.length || check.testPaths.length > 64 ||
        new Set(check.testPaths).size !== check.testPaths.length) throw new Error('Exact test paths required');
    for (const path of check.testPaths) {
      sourcePath(path);
      if (!path.startsWith('tests/') || !path.endsWith('.test.ts')) throw new Error('TypeScript test path required');
      safePath(root, path);
    }
  } else {
    if ('kind' in check) throw new Error('Unknown native check kind');
    executable(check.executable);
    if (!Array.isArray(check.args) || check.args.some(a => typeof a !== 'string' || a.includes('\0')))
      throw new Error('Invalid native check arguments');
  }
}
