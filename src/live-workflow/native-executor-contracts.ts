import type { NativeCheck } from './native-checks-contracts.js';
import type { CodingResult } from './contracts.js';
export const nativeSchema = 'native-session-v2';
export const NATIVE_MAX_WIRE_BYTES = 33554432;
export const budgetKeys = ['runtimeMs', 'turns', 'toolCalls', 'inputBytes', 'resultBytes', 'wireBytes', 'outputBytes', 'retries'] as const;
export type BudgetKey = typeof budgetKeys[number];
export type NativeCounters = Record<BudgetKey, number>;
export type NativeBudget = Omit<NativeCounters, 'turns' | 'toolCalls' | 'retries'> & {
  turns: number | null; toolCalls: number | null; retries: 0 | 1 | 2;
};
export interface NativeTask {
  project: string; task: string; source: string; root: string;
  model: 'gpt-6.1-sol'; effort: 'medium' | 'high';
  readPaths: string[]; writePaths: string[]; checks: NativeCheck[]; budget: NativeBudget;
}
export interface NativeCheckpoint {
  schema: string; binding: string; source: string; thread: string | null;
  stage: string; pending: string | null; seen: string[]; counters: NativeCounters;
  status: 'ready' | 'running' | 'completed' | 'stopped' | 'indeterminate';
}
export interface NativeProjectBoundary {
  source(): string;
  assertCurrent(expected: string): void;
  commitAppliedSource(before: string, applied: CodingResult): { source: string; transitionReceiptId: string | null };
}
export const unavailableNativeMetrics = ['hardProviderRequestCount', 'fullNativePromptBytes', 'rawProviderResponseBytes'] as const;
export function validateBudget(budget: NativeBudget): void {
  if (!budget || typeof budget !== 'object' || Object.keys(budget).sort().join() !== [...budgetKeys].sort().join()) throw new Error('Invalid native budget');
  for (const key of budgetKeys) {
    const value = budget[key];
    if ((key === 'turns' || key === 'toolCalls') && value === null) continue;
    if (!Number.isSafeInteger(value) || value === null || (key === 'retries' ? value < 0 || value > 2 : value < 1)) throw new Error('Invalid native budget');
  }
  if (budget.wireBytes > NATIVE_MAX_WIRE_BYTES) throw new Error('Invalid native budget: wireBytes');
}
