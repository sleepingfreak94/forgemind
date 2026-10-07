import type { ContextScope, OptimizationInput } from '../context-engine/contracts.js';
import type { JsonlRpc } from './jsonl-rpc.js';

interface BaseIntent {
  scope: ContextScope;
  expiresAt: number;
  workspaceRoot: string;
  model: string;
  mode: 'read-only';
  viewDigest: string;
  maxRuntimeMs: number;
  maxOutputBytes: number;
}
export interface CodexIntent extends BaseIntent {
  driver: 'codex'; provider: 'openai'; effort: string; cliVersion: '0.160.0'; ephemeral: true;
}
export interface CursorConfiguration {
  modelOptionId: string;
  modeOptionId: string;
  options: { configId: string; value: string }[];
}
export interface CursorIntent extends BaseIntent {
  driver: 'cursor'; provider: 'cursor'; cliVersion: '2026.07.09-a3815c0';
  protocolVersion: 1; sessionMode: 'ask'; ephemeral: false;
  persistence: 'private-scratch'; configuration: CursorConfiguration;
}
export type DriverIntent = CodexIntent | CursorIntent;
export type DriverStatus = 'completed' | 'failed' | 'interrupted' | 'denied' | 'cancelled' | 'timed-out' | 'indeterminate';
export interface DriverTerminal {
  status: DriverStatus;
  viewDigest: string;
  outputDigest?: string;
}
/** Privileged, invocation-bound host lease. Never supplied by model JSON. */
export interface DriverLease {
  rpc: JsonlRpc;
  receiptId: string;
  /** Recheck live grant, fencing, source/config identity, environment and budget. */
  check(signal: AbortSignal): Promise<void>;
  /** Durable terminal/indeterminate receipt, including failed/denied attempts. */
  finish(terminal: DriverTerminal): Promise<string>;
  /** Terminate and reap the complete process tree; reject if cleanup is uncertain. */
  stop(): Promise<void>;
}
/** Host reserves exact intent before process/inference. No default allow implementation.
 * Must supervise expiry/revocation, honor cancellation and receipt any failed/late open.
 */
export interface DriverHost {
  open(intent: DriverIntent, signal: AbortSignal): Promise<DriverLease>;
}
export interface DriverEvent { type: 'session-started' | 'turn-started' | 'message' | 'request-denied'; id: string; text?: string }
export interface DriverResult {
  status: 'completed' | 'failed' | 'interrupted';
  threadId: string;
  turnId: string;
  output: string;
  outputDigest: string;
  viewDigest: string;
  receipts: readonly string[];
  events: readonly DriverEvent[];
}
export interface AgentDriver { run(packet: OptimizationInput, signal?: AbortSignal): Promise<DriverResult> }
export class DriverError extends Error {
  constructor(readonly code: 'invalid-input' | 'busy' | 'denied' | 'protocol-error' | 'disconnected' | 'rpc-error' |
    'timed-out' | 'cancelled' | 'output-limit' | 'cleanup-failed' | 'receipt-failed') {
    super(code); this.name = 'DriverError';
  }
}
