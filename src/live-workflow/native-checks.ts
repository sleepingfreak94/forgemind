import { sha256 } from './validation.js';
import { runChecks } from './checks.js';
import { runCompiledCheck } from './native-compiled-check.js';
import { isCompiledTestCheck, validateNativeCheck } from './native-checks-contracts.js';
import type { NativeCheck } from './native-checks-contracts.js';
import type { CompiledCheckResult } from './native-compiled-check.js';
import type { CheckResult } from './checks.js';
import type { ActionAuthority } from './contracts.js';

/** Shared by host_check callbacks and final native verification; never starts inference. */
export async function runNativeChecks(root: string, source: string, commands: NativeCheck[],
  scratchParent: string, authority: ActionAuthority, signal: AbortSignal): Promise<(CheckResult | CompiledCheckResult)[]> {
  commands.forEach(command => validateNativeCheck(root, command));
  const results: (CheckResult | CompiledCheckResult)[] = [];
  for (const command of commands) {
    signal.throwIfAborted();
    if (isCompiledTestCheck(command)) {
      const receipt = authority.reserve({ kind: 'command', source,
        detail: { operation: 'native.predefined-check', command } });
      try {
        receipt.check();
        const result = await runCompiledCheck(root, source, command, scratchParent, authority, signal);
        receipt.check(); receipt.finish(result.passed ? 'completed' : 'failed', sha256(JSON.stringify(result)));
        results.push(result);
      } catch (error) {
        try { receipt.finish('indeterminate'); } catch {}
        throw error;
      }
    }
    else results.push(...await runChecks(root, source, [command], scratchParent, authority, signal));
  }
  return results;
}

/** Full manifests stay in owner scratch evidence, outside the worker result budget. */
export function nativeCheckSummary(result: CheckResult): CheckResult {
  return { id: result.id, passed: result.passed, exitCode: result.exitCode,
    stdout: result.stdout, stderr: result.stderr };
}
