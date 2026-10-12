import { sha256 } from './validation.js';
import type { CheckCommand } from './contracts.js';
import type { CheckResult } from './checks.js';

export function snapshotCheckCommands(commands: CheckCommand[]): CheckCommand[] {
  const copy = structuredClone(commands);
  for (const command of copy) {
    Object.freeze(command.args);
    Object.freeze(command);
  }
  return Object.freeze(copy) as unknown as CheckCommand[];
}
function commandDigest(command: CheckCommand): string {
  return sha256(JSON.stringify({
    id: command.id, executable: command.executable, args: command.args, timeoutMs: command.timeoutMs,
  }));
}
export function assertSameCheckCommands(before: CheckCommand[], after: CheckCommand[]): void {
  if (before.length !== after.length || before.some((c, i) => commandDigest(c) !== commandDigest(after[i]!)))
    throw new Error('Configured check commands changed between baseline and candidate');
}
export function checkEvidence(
  source: string, commands: CheckCommand[], results: CheckResult[], artifactBytes: Uint8Array,
): Readonly<{
  source: string; artifactSha256: string;
  configuredChecks: readonly Readonly<{ id: string; commandSha256: string; resultSha256: string }>[];
}> {
  if (!/^[a-f0-9]{64}$/.test(source) || results.length !== commands.length ||
      results.some((r, i) => r.id !== commands[i]!.id))
    throw new Error('Check source or ordered result binding mismatch');
  try {
    if (JSON.stringify(JSON.parse(Buffer.from(artifactBytes).toString('utf8'))) !== JSON.stringify(results))
      throw new Error('mismatch');
  } catch { throw new Error('Saved check artifact differs from executed results'); }
  return Object.freeze({
    source, artifactSha256: sha256(artifactBytes),
    configuredChecks: Object.freeze(commands.map((c, i) => Object.freeze({
      id: c.id, commandSha256: commandDigest(c), resultSha256: sha256(JSON.stringify(results[i])),
    }))),
  });
}
const FULL_REVIEW = 'You are the independent reviewer. You did not implement this candidate. Assess correctness, regressions, security, maintainability, policy and evidence. Return pass only if criteria are met; do not repair files. Report blocking findings as revise/blocked.';
export function reviewInstructions(draftPr: boolean): string {
  if (draftPr) return FULL_REVIEW;
  return 'You are the independent reviewer. You did not implement this candidate. Assess correctness, regressions, security, maintainability, policy and evidence for this candidate and its configured checks. Do not repair files. Report blocking candidate defects or missing current-phase evidence as revise/blocked. ' +
    'This is the Native candidate-review phase of a draftPr:false local task, not ticket completion or publication. Check the supplied baseline/candidate source, selected-file hashes, identical configured-command fingerprints and saved check-artifact digests. ' +
    'Required owner host compilation, broader host regressions and external exact-candidate review happen after this local phase and remain pending mandatory ticket-completion gates. Their absence alone is not a defect in this phase. Do not claim those gates passed, waive them, or treat a local pass as final acceptance. ' +
    'The Native review currently being performed cannot require a prior verdict from itself. Any other required current-phase test or correctness criterion still needs evidence; use revise/blocked when it is missing.';
}
