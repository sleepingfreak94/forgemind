import type { CodexIntent } from './contracts.js';
import { DriverError } from './contracts.js';
import type { RpcReply } from './jsonl-rpc.js';
import { string } from '../context-engine/validation.js';

export const CODEX_VERSION = '0.160.0' as const;
export const initializeParams = { clientInfo: { name: 'forgemind', title: 'ForgeMind', version: '0.1.0' }, capabilities: { experimentalApi: false } };
export function record(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DriverError('protocol-error');
  return raw as Record<string, unknown>;
}
export function threadParams(intent: CodexIntent, protectedText: string): Record<string, unknown> {
  return { model: intent.model, modelProvider: intent.provider, cwd: intent.workspaceRoot, ephemeral: true,
    sandbox: 'read-only', approvalPolicy: 'never', approvalsReviewer: 'user', serviceTier: 'default',
    developerInstructions: protectedText, config: { model_reasoning_effort: intent.effort, project_doc_max_bytes: 0 } };
}
export function verifyThread(raw: unknown, intent: CodexIntent): string {
  const response = record(raw), thread = record(response.thread), sandbox = record(response.sandbox);
  if (response.model !== intent.model || response.modelProvider !== intent.provider || response.cwd !== intent.workspaceRoot ||
      response.reasoningEffort !== intent.effort || response.approvalPolicy !== 'never' || response.approvalsReviewer !== 'user' ||
      response.serviceTier !== 'default' || sandbox.type !== 'readOnly' || sandbox.networkAccess !== false ||
      thread.cliVersion !== CODEX_VERSION || thread.cwd !== intent.workspaceRoot || thread.ephemeral !== true ||
      thread.modelProvider !== intent.provider || !Array.isArray(response.instructionSources) || response.instructionSources.length !== 0) {
    throw new DriverError('denied');
  }
  string(thread.id, 128); return thread.id;
}
export function turnParams(intent: CodexIntent, threadId: string, text: string): Record<string, unknown> {
  return { threadId, input: [{ type: 'text', text, text_elements: [] }], cwd: intent.workspaceRoot,
    model: intent.model, effort: intent.effort, approvalPolicy: 'never', approvalsReviewer: 'user',
    serviceTier: 'default', sandboxPolicy: { type: 'readOnly', networkAccess: false } };
}
export function denyRequest(method: string): RpcReply {
  if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) return { result: { decision: 'cancel' } };
  if (['execCommandApproval', 'applyPatchApproval'].includes(method)) return { result: { decision: 'abort' } };
  if (method === 'item/permissions/requestApproval') return { result: { permissions: {}, scope: 'turn' } };
  if (method === 'item/tool/call') return { result: { success: false, contentItems: [] } };
  if (method === 'mcpServer/elicitation/request') return { result: { action: 'cancel', content: null } };
  return { error: { code: -32601, message: 'Unsupported request' } };
}
