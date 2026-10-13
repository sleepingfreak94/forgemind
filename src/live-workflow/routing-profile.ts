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
