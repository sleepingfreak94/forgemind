/** Offline imported history only. None of these types conveys host authority. */
export const qualificationSchema = 'historical-qualification-v1' as const;
export const maxQualificationBytes = 2 * 1024 * 1024;
export const qualificationCategories = ['fixture-conformance', 'protocol', 'sandbox', 'account', 'inference', 'review', 'deployment'] as const;
export type QualificationCategory = typeof qualificationCategories[number];
export type EvidenceClassification = 'reported' | 'imported' | 'fixture' | 'unavailable';
export type EvidenceStatus = 'consistent' | 'incomplete' | 'failed' | 'unqualified';
export interface UnavailableEvidence { readonly classification: 'unavailable'; readonly value: 'unavailable' }
export interface BuildArtifactPin { readonly id: string; readonly path: string; readonly sha256: string }
export interface QualificationBuild {
  readonly schema: 'qualification-build-v1'; readonly source: string;
  readonly artifacts: readonly BuildArtifactPin[];
}
export interface QualificationArtifact {
  readonly name: 'before-checks.json' | 'after-checks.json' | 'review.json';
  readonly source: string; readonly sha256: string;
  /** Exact original UTF-8 artifact bytes, including formatting and final newline. */
  readonly json: string;
}
export interface QualificationReview {
  readonly schema: 'qualification-review-v1'; readonly taskId: string; readonly source: string;
  readonly reviewer: string; readonly implementer: string | null;
  readonly createdAt: number; readonly expiresAt: number;
  readonly artifact: QualificationArtifact;
}
export interface QualificationInputBase {
  readonly schema: 'qualification-input-v1'; readonly taskId: string; readonly projectId: string;
  readonly source: string; readonly fixture: boolean; readonly requiredChecks: readonly string[];
}
/** nativeTask is the original NativeTask; result is runNativeTask's actual return,
 * or {phase,code,receipts} exported from NativeRunError. No replacement executor. */
export interface NativeQualificationInput extends QualificationInputBase {
  readonly nativeTask: unknown; readonly parentBinding: string; readonly result: unknown;
}
export interface SupervisedQualificationInput extends QualificationInputBase {
  readonly receipt: unknown; readonly artifacts: readonly QualificationArtifact[];
}
export interface QualificationOptions {
  readonly mode: 'native' | 'supervised'; readonly input: unknown; readonly build: unknown;
  readonly review?: unknown; readonly expectedSource: string;
  readonly createdAt: number; readonly expiresAt: number; readonly now: number;
  /** If supplied, must decode to exactly input. Otherwise hash canonical JSON. */
  readonly rawInput?: string;
}
export interface QualificationFinding {
  readonly category: QualificationCategory; readonly classification: EvidenceClassification;
  readonly status: EvidenceStatus; readonly code: string;
}
export interface QualificationCheck {
  readonly id: string; readonly source: string; readonly classification: EvidenceClassification;
  readonly passed: boolean; readonly exitCode: number | null; readonly digest: string;
  readonly receiptBound: boolean;
}
export interface ReviewProjection {
  readonly classification: 'imported' | 'fixture'; readonly reviewer: string;
  readonly implementer: string | null; readonly verdict: 'pass' | 'revise' | 'blocked';
  readonly source: string; readonly digest: string; readonly createdAt: number;
  readonly expiresAt: number; readonly independent: boolean;
}
export interface ImportedPin { readonly classification: 'imported' | 'fixture'; readonly digest: string }
export interface DiagnosticProjection {
  readonly kind: string; readonly httpStatusCode: number | null; readonly willRetry: boolean | null;
}
export interface NativeProjection {
  readonly classification: 'imported' | 'fixture'; readonly reportedQualification: 'native-seatbelt' | 'offline-fixture' | 'unavailable';
  readonly checkpointStatus: string; readonly pending: boolean; readonly retries: number;
  readonly runtimeBinding: ImportedPin | UnavailableEvidence;
  readonly executable: ImportedPin | UnavailableEvidence; readonly profile: ImportedPin | UnavailableEvidence;
  readonly config: UnavailableEvidence; readonly catalog: UnavailableEvidence; readonly platform: UnavailableEvidence;
  readonly model: UnavailableEvidence; readonly effort: UnavailableEvidence;
  readonly cleanup: 'reported-settled' | 'unavailable'; readonly cleanupProof: UnavailableEvidence;
  readonly completed: boolean;
  readonly failure: { readonly phase: string; readonly code: string; readonly diagnostic: DiagnosticProjection | null } | null;
  readonly observedTokens: Readonly<Record<string, number>>;
}
export interface ArtifactProjection extends ImportedPin {
  readonly name: QualificationArtifact['name']; readonly source: string;
}
export interface ExecutionProjection {
  readonly classification: 'imported' | 'fixture';
  readonly status: 'completed' | 'failed' | 'blocked' | 'running';
  readonly sourceBound: boolean; readonly cleanup: 'reported-settled' | 'unavailable';
}
/** Internal/public pure adapter result. Contains safe projections only. */
export interface QualificationEvidence {
  readonly fixture: boolean; readonly checks: readonly QualificationCheck[];
  readonly baselineChecks: readonly QualificationCheck[]; readonly artifacts: readonly ArtifactProjection[];
  readonly execution: ExecutionProjection; readonly native: NativeProjection | UnavailableEvidence;
  readonly reviewedVerdict: 'pass' | 'revise' | 'blocked' | null;
}
export interface QualificationReport {
  readonly schema: typeof qualificationSchema; readonly scope: 'historical-evidence-consistency';
  readonly authority: 'none'; readonly mode: 'native' | 'supervised';
  readonly taskId: string; readonly projectId: string; readonly source: string;
  readonly createdAt: number; readonly expiresAt: number;
  readonly input: { readonly digest: string; readonly encoding: 'utf8-json' | 'canonical-json'; readonly classification: 'imported' };
  readonly build: QualificationBuild & { readonly digest: string; readonly classification: 'reported' };
  readonly fixture: boolean; readonly requiredChecks: readonly string[];
  readonly checks: readonly QualificationCheck[]; readonly baselineChecks: readonly QualificationCheck[];
  readonly artifacts: readonly ArtifactProjection[]; readonly execution: ExecutionProjection;
  readonly review: ReviewProjection | UnavailableEvidence; readonly native: NativeProjection | UnavailableEvidence;
  readonly executionConsistent: boolean; readonly outcome: 'completed-scoped' | 'partial';
  readonly findings: readonly QualificationFinding[];
  readonly limitations: {
    readonly hardBillingCap: 'unavailable'; readonly accountEntitlement: 'unavailable'; readonly billingSettings: 'unavailable';
    readonly hardProviderRequestCount: 'unavailable'; readonly fullNativePromptBytes: 'unavailable'; readonly rawProviderResponseBytes: 'unavailable';
    readonly tokenUsage: 'reported-observation-only'; readonly productionApproval: 'unavailable'; readonly deployment: 'unqualified';
  };
  readonly digest: string;
}
export interface QualificationVerification {
  readonly integrity: 'consistent'; readonly classification: 'imported'; readonly authority: 'none';
  readonly source: string; readonly digest: string; readonly outcome: 'completed-scoped' | 'partial';
}
