export interface CheckCommand {
  id: string;
  executable: string;
  args: string[];
  timeoutMs: number;
}
export interface LiveTask {
  schemaVersion: 1;
  taskId: string;
  objective: string;
  readPaths: string[];
  writePaths: string[];
  checks: CheckCommand[];
  model: string;
  effort: "low" | "medium" | "high";
  maxModelRequests: number;
  maxPromptBytes: number;
  maxOutputBytes: number;
  maxRuntimeMs: number;
  draftPr: boolean;
}
export interface GeneratedPlan {
  objective: string;
  paths: string[];
  steps: string[];
  acceptanceCriteria: string[];
  risks: string[];
}
export interface ProposedEdit {
  path: string;
  beforeSha256: string | null;
  content: string | null;
}
export interface CodingResult {
  summary: string;
  edits: ProposedEdit[];
}
export interface ReviewResult {
  verdict: "pass" | "revise" | "blocked";
  findings: string[];
  acceptance: string[];
}
export interface ModelPort {
  complete(
    instructions: string,
    input: unknown,
    schema: object,
    signal: AbortSignal,
  ): Promise<unknown>;
}
export interface ActionEnvelope {
  kind: string;
  source: string;
  detail: unknown;
}
export interface ActionReceipt {
  check(): void;
  finish(
    status: "completed" | "failed" | "indeterminate",
    outputDigest?: string,
  ): void;
}
export interface ActionAuthority {
  reserve(envelope: ActionEnvelope): ActionReceipt;
}
export interface PhaseResult {
  phase: string;
  source: string;
  artifact?: string;
}
export const planSchema = {
  type: "object",
  additionalProperties: false,
  required: ["objective", "paths", "steps", "acceptanceCriteria", "risks"],
  properties: {
    objective: { type: "string" },
    paths: { type: "array", items: { type: "string" } },
    steps: { type: "array", items: { type: "string" } },
    acceptanceCriteria: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
  },
};
export const codingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "edits"],
  properties: {
    summary: { type: "string" },
    edits: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "beforeSha256", "content"],
        properties: {
          path: { type: "string" },
          beforeSha256: { type: ["string", "null"] },
          content: { type: ["string", "null"] },
        },
      },
    },
  },
};
export const reviewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "findings", "acceptance"],
  properties: {
    verdict: { type: "string", enum: ["pass", "revise", "blocked"] },
    findings: { type: "array", items: { type: "string" } },
    acceptance: { type: "array", items: { type: "string" } },
  },
};
