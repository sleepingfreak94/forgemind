import type { ModelPhase } from './contracts.js';
/** Owner-fixed Claude routing (ADR-0014): Opus plans; Sonnet codes and reviews. Never task-selected. */
export const CLAUDE_PHASE_MODELS: Readonly<Record<ModelPhase, string>> = Object.freeze({
  plan: 'claude-opus-5-5', coding: 'claude-sonnet-5-5', review: 'claude-sonnet-5-5',
});
export type OwnerRole = 'coder' | 'debugger' | 'tester' | 'reviewer' | 'architect' | 'classifier' | 'weekly-summary';
/** Policy preference, never an availability or billing authorization claim. */
export function ownerRouting(role: OwnerRole, options: { highTried?: boolean; architecturePurpose?: string; hostQualified?: boolean } = {}) {
  if (role === 'weekly-summary') return { execution: 'deterministic' as const };
  if (role === 'architect') {
    if (!options.architecturePurpose?.trim() || !options.highTried) throw new Error('Astra requires explicit architecture purpose and prior Sol high assessment');
    return { execution: 'model' as const, model: 'gpt-6-astra', effort: 'high', availability: 'unverified' };
  }
  if (role === 'classifier') {
    if (!options.hostQualified) throw new Error('Luna requires qualified host');
    return { execution: 'model' as const, model: 'gpt-6-luna', effort: 'medium', scope: 'narrow-classification-extraction', availability: 'unverified' };
  }
  return { execution: 'model' as const, model: 'gpt-6.1-sol', effort: options.highTried ? 'high' : 'medium', availability: 'unverified' };
}
