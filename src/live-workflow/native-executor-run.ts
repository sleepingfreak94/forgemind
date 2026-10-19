import { preflightNativeTask, NativePreflightError } from './native-preflight.js';
import { validateNativeTask } from './native-task-validation.js';
export { validateNativeTask, nativePacketBinding } from './native-task-validation.js';
import { beginNativeRunCapture, isNativeCaptureError } from './native-run-capture.js';
import type { NativeRunCapture } from './native-run-capture.js';
import { nativeProviderFailureContext, nativeProviderDiagnostic } from './native-failure-context.js';
import { types } from 'node:util';
import { nativeCheckFailure, nativeFailedCheckFacts } from './native-executor-tools.js';
import { ChatGPTRefreshDeferred } from './chatgpt-execution-ledger.js';
import { nativeCleanupEvidence } from './native-executor-process.js';
import type { ChatGPTExecutionLease } from './chatgpt-execution-leases.js';
import { createServer } from 'node:net';
import { serialize } from '../context-engine/validation.js';
import { mkdirSync, writeFileSync, existsSync, realpathSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { sha256, sourcePath, safePath } from './validation.js';
import { privateDirectory } from './authority.js';
import { sourceIdentity } from './repository.js';
import { assertChatGPTPlanSession } from './chatgpt-plan.js';
import type { ChatGPTPlanSession } from './chatgpt-plan.js';
import { NativeState } from './native-executor-state.js';
import { NativeOwner } from './native-executor-owner.js';
import { NativeProject } from './native-executor-project.js';
import { NativeLifecycle } from './native-executor-lifecycle.js';
import { NativeExecutor, NativeProviderError } from './native-executor.js';
import type { NativeProviderDiagnostic } from './native-executor.js';
import { createProductionNativeHost, assertNativeHost, assertNativeHostCompleted,nativeHostCleanupEvidence } from './native-executor-host.js';
import type { NativeHost } from './native-executor-host.js';
import { nativeReadiness } from './native-executor-readiness.js';
import { prepareNativeLaunchPlan, nativeConfiguration } from './native-executor-launch-contracts.js';
import { runNativeChecks, nativeCheckSummary } from './native-checks.js';
import { validateNativeCheck } from './native-checks-contracts.js';
import { validateBudget } from './native-executor-contracts.js';
import type { NativeTask } from './native-executor-contracts.js';
import type { CheckResult } from './checks.js';
import type { ActionAuthority } from './contracts.js';
import type { NativeCheck } from './native-checks-contracts.js';

const requiredCheckFailures = new WeakSet<object>();
export interface NativeVerificationFacts {
  readonly source: string;
  readonly checks: readonly Readonly<{
    summary: Readonly<CheckResult>;
    summaryDigest: string;
    receiptDigest: string;
  }>[];
}
const verificationFacts = new WeakMap<object, Readonly<NativeVerificationFacts>>();
export interface NativeVerificationCapture { readonly facts: Readonly<NativeVerificationFacts> | null }
type CaptureState = {facts: Readonly<NativeVerificationFacts> | null; used: boolean};
const verificationCaptures = new WeakMap<NativeVerificationCapture, CaptureState>();
export function createNativeVerificationCapture(): NativeVerificationCapture {
  const state: CaptureState = {facts:null, used:false};
  const capture = Object.freeze({get facts() { return state.facts; }});
  verificationCaptures.set(capture,state);
  return capture;
}
export function nativeVerificationFacts(error: unknown, capture?: NativeVerificationCapture): Readonly<NativeVerificationFacts> | null {
  if (capture) {
    const state = verificationCaptures.get(capture);
    if (!state) throw new Error('Unrecognized native verification capture');
    if (state.facts) return state.facts;
  }
  return error !== null && (typeof error === 'object' || typeof error === 'function') ? verificationFacts.get(error) ?? null : null;
}
/** Owner-side results never enter the model tool-output budget. Record only
 * actually settled results, before another command or cleanup can fail. */
export async function runNativeVerification(root: string, source: string, commands: NativeCheck[],
  scratch: string, authority: ActionAuthority, signal: AbortSignal, boundary: () => void,
  capture: NativeVerificationCapture = createNativeVerificationCapture()) {
  const state = verificationCaptures.get(capture);
  if (!state || state.used) throw new Error('Fresh native verification capture required');
  state.used = true;
  try {
    boundary();
    const checks = await runNativeChecks(root, source, commands, scratch, authority, signal, result => {
      const summary = Object.freeze(nativeCheckSummary(result));
      const item = Object.freeze({summary, summaryDigest:sha256(JSON.stringify(summary)), receiptDigest:sha256(JSON.stringify(result))});
      state.facts = Object.freeze({source,checks:Object.freeze([...(state.facts?.checks ?? []),item])});
    });
    boundary();
    if (checks.some(check => !check.passed)) {
      const error = new Error('Native task verification failed');
      requiredCheckFailures.add(error);throw error;
    }
    return checks;
  } catch (error) {
    if (state.facts && error !== null && (typeof error === 'object' || typeof error === 'function')) verificationFacts.set(error,state.facts);
    throw error;
  }
}

export interface NativeRunOptions {
  task: NativeTask;
  objective: string;
  runDirectory: string;
  codexExecutable: string;
  session: ChatGPTPlanSession;
  parent: { binding: string; check(): void };
  signal: AbortSignal;
}
/** Callable owner pipeline. Each invocation runs one owner-requested turn, with
 * persisted uncapped turn counters and no automatic inference/tool replay. */
export async function runNativeTask(options: NativeRunOptions) {
  const {task,session,signal,parent}=options;
  validateNativeTask(task);assertChatGPTPlanSession(session);signal.throwIfAborted();parent.check();
  if(!/^[a-f0-9]{64}$/.test(parent.binding))throw new Error('Exact native parent binding required');
  if(typeof options.objective!=='string'||!options.objective.trim())throw new Error('Native objective required');
  if(sourceIdentity(task.root)!==task.source)throw new Error('Stale native run source');
  const preflight = await preflightNativeTask({task,objective:options.objective,codexExecutable:options.codexExecutable,runDirectory:options.runDirectory});
  if (!preflight.ready) throw new NativePreflightError(preflight);
  const input = nativeTaskContext(task,options.objective);
  if (Buffer.byteLength(input,'utf8') > task.budget.inputBytes) throw new NativePreflightError(Object.freeze({...preflight,ready:false,checks:Object.freeze([...preflight.checks,Object.freeze({id:'assembled-input',status:'failed' as const})]),issues:Object.freeze([...preflight.issues,Object.freeze({code:'objective-too-large' as const})])}));
  const dir=privateDirectory(options.runDirectory),rel=relative(task.root,dir);
  if(!(rel==='..'||rel.startsWith('..'+sep)))throw new Error('Native run state must be outside project');
  const state=new NativeState(join(dir,'checkpoint'),task,parent.binding);
  const active=()=>{signal.throwIfAborted();parent.check();};
  const remaining=task.budget.runtimeMs-state.value.counters.runtimeMs;
  if(remaining<1){state.close();throw new Error('Native runtime exhausted');}
  const verificationCapture=createNativeVerificationCapture();
  let phase='capture';
  let capture:NativeRunCapture|undefined, settledExecutionLease:ReturnType<ChatGPTExecutionLease['receipt']>|undefined;
  let checkpointUncertain=false;
  let execution:ChatGPTExecutionLease|undefined,cleanup:ReturnType<typeof nativeCleanupEvidence>=null;
  let owner:NativeOwner|undefined,lifecycle:NativeLifecycle|undefined,host:NativeHost|undefined,executor:NativeExecutor|undefined;
  try{
    capture=beginNativeRunCapture(task,dir,parent.binding,remaining);
    phase='authentication';
    // Refresh only in the trusted owner before launch. Existing saved same-account
    // credits-off review remains mandatory; there is no native login/import path.
    await session.prepare(Math.min(remaining+5000,930000),signal,active);
    const account=session.binding(),deadline=Math.min(Date.now()+remaining,account.expiresAt-1);
    execution=session.admitExecution({runBinding:parent.binding,deadline,signal,check:active});
    phase='owner-authority';
    owner=new NativeOwner(join(dir,'owner'),task,deadline,active);
    const project=new NativeProject(task.root,owner,(...args)=>owner!.phase(...args),()=>owner!.active());
    lifecycle=new NativeLifecycle(join(dir,'lifecycle'),task,deadline,()=>{active();session.assertActive();},parent.binding);
    const home=privateDirectory(join(dir,'native-home')),tmp=privateDirectory(join(dir,'native-tmp')),scratch=privateDirectory(join(dir,'checks'));
    const config=join(home,'config.toml'),expectedConfig=nativeConfiguration(task.model,task.effort);
    if(existsSync(config)){
      if(readFileSync(config,'utf8')!==expectedConfig)throw new Error('Native config changed; reconcile before resume');
    }else writeFileSync(config,expectedConfig,{flag:'wx',mode:0o600});
    phase='runtime-plan';
    const tunnelPort=await allocateNativePort(active);
    const plan=prepareNativeLaunchPlan({taskId:task.task,grantId:lifecycle.grantId,fencingEpoch:lifecycle.fencingEpoch,
      leaseId:lifecycle.leaseId,model:task.model,effort:task.effort,accountBinding:account.accountSha256,
      reviewBinding:String(account.confirmedAt),authorityBinding:lifecycle.authorityBinding,budgetBinding:lifecycle.budgetBinding,
      grantDigest:lifecycle.grantDigest,executable:options.codexExecutable,config,privateHome:home,privateTmp:tmp,tunnelPort,
      deadlineEpochMs:deadline,maxWireBytes:task.budget.wireBytes-state.value.counters.wireBytes});
    const receipt=lifecycle.reserve(plan);
    phase='native-launch';
    host=await createProductionNativeHost({plan,lifecycle:receipt,session,execution,parentBinding:parent.binding,authority:owner,project,signal,
      boundary:()=>{active();owner!.active();lifecycle!.active();},check:async(id,checkSignal)=>{
        const command=task.checks.find(c=>c.id===id);
        if(!command)throw new Error('Unapproved native check');
        project.assertCurrent(state.value.source);
        const result=await runNativeChecks(task.root,state.value.source,[command],scratch,owner!,checkSignal);
        project.assertCurrent(state.value.source);return nativeCheckSummary(result[0]!);
      }});
    const readiness=nativeReadiness(host,'live',true);
    if(!readiness.ready)throw new Error('Native production host not ready');
    phase='native-turn';
    executor=new NativeExecutor(task,state,host);
    await executor.turn(input,signal);
    project.assertCurrent(state.value.source);active();
    phase='verification';
    const checks=await runNativeVerification(task.root,state.value.source,task.checks,scratch,owner,signal,
      ()=>{project.assertCurrent(state.value.source);active();},verificationCapture);
    const native=executor.receipt;
    phase='cleanup';
    const settledHost=host;
    await executor.close();checkpointUncertain ||= executor.receipt.checkpointUncertain;
    cleanup=nativeHostCleanupEvidence(settledHost);executor=undefined;host=undefined;
    if(state.value.status==='indeterminate')throw new Error('Native cleanup indeterminate');
    assertNativeRunCompleted({active,account:()=>session.assertActive(),source:()=>project.assertCurrent(state.value.source),
      runtime:()=>{assertNativeHostCompleted(settledHost);lifecycle!.assertCompleted(receipt);}});
    execution.settle('completed',cleanup);
    settledExecutionLease=execution.receipt(); execution=undefined;
    const result = {taskId:task.task,status:'completed',source:state.value.source,readiness,checks,
      executionLease:settledExecutionLease,native:{...native,checkpoint:state.value},owner:owner.export(),runtime:lifecycle.export()};
    capture.finish(result);
    return {...result,capture:{directory:capture.directory,status:'accepted' as const}};
  }catch(error){
    const failureContext=nativeProviderFailureContext(error) ?? executor?.failureContext ?? null;
    const diagnostic=safeNativeDiagnostic(error) ?? (safeNativeError(error) ? executor?.receipt.nativeDiagnostic : null) ?? null;
    checkpointUncertain ||= executor?.receipt.checkpointUncertain ?? false;
    let indeterminate=state.value.status==='indeterminate'||checkpointUncertain;
    const uncertain=()=>{
      indeterminate=true;
      try{state.update({status:'indeterminate'});}catch{checkpointUncertain=true;}
    };
    if(executor){
      try{await executor.close();}catch{uncertain();}
      if(executor.receipt.checkpointUncertain){checkpointUncertain=true;indeterminate=true;}
      if(host)cleanup=nativeHostCleanupEvidence(host);
      executor=undefined;host=undefined;
    }else if(host){
      try{await host.stop();}catch{uncertain();}
      cleanup=nativeHostCleanupEvidence(host);
      host=undefined;
    }
    if(execution){try{execution.settle('failed',cleanup??nativeCleanupEvidence(error));}catch{execution.retainIndeterminate();uncertain();}}
    if(state.value.pending)uncertain();
    const code=nativeRunFailureCode(error,indeterminate?'indeterminate':state.value.status,signal.aborted,state.value.pending,diagnostic);
    const receipts={checkpoint:state.value,checkpointUncertain,executionLease:execution?.receipt()??settledExecutionLease,owner:owner?.export(),runtime:lifecycle?.export(),nativeDiagnostic:diagnostic,checks:nativeFailedCheckFacts(error),verificationChecks:nativeVerificationFacts(error,verificationCapture),failureContext};
    let captureStatus:'accepted'|'incomplete'='incomplete';
    if(capture){try{capture.finish({status:'stopped',phase,code,receipts},{phase,code});captureStatus='accepted';}catch{/* Preserve the primary failure and incomplete capture. */}}
    throw new NativeRunError(phase,code,{...receipts,...(capture?{capture:{directory:capture.directory,status:captureStatus}}:{})});
  }finally{
    if(executor)await executor.close().catch(()=>undefined);else if(host)await host.stop().catch(()=>undefined);
    capture?.close();lifecycle?.close();owner?.close();state.close();
  }
}

/** Allocate an owner-controlled candidate port before sealing the runtime plan.
 * A bind race at subsequent launch fails closed; no alternate-port fallback. */
export async function allocateNativePort(check:()=>void):Promise<number>{
  check();const server=createServer();
  const port=await new Promise<number>((resolve,reject)=>{
    server.once('error',reject);server.listen(0,'127.0.0.1',()=>{
      const address=server.address();
      if(!address||typeof address==='string'){server.close();reject(new Error('Native port allocation failed'));return;}
      resolve(address.port);
    });
  });
  await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  check();return port;
}
// Reject proxies before prototype/descriptor inspection, including proxies in an
// otherwise native Error's prototype chain. No caught getters or coercions run.
function safeNativeError(error:unknown):error is Error{
  if(types.isProxy(error)||!types.isNativeError(error))return false;
  let prototype:object|null=error as object;
  for(let depth=0;prototype&&depth<32;depth++){
    if(types.isProxy(prototype))return false;
    prototype=Object.getPrototypeOf(prototype) as object|null;
  }
  return prototype===null;
}
function data(value:object,key:string):unknown{
  const descriptor=Object.getOwnPropertyDescriptor(value,key);
  return descriptor&&'value' in descriptor?descriptor.value:undefined;
}
function safeDiagnostic(value:unknown):Readonly<NativeProviderDiagnostic>|null{
  if(!value||typeof value!=='object'||types.isProxy(value))return null;
  const kind=data(value,'kind'),httpStatusCode=data(value,'httpStatusCode'),willRetry=data(value,'willRetry');
  if(typeof kind!=='string'||!(httpStatusCode===null||Number.isSafeInteger(httpStatusCode))||
      !(willRetry===null||typeof willRetry==='boolean'))return null;
  return Object.freeze({kind:kind as NativeProviderDiagnostic['kind'],httpStatusCode:httpStatusCode as number|null,willRetry});
}
function safeNativeDiagnostic(error:unknown):Readonly<NativeProviderDiagnostic>|null{
  return nativeProviderDiagnostic(error);
}
export function nativeRunFailureCode(error:unknown,status:string,cancelled:boolean,pending:string|null,
  diagnostic:Readonly<NativeProviderDiagnostic>|null=null):string{
  return status==='indeterminate'?'cleanup-or-effect-indeterminate':cancelled?'cancelled':
    pending?'pending-effect':nativeFailureCode(error,diagnostic);
}
export function nativeFailureCode(error:unknown,captured:Readonly<NativeProviderDiagnostic>|null=null):string{
  if(isNativeCaptureError(error))return 'native-capture-unavailable';
  if(nativeCheckFailure(error)||(error!==null&&typeof error==='object'&&requiredCheckFailures.has(error)))return 'verification-failed';
  const safe=safeNativeError(error);
  if(safe&&error instanceof ChatGPTRefreshDeferred){
    const code=data(error,'code');if(typeof code==='string')return code;
  }
  const diagnostic=safeNativeDiagnostic(error)??safeDiagnostic(captured);
  if(diagnostic){
    if(diagnostic.kind==='unauthorized'||diagnostic.httpStatusCode===401||diagnostic.httpStatusCode===403)return 'native-provider-unauthorized';
    if(diagnostic.kind==='rateLimitExceeded'||diagnostic.httpStatusCode===429)return 'native-provider-rate-limit';
    if(['usageLimitExceeded','sessionBudgetExceeded'].includes(diagnostic.kind))return 'native-provider-quota';
    if(['httpConnectionFailed','responseStreamConnectionFailed','responseStreamDisconnected','responseTooManyFailedAttempts'].includes(diagnostic.kind))return 'native-provider-transport';
    if(['cyberPolicy','misalignmentPolicyViolation','tooManyDenials','sandboxError'].includes(diagnostic.kind))return 'native-provider-policy';
    return 'native-provider-error';
  }
  // These messages are host-authored; whole tokens avoid reported/unsupported
  // accidentally matching port. Remote messages are never passed to this path.
  const ownMessage=safe?data(error,'message'):undefined;
  const message=typeof ownMessage==='string'?ownMessage:'';
  if(/\b(expired|renew(?:ed|al)?|account|session|connection|authority)\b/i.test(message))return 'account-or-authority';
  if(/\b(budget|limit|exhausted)\b/i.test(message))return 'budget-exhausted';
  if(/\b(config(?:uration)?|pin(?:ned)?|runtime|port|sandbox)\b/i.test(message))return 'runtime-unqualified';
  if(/\b(source|drift|preimage|checkpoint)\b/i.test(message))return 'source-or-checkpoint';
  return 'native-execution-failed';
}
const nativeRunErrors=new WeakMap<object,Readonly<{phase:string;code:string;receipts:unknown}>>();
export class NativeRunError extends Error{
  constructor(readonly phase:string,readonly code:string,readonly receipts:unknown){super('Native task '+code+' during '+phase);nativeRunErrors.set(this,Object.freeze({phase,code,receipts}));}
}
export function nativeRunErrorDetails(error:unknown){return error!==null&&(typeof error==='object'||typeof error==='function')?nativeRunErrors.get(error)??null:null;}

/** Explicitly offline conformance runner for the same durable state/turn path.
 * It never accepts a production host or authenticates an account. */
export async function runOfflineNativeTask(options:Omit<NativeRunOptions,'session'|'codexExecutable'> & {host:NativeHost}){
  assertNativeHost(options.host);
  if(options.host.qualification!=='offline-fixture')throw new Error('Offline fixture host required');
  validateNativeTask(options.task);options.parent.check();options.signal.throwIfAborted();
  const state=new NativeState(join(options.runDirectory,'checkpoint'),options.task,options.parent.binding);
  const executor=new NativeExecutor(options.task,state,options.host);
  try{
    await executor.turn(options.objective,options.signal);options.parent.check();
    const receipt=executor.receipt;
    await executor.close();
    if(state.value.status==='indeterminate')throw new Error('Offline cleanup indeterminate');
    return{...receipt,checkpoint:state.value};
  }finally{await executor.close();state.close();}
}

/** Return-boundary checks happen after confirmed cleanup, independently of the
 * turn's earlier acceptance. A reaped process can still have failed authority. */
export function assertNativeRunCompleted(checks:{active:()=>void;account:()=>void;source:()=>void;runtime:()=>void}):void{
  checks.active();checks.account();checks.source();checks.runtime();checks.active();
}

export function nativeTaskContext(task:NativeTask,objective:string):string{
  return ['ForgeMind owner task context (permissions are enforced by the host):',
    'Call one host tool at a time; wait for its result before the next call.',
    'Exact read paths: '+JSON.stringify(task.readPaths),
    'Exact write paths: '+JSON.stringify(task.writePaths),
    'Predefined check IDs: '+JSON.stringify(task.checks.map(check=>check.id)),
    'Initially absent owner write paths: '+JSON.stringify(task.writePaths.filter(path=>!existsSync(safePath(task.root,path,true)))),
    'Use host_read to obtain current content and sha256 for existing files. For a new owner-declared absent file use beforeSha256:null; do not host_read nonexistent files.',
    'host_apply arguments: {summary,edits:[{path,beforeSha256,content}]}; content is the complete replacement text or null for deletion.',
    'Use host_check with {id}. No other paths, commands or tools are authorized.',
    'Objective:',objective].join('\n');
}
