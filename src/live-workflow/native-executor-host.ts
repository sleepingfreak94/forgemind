import { launchNativeProcess, assertNativeProcess, assertNativeProcessCompleted, onceNativeLifecycle } from './native-executor-process.js';
import type { NativeProcess } from './native-executor-process.js';
import type { NativeLaunchPlan, NativeLifecycleReceipt } from './native-executor-launch-contracts.js';
import { assertChatGPTPlanSession } from './chatgpt-plan.js';
import type { ChatGPTPlanSession } from './chatgpt-plan.js';
import { Transform } from 'node:stream';
import type { Readable, Writable } from 'node:stream';
import { JsonlRpc } from '../agent-drivers/jsonl-rpc.js';
import type { NativeProjectBoundary } from './native-executor-contracts.js';
import type { ActionAuthority } from './contracts.js';
import type { RpcNotification, RpcReply, RpcRequest } from '../agent-drivers/jsonl-rpc.js';
export interface NativeRpc {
  request(method: string, params: unknown, onResult?: (value: unknown) => void): Promise<unknown>;
  notify(method: string, params: unknown): Promise<void>;
  onRequest(handler: (request: RpcRequest) => Promise<RpcReply>): void;
  onNotification(listener: (event: RpcNotification) => void): () => void;
  onFailure(listener: (error: Error) => void): () => void;
  onWire(listener: (bytes: number) => void): () => void;
  close(): void;
}
const trusted = new WeakSet<object>();
/** Offline test seam. This port NEVER qualifies for live inference. */
export interface NativeHost {
  readonly qualification: 'offline-fixture' | 'native-seatbelt';
  readonly provider: 'openai' | 'openai_chatgpt_plan';
  readonly nativeCwd: string | null;
  readonly rpc: NativeRpc;
  readonly authority: ActionAuthority;
  readonly project: NativeProjectBoundary;
  boundary(): void;
  stop(): Promise<void>;
  source(): string;
  check(id: string, signal: AbortSignal): Promise<unknown>;
}
export class FixtureNativeHost implements NativeHost {
  readonly provider = 'openai' as const;
  readonly nativeCwd = null;
  readonly project: NativeProjectBoundary;
  readonly qualification = 'offline-fixture' as const;
  constructor(readonly rpc: NativeRpc, readonly authority: ActionAuthority,
    readonly boundary: () => void, readonly stop: () => Promise<void>,
    readonly source: () => string, readonly check: (id: string, signal: AbortSignal) => Promise<unknown>, project?: NativeProjectBoundary) {
    this.project = project ?? { source, assertCurrent: expected => {
      boundary(); if (source() !== expected) throw new Error('Stale native source');
    }, commitAppliedSource: () => ({source:source(),transitionReceiptId:'fixture-only'}) };
    trusted.add(this);
  }
}
export function assertNativeHost(host: NativeHost): void {
  if (!trusted.has(host)) throw new Error('Trusted host port required; serialized configuration cannot qualify a host');
}

/** Counts both raw stdio directions before transport acceptance. Owner supplied streams only. */
export function fixtureStdioRpc(input: Readable, output: Writable): NativeRpc {
  const listeners = new Set<(bytes: number) => void>();
  const meter = () => new Transform({ transform(chunk: Buffer, _encoding, callback) {
    try { listeners.forEach(f => f(chunk.byteLength)); callback(null, chunk); }
    catch (e) { callback(e as Error); }
  } });
  const incoming = meter(), outgoing = meter();
  input.on('error',()=>incoming.destroy(new Error('Native input disconnected')));
  output.on('error',()=>incoming.destroy(new Error('Native output disconnected')));
  input.pipe(incoming); outgoing.pipe(output);
  const rpc = new JsonlRpc(incoming, outgoing, { timeoutMs: 1000, maxLineBytes: 1048576, maxTotalBytes: 32 * 1024 * 1024 });
  return {
    request: (method, params, onResult) => rpc.request(method, params, onResult), notify: (method, params) => rpc.notify(method, params),
    onRequest: handler => rpc.onRequest(handler), onNotification: handler => rpc.onNotification(handler), onFailure: handler => rpc.onFailure(handler),
    onWire: handler => { listeners.add(handler); return () => { listeners.delete(handler); }; },
    close: () => { rpc.close(); input.unpipe(incoming); outgoing.unpipe(output); incoming.destroy(); outgoing.destroy(); },
  };
}

