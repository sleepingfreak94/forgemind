export type RunOutcome = 'completed' | 'failed' | 'blocked' | 'indeterminate';
export type RunPhase = 'setup' | 'planning' | 'approval' | 'baseline' | 'coding' | 'candidate' | 'review' | 'delivery' | 'publication' | 'terminal';
export interface RunCheck {
  readonly phase: 'baseline' | 'candidate'; readonly id: string;
  readonly outcome: 'passed' | 'failed' | 'indeterminate'; readonly exitCode: number | null;
  readonly source: string; readonly evidenceSha256: string;
}
export interface RunReview {
  readonly outcome: 'pass' | 'revise' | 'blocked';
  readonly source: string; readonly evidenceSha256: string;
}
/** Structural evidence only; changedPaths do not grant write authority. */
export interface TerminalRunInput {
  readonly schemaVersion: 1; readonly runId: string; readonly taskId: string;
  readonly execution: 'fixture' | 'authenticated'; readonly startedAt: number; readonly endedAt: number;
  readonly outcome: RunOutcome; readonly lastPhase: RunPhase;
  readonly baselineSource: string; readonly candidateSource?: string;
  readonly changedPaths: readonly string[]; readonly checks: readonly RunCheck[];
  readonly review?: RunReview; readonly terminalReceiptSha256: string;
}
/** Identity/digest cover normalized scoped facts, excluding sequence and recordedAt. */
export interface RunRecord extends TerminalRunInput {
  readonly projectId: string; readonly workspaceRoot: string; readonly id: string; readonly digest: string;
  readonly sequence: number; readonly recordedAt: number;
}
export interface RunListOptions {
  readonly afterSequence: number; readonly throughSequence?: number; readonly limit: number; readonly order: 'asc' | 'desc';
}
