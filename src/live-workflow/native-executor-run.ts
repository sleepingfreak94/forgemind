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
import { NativeExecutor, nativeProviderDiagnostic } from './native-executor.js';
import type { NativeProviderDiagnostic } from './native-executor.js';
import { createProductionNativeHost, assertNativeHost, assertNativeHostCompleted,nativeHostCleanupEvidence } from './native-executor-host.js';
import type { NativeHost } from './native-executor-host.js';
import { nativeReadiness } from './native-executor-readiness.js';
import { prepareNativeLaunchPlan, nativeConfiguration } from './native-executor-launch-contracts.js';
import { runChecks } from './checks.js';
import { validateBudget } from './native-executor-contracts.js';
import type { NativeTask } from './native-executor-contracts.js';

export interface NativeRunOptions {
  task: NativeTask;
  objective: string;
  runDirectory: string;
  codexExecutable: string;
  session: ChatGPTPlanSession;
  parent: { binding: string; check(): void };
  signal: AbortSignal;
}
export function validateNativeTask(task: NativeTask): void {
  validateBudget(task.budget);
  if (task.model!=='gpt-6.1-sol'||!['medium','high'].includes(task.effort)||
      !/^[a-f0-9]{64}$/.test(task.source)||!task.project||!task.task||task.root!==realpathSync(task.root)) throw new Error('Invalid native task identity');
  for(const paths of [task.readPaths,task.writePaths]){
    if(!Array.isArray(paths)||new Set(paths).size!==paths.length)throw new Error('Exact native paths required');
    paths.forEach(sourcePath);
  }
  if(!Array.isArray(task.checks)||!task.checks.length||new Set(task.checks.map(c=>c.id)).size!==task.checks.length)throw new Error('Predefined native checks required');
  for(const check of task.checks){
    if(!check.id||check.executable!==realpathSync(check.executable)||!Array.isArray(check.args)||check.args.some(a=>typeof a!=='string'||a.includes('\0'))||!Number.isSafeInteger(check.timeoutMs)||check.timeoutMs<1||check.timeoutMs>30000)throw new Error('Invalid native check');
  }
}
/** Callable owner pipeline. Each invocation runs one owner-requested turn, with
 * persisted uncapped turn counters and no automatic inference/tool replay. */
