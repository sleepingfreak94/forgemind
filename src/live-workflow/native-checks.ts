import { sha256 } from './validation.js';
import { runChecks } from './checks.js';
import { runCompiledCheck } from './native-compiled-check.js';
import { isCompiledTestCheck, validateNativeCheck } from './native-checks-contracts.js';
import type { NativeCheck } from './native-checks-contracts.js';
import type { CompiledCheckResult } from './native-compiled-check.js';
import type { CheckResult } from './checks.js';
import type { ActionAuthority } from './contracts.js';

/** Protect nested runners whose cleanup catch also attempts settlement. A finish
 * may persist its terminal and then throw; that attempt must never be repeated. */
function singleFinish(authority: ActionAuthority): ActionAuthority {
  return { reserve(envelope) {
    const receipt = authority.reserve(envelope);
    let attempted = false;
    return { check: () => receipt.check(), finish(status, digest) {
      if (attempted) return;
      attempted = true;
      receipt.finish(status, digest);
    } };
  } };
}

/** Shared by host_check callbacks and final native verification; never starts inference. */
export async function runNativeChecks(root: string, source: string, commands: NativeCheck[],
  scratchParent: string, authority: ActionAuthority, signal: AbortSignal,
  onSettled?: (result: CheckResult | CompiledCheckResult) => void): Promise<(CheckResult | CompiledCheckResult)[]> {
  commands.forEach(command => validateNativeCheck(root, command));
  const results: (CheckResult | CompiledCheckResult)[] = [];
  const nested = singleFinish(authority);
  for (const command of commands) {
    signal.throwIfAborted();
    if (isCompiledTestCheck(command)) {
      const receipt = authority.reserve({ kind: 'command', source,
        detail: { operation: 'native.predefined-check', command } });
      let attempted = false;
      try {
        receipt.check();
        const result = await runCompiledCheck(root, source, command, scratchParent, nested, signal);
        receipt.check();
        const digest = sha256(JSON.stringify(result));
        attempted = true;
        receipt.finish(result.passed ? 'completed' : 'failed', digest);
        results.push(result);
        onSettled?.(result);
      } catch (error) {
        if (!attempted) {
          attempted = true;
          try { receipt.finish('indeterminate'); } catch {}
        }
        throw error;
      }
    }
    else {
      const settled = await runChecks(root, source, [command], scratchParent, nested, signal);
      for (const result of settled) { results.push(result); onSettled?.(result); }
    }
    if (results.at(-1)?.passed === false) break;
  }
  return results;
}

/** Full manifests stay in owner scratch evidence, outside the worker result budget. */
export function nativeCheckSummary(result: CheckResult): CheckResult {
  return { id: result.id, passed: result.passed, exitCode: result.exitCode,
    stdout: result.stdout, stderr: result.stderr };
}
