import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { JsonlRpc } from '../agent-drivers/jsonl-rpc.js';
import type { NativeRpc } from './native-executor-host.js';
import type { NativeLaunchRequest, NativeLifecycleReceipt } from './native-executor-launch-contracts.js';
import { verifyNativeLaunchPlan } from './native-executor-launch-contracts.js';
import { createNativeTunnel } from './native-executor-tunnel.js';
export interface NativeProcess {
  readonly rpc: NativeRpc;
  readonly qualification: 'native-seatbelt';
  readonly runtimeBinding: string;
  readonly receiptId: string;
  readonly qualificationEvidence: Readonly<{ runtimeBinding: string; executableDigest: string; profileDigest: string }>;
  assertActive(): void;
  assertCompleted(): void;
  stop(): Promise<void>;
}
const trusted = new WeakSet<object>();
export function assertNativeProcess(value: NativeProcess): void {
  if (!trusted.has(value)) throw new Error('Native process is not a trusted supervised launch');
  value.assertActive();
}
const settlements = new WeakMap<object, NativeLifecycleReceipt>();
/** Coordinate factory and transport cleanup without repeating a terminal side effect. */
export function onceNativeLifecycle(receipt: NativeLifecycleReceipt): NativeLifecycleReceipt {
  const existing=settlements.get(receipt);
  if(existing)return existing;
  let attempted=false;
  const guarded=Object.freeze({runtimeBinding:receipt.runtimeBinding,receiptId:receipt.receiptId,
    checkActive:()=>receipt.checkActive(),
    finish:(status:'completed'|'failed'|'indeterminate')=>{
      if(attempted)return;
      attempted=true;receipt.finish(status);
    }});
  settlements.set(receipt,guarded);settlements.set(guarded,guarded);return guarded;
}
export function assertNativeProcessCompleted(value:NativeProcess):void{
  if(!trusted.has(value))throw new Error('Native process is not a trusted supervised launch');
  value.assertCompleted();
}
export async function launchNativeProcess(request: NativeLaunchRequest): Promise<NativeProcess> {
  const { plan, signal } = request;
  const lifecycle=onceNativeLifecycle(request.lifecycle);
  let startupTunnel:Awaited<ReturnType<typeof createNativeTunnel>>|undefined;
  let stopLaunched:(()=>Promise<void>)|undefined;
  try {
  if (process.platform !== 'darwin') throw new Error('Native enforcement requires macOS');
  if (lifecycle.runtimeBinding !== plan.runtimeBinding || !lifecycle.receiptId ||
      typeof request.accessToken !== 'string' || !request.accessToken || request.accessToken.length > 16384 || /[\r\n\0]/.test(request.accessToken))
    throw new Error('Invalid native launch binding');
  let stopped = false, finished = false, reaped = false, failure: Error | undefined;
  let terminal:'completed'|'failed'|'indeterminate'|null=null;
  const check = () => { signal?.throwIfAborted(); lifecycle.checkActive(); verifyNativeLaunchPlan(plan, false); };
  check(); verifyNativeLaunchPlan(plan);
  const tunnel = await createNativeTunnel(plan.tunnelPort, check);
  startupTunnel=tunnel;
  let p: ReturnType<typeof fork>;
  try {
    check();
    p = fork(plan.supervisor.path, [], { execPath: plan.node.path, execArgv: [], cwd: plan.privateTmp,
      env: { LANG: 'C', LC_ALL: 'C' }, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  } catch (e) { throw e; }
  let closeResolve!: () => void;
  const closed = new Promise<void>(resolve => { closeResolve = resolve; });
  const finish = (status: 'completed' | 'failed' | 'indeterminate') => {
    if (finished) return;
    finished=true;
    try{lifecycle.finish(status);terminal=status;}
    catch(error){terminal='indeterminate';throw error;}
  };
  let stopping: Promise<void> | undefined;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = (): Promise<void> => stopping ??= (async () => {
    stopped = true; clearInterval(poll); signal?.removeEventListener('abort', abort);
    rpc.close(); incoming.destroy(); outgoing.destroy();
    await tunnel.stop();
    if (p.connected) p.send('stop', () => {});
    cleanupTimer = setTimeout(() => { failure ??= new Error('Native supervisor cleanup indeterminate'); p.kill('SIGKILL'); }, 2000);
    await closed; clearTimeout(cleanupTimer);
    if (!reaped) { finish('indeterminate'); throw new Error('Native supervisor cleanup indeterminate'); }
    try { lifecycle.checkActive(); verifyNativeLaunchPlan(plan); }
    catch { failure ??= new Error('Native authority invalid at settlement'); }
    finish(failure ? 'failed' : 'completed');
  })();
  stopLaunched=stop;
  const fail = (e: Error) => { failure ??= e; void stop().catch(() => {}); };
  const abort = () => fail(new Error('Native launch cancelled'));
  const listeners = new Set<(bytes: number) => void>();
  let bytes = 0;
  const meter = () => new Transform({ transform(chunk: Buffer, _encoding, callback) {
    try {
      check(); bytes += chunk.length;
      if (bytes > plan.maxWireBytes) throw new Error('Native wire budget exhausted');
      listeners.forEach(listener => listener(chunk.length)); callback(null, chunk);
    } catch (e) { fail(e as Error); callback(e as Error); }
  } });
  const incoming = meter(), outgoing = meter();
  p.stdout!.pipe(incoming); outgoing.pipe(p.stdin!);
  p.stderr!.resume(); p.stdin!.on('error', () => fail(new Error('Native input disconnected')));
  incoming.on('error', () => {}); outgoing.on('error', () => {});
  const rpc = new JsonlRpc(incoming, outgoing, { timeoutMs: 10000, maxLineBytes: 1048576, maxTotalBytes: plan.maxWireBytes });
  rpc.onFailure(error => { if (!stopped) fail(error); });
  const poll = setInterval(() => { try { check(); } catch { fail(new Error('Native authority or pinned runtime drift')); } }, 25);
  signal?.addEventListener('abort', abort, { once: true });
  p.on('error', () => fail(new Error('Native supervisor failed')));
  p.on('close', () => { closeResolve(); if (!stopped) fail(new Error('Native process disconnected')); });
  let startedResolve!: () => void, startedReject!: (error: Error) => void;
  const started = new Promise<void>((resolve, reject) => { startedResolve = resolve; startedReject = reject; });
  p.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object') return;
    const m = message as Record<string, unknown>;
    if (m.type === 'started') startedResolve();
    if (m.type === 'reaped') { reaped = m.confirmed === true; if (!stopped) startedReject(new Error('Native process ended during launch')); }
  });
  p.once('close', () => startedReject(new Error('Native launch failed')));
  const startDeadline = setTimeout(() => startedReject(new Error('Native launch handshake timed out')), 5000);
  try {
    check();
    p.send({ executable: plan.executable.path, profile: plan.profile, home: plan.privateHome,
      tmp: plan.privateTmp, port: tunnel.port, accessToken: request.accessToken,
      deadlineEpochMs: plan.deadlineEpochMs, maxWireBytes: plan.maxWireBytes });
    await started; check();
  } catch (e) { failure ??= e as Error; await stop().catch(() => {}); throw e; }
  finally { clearTimeout(startDeadline); }
  const nativeRpc: NativeRpc = {
    request: (method, params, result) => { check(); return rpc.request(method, params, result); },
    notify: (method, params) => { check(); return rpc.notify(method, params); },
    onRequest: handler => rpc.onRequest(handler), onNotification: listener => rpc.onNotification(listener),
    onFailure: listener => rpc.onFailure(listener),
    onWire: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    close: () => { void stop().catch(() => {}); },
  };
  const value = Object.freeze({ rpc: nativeRpc, qualification: 'native-seatbelt' as const,
    runtimeBinding: plan.runtimeBinding, receiptId: lifecycle.receiptId,
    qualificationEvidence: Object.freeze({ runtimeBinding: plan.runtimeBinding, executableDigest: plan.executable.digest,
      profileDigest: createHash('sha256').update(plan.profile).digest('hex') }),
    assertActive: () => { if (stopped) throw new Error('Native process stopped'); check(); },
    assertCompleted:()=>{
      if(!stopped||!reaped||!finished||terminal!=='completed')throw new Error('Native runtime settlement not completed');
      verifyNativeLaunchPlan(plan);
    },stop });
  trusted.add(value); return value;
  }catch(error){
    let status:'failed'|'indeterminate'='failed';
    if(stopLaunched){try{await stopLaunched();}catch{status='indeterminate';}}
    else if(startupTunnel){try{await startupTunnel.stop();}catch{status='indeterminate';}}
    // The shared guard preserves any terminal status already recorded by stop().
    lifecycle.finish(status);
    throw error;
  }
}
