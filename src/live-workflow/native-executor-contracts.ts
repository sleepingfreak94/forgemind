import type { CheckCommand } from './contracts.js';
export const nativeSchema = 'native-session-v1';
export const budgetKeys = ['runtimeMs', 'turns', 'toolCalls', 'inputBytes', 'resultBytes', 'wireBytes', 'outputBytes'] as const;
export type BudgetKey = typeof budgetKeys[number];
export type NativeBudget = Record<BudgetKey, number>;
export interface NativeTask {
  project: string; task: string; source: string; root: string;
  model: 'gpt-6.1-sol'; effort: 'medium' | 'high';
  readPaths: string[]; writePaths: string[]; checks: CheckCommand[]; budget: NativeBudget;
}
export interface NativeCheckpoint {
  schema: string; binding: string; source: string; thread: string | null;
  stage: string; pending: string | null; seen: string[]; counters: NativeBudget;
  status: 'ready' | 'running' | 'completed' | 'stopped' | 'indeterminate';
}
export const unavailableNativeMetrics = ['hardProviderRequestCount', 'fullNativePromptBytes', 'rawProviderResponseBytes'] as const;
export function validateBudget(budget: NativeBudget): void {
  for (const key of budgetKeys) if (!Number.isSafeInteger(budget[key]) || budget[key] < 1) throw new Error('Invalid native budget');
}