export async function runNativeTask(options: NativeRunOptions) {
  const {task,session,signal,parent}=options;
  validateNativeTask(task);assertChatGPTPlanSession(session);signal.throwIfAborted();parent.check();
  if(!/^[a-f0-9]{64}$/.test(parent.binding))throw new Error('Exact native parent binding required');
  if(typeof options.objective!=='string'||!options.objective.trim())throw new Error('Native objective required');
  if(sourceIdentity(task.root)!==task.source)throw new Error('Stale native run source');
  const dir=privateDirectory(options.runDirectory),rel=relative(task.root,dir);
  if(!(rel==='..'||rel.startsWith('..'+sep)))throw new Error('Native run state must be outside project');
  const state=new NativeState(join(dir,'checkpoint'),task,parent.binding);
  const active=()=>{signal.throwIfAborted();parent.check();};
  const remaining=task.budget.runtimeMs-state.value.counters.runtimeMs;
  if(remaining<1){state.close();throw new Error('Native runtime exhausted');}
  let phase='authentication';
  let execution:ChatGPTExecutionLease|undefined,cleanup:ReturnType<typeof nativeCleanupEvidence>=null;
  let owner:NativeOwner|undefined,lifecycle:NativeLifecycle|undefined,host:NativeHost|undefined,executor:NativeExecutor|undefined;
  try{
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
        const result=await runChecks(task.root,state.value.source,[command],scratch,owner!,checkSignal);
        project.assertCurrent(state.value.source);return result[0];
      }});
    const readiness=nativeReadiness(host,'live',true);
    if(!readiness.ready)throw new Error('Native production host not ready');
    phase='native-turn';
    executor=new NativeExecutor(task,state,host);
    await executor.turn(nativeTaskContext(task,options.objective),signal);
    project.assertCurrent(state.value.source);active();
    phase='verification';
    const checks=await runChecks(task.root,state.value.source,task.checks,scratch,owner,signal);
    project.assertCurrent(state.value.source);active();
    if(checks.some(check=>!check.passed))throw new Error('Native task verification failed');
    const native=executor.receipt;
    phase='cleanup';
    const settledHost=host;
    await executor.close();cleanup=nativeHostCleanupEvidence(settledHost);executor=undefined;host=undefined;
    if(state.value.status==='indeterminate')throw new Error('Native cleanup indeterminate');
    assertNativeRunCompleted({active,account:()=>session.assertActive(),source:()=>project.assertCurrent(state.value.source),
      runtime:()=>{assertNativeHostCompleted(settledHost);lifecycle!.assertCompleted(receipt);}});
    execution.settle('completed',cleanup);
    return {taskId:task.task,status:'completed',source:state.value.source,readiness,checks,
      executionLease:execution.receipt(),native:{...native,checkpoint:state.value},owner:owner.export(),runtime:lifecycle.export()};
  }catch(error){
    const diagnostic=nativeProviderDiagnostic(error) ?? executor?.receipt.nativeDiagnostic ?? null;
    if(executor){
      try{await executor.close();}catch{state.update({status:'indeterminate'});}
      if(host)cleanup=nativeHostCleanupEvidence(host);
      executor=undefined;host=undefined;
    }else if(host){
      try{await host.stop();}catch{state.update({status:'indeterminate'});}
      cleanup=nativeHostCleanupEvidence(host);
      host=undefined;
    }
    if(execution){try{execution.settle('failed',cleanup??nativeCleanupEvidence(error));}catch{execution.retainIndeterminate();state.update({status:'indeterminate'});}}
    if(state.value.pending)state.update({status:'indeterminate'});
    throw new NativeRunError(phase,state.value.status==='indeterminate'?'cleanup-or-effect-indeterminate':signal.aborted?'cancelled':state.value.pending?'pending-effect':nativeFailureCode(error,diagnostic),{checkpoint:state.value,executionLease:execution?.receipt(),owner:owner?.export(),runtime:lifecycle?.export(),nativeDiagnostic:diagnostic});
  }finally{
    if(executor)await executor.close().catch(()=>undefined);else if(host)await host.stop().catch(()=>undefined);
    lifecycle?.close();owner?.close();state.close();
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
export function nativePacketBinding(packet:{schema:string;task:NativeTask;objective:string}):string{
  const {source:_source,...task}=packet.task;
  return sha256(serialize({schema:packet.schema,task,objective:packet.objective}));
}
export function nativeFailureCode(error:unknown,captured:Readonly<NativeProviderDiagnostic>|null=null):string{
  if(error instanceof ChatGPTRefreshDeferred)return error.code;
  const diagnostic=nativeProviderDiagnostic(error)??captured;
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
  const message=error instanceof Error?error.message:'';
  if(/\b(expired|renew(?:ed|al)?|account|session|connection|authority)\b/i.test(message))return 'account-or-authority';
  if(/\b(budget|limit|exhausted)\b/i.test(message))return 'budget-exhausted';
  if(/\b(config(?:uration)?|pin(?:ned)?|runtime|port|sandbox)\b/i.test(message))return 'runtime-unqualified';
  if(/\b(source|drift|preimage|checkpoint)\b/i.test(message))return 'source-or-checkpoint';
  if(/\b(verification|check)\b/i.test(message))return 'verification-failed';
  return 'native-execution-failed';
}
export class NativeRunError extends Error{
  constructor(readonly phase:string,readonly code:string,readonly receipts:unknown){super('Native task '+code+' during '+phase);}
}

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