export interface ProductionNativeHostOptions {
  plan: NativeLaunchPlan;
  lifecycle: NativeLifecycleReceipt;
  session: ChatGPTPlanSession;
  authority: ActionAuthority;
  project: NativeProjectBoundary;
  boundary: () => void;
  check: (id: string, signal: AbortSignal) => Promise<unknown>;
  signal: AbortSignal;
}
/** Host-created process and current account authority are required; never task JSON. */
class ProductionNativeHost implements NativeHost {
  readonly qualification = 'native-seatbelt' as const;
  readonly provider = 'openai_chatgpt_plan' as const;
  readonly nativeCwd: string;
  readonly rpc: NativeRpc;
  readonly authority: ActionAuthority;
  readonly project: NativeProjectBoundary;
  readonly #options: ProductionNativeHostOptions;
  readonly #process: NativeProcess;
  readonly #lease: () => void;
  constructor(options: ProductionNativeHostOptions, process: NativeProcess, lease: () => void) {
    assertNativeProcess(process); assertChatGPTPlanSession(options.session);
    if (process.runtimeBinding !== options.plan.runtimeBinding) throw new Error('Native process runtime mismatch');
    this.#options=options;this.#process=process;this.#lease=lease;
    this.nativeCwd=options.plan.privateTmp;this.rpc=process.rpc;this.authority=options.authority;this.project=options.project;
    trusted.add(this);
  }
  boundary(): void {this.#options.boundary();this.#lease();assertNativeProcess(this.#process);}
  source(): string {return this.project.source();}
  check(id:string,signal:AbortSignal):Promise<unknown>{this.boundary();return this.#options.check(id,signal);}
  stop():Promise<void>{return this.#process.stop();}
  assertCompleted():void {
    this.#options.boundary();this.#lease();assertNativeProcessCompleted(this.#process);
  }
  get evidence(){return this.#process.qualificationEvidence;}
}
export async function createProductionNativeHost(options: ProductionNativeHostOptions): Promise<NativeHost> {
  const shared=onceNativeLifecycle(options.lifecycle);
  let launched:NativeProcess|undefined;
  try {
    assertChatGPTPlanSession(options.session);options.boundary();
    const binding=options.session.binding();
    if(options.plan.accountBinding!==binding.accountSha256 || options.plan.reviewBinding!==String(binding.confirmedAt))throw new Error('Native plan account review mismatch');
    return await options.session.withNativeAccess(async(token,lease)=>{
      const lifecycle=Object.freeze({runtimeBinding:shared.runtimeBinding,receiptId:shared.receiptId,
        checkActive:()=>{lease();shared.checkActive();},
        finish:(status:'completed'|'failed'|'indeterminate')=>shared.finish(status)});
      launched=await launchNativeProcess({plan:options.plan,lifecycle,signal:options.signal,accessToken:token});
      lease();return new ProductionNativeHost(options,launched,lease);
    },options.signal);
  }catch(error){
    let status:'failed'|'indeterminate'='failed';
    if(launched){try{await launched.stop();}catch{status='indeterminate';}}
    shared.finish(status);
    throw error;
  }
}
export function nativeHostEvidence(host:NativeHost):unknown {
  assertNativeHost(host);host.boundary();
  return host instanceof ProductionNativeHost ? host.evidence : null;
}

export function assertNativeHostCompleted(host:NativeHost):void{
  assertNativeHost(host);
  if(!(host instanceof ProductionNativeHost))throw new Error('Production native settlement required');
  host.assertCompleted();
}
