import type { NativePacketReason } from './native-packet.js';
import { execFile } from 'node:child_process';
import { accessSync, constants, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { NativeTask } from './native-executor-contracts.js';
import { validateBudget } from './native-executor-contracts.js';
import { validateNativeTask } from './native-task-validation.js';
import { sourceIdentity } from './repository.js';

export type NativePreflightCode = NativePacketReason | 'task-invalid' | 'budget-invalid' | 'source-unavailable' |
  'source-drift' | 'objective-invalid' | 'objective-too-large' | 'run-directory-private' |
  'run-directory-in-project' | 'codex-path-invalid' | 'codex-version-invalid' | 'codex-version-failed';
export interface NativePreflightOptions {
  task: NativeTask;
  objective: string;
  codexExecutable: string;
  runDirectory?: string;
}
export interface NativePreflightReport {
  readonly schema: 'native-preflight-v1';
  readonly ready: boolean;
  readonly source: string | null;
  readonly checks: readonly Readonly<{id: string; status: 'passed' | 'failed' | 'skipped'}>[];
  readonly issues: readonly Readonly<{code: NativePreflightCode}>[];
}
function canonical(path: string): boolean {
  return typeof path==='string'&&isAbsolute(path)&&resolve(path)===path&&!/[\0\r\n]/.test(path);
}
function privateRunDirectory(path: string, root: string): NativePreflightCode | null {
  if(!canonical(path))return 'run-directory-private';
  try {
    let target=path;
    try {lstatSync(path);} catch(error) {
      if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
      target=dirname(path); // Only the final leaf may be absent.
    }
    const stat=lstatSync(target);
    if(realpathSync(target)!==target||!stat.isDirectory()||stat.uid!==process.getuid?.()||stat.mode&0o077)
      return 'run-directory-private';
    const outside=relative(root,path);
    return outside==='..'||outside.startsWith('..'+sep)?null:'run-directory-in-project';
  } catch {return 'run-directory-private';}
}
function executablePath(path: string): boolean {
  if(!canonical(path))return false;
  try {
    if(realpathSync(path)!==path||!lstatSync(path).isFile())return false;
    accessSync(path,constants.X_OK);return true;
  } catch {return false;}
}
/** A version probe only. No inherited credentials, account home, stdin, shell,
 * project config, provider call, state creation or retry is permitted here. */
function version(path: string): Promise<NativePreflightCode | null> {
  return new Promise(resolveResult=>{
    const child=execFile(path,['--version'],{encoding:'utf8',timeout:5000,killSignal:'SIGKILL',
      maxBuffer:4096,cwd:dirname(path),windowsHide:true,
      env:{HOME:'/dev/null',CODEX_HOME:'/dev/null',TMPDIR:'/dev/null',LANG:'C'}},
    (error,stdout)=>resolveResult(error?'codex-version-failed':
      stdout.trim()==='codex-cli 0.162.1'?null:'codex-version-invalid'));
    child.stdin?.end();
  });
}
/** Diagnostic facts only. The report is never a launch plan, grant, session,
 * lifecycle receipt or authority; execution must repeat owner enforcement. */
export async function preflightNativeTask(options: NativePreflightOptions): Promise<NativePreflightReport> {
  const checks: {id:string;status:'passed'|'failed'|'skipped'}[]=[];
  const issues: {code:NativePreflightCode}[]=[];
  let source: string | null=null;
  const record=(id:string,code:NativePreflightCode|null)=>{
    checks.push({id,status:code?'failed':'passed'});if(code)issues.push({code});
  };
  let taskValid=true;
  try {validateBudget(options.task?.budget);} catch {taskValid=false;record('budget','budget-invalid');}
  if(taskValid)record('budget',null);
  try {validateNativeTask(options.task);} catch {taskValid=false;record('task','task-invalid');}
  if(!checks.some(c=>c.id==='task'))record('task',null);
  if(taskValid){
    try {source=sourceIdentity(options.task.root);record('source',source===options.task.source?null:'source-drift');}
    catch {record('source','source-unavailable');}
  } else checks.push({id:'source',status:'skipped'});
  const objective=options.objective;
  record('objective',typeof objective!=='string'||!objective.trim()?'objective-invalid':
    taskValid&&Buffer.byteLength(objective,'utf8')>options.task.budget.inputBytes?'objective-too-large':null);
  if(options.runDirectory!==undefined){
    if(taskValid)record('run-directory',privateRunDirectory(options.runDirectory,options.task.root));
    else checks.push({id:'run-directory',status:'skipped'});
  }
  record('codex-path',executablePath(options.codexExecutable)?null:'codex-path-invalid');
  // Reject invalid local input before invoking even the offline version probe.
  if(!issues.length){
    record('codex-version',await version(options.codexExecutable));
    try{source=sourceIdentity(options.task.root);record('source-after-probe',source===options.task.source?null:'source-drift');}
    catch{record('source-after-probe','source-unavailable');}
  }else checks.push({id:'codex-version',status:'skipped'});
  return Object.freeze({schema:'native-preflight-v1' as const,ready:!issues.length,source,
    checks:Object.freeze(checks.map(c=>Object.freeze(c))),issues:Object.freeze(issues.map(i=>Object.freeze(i)))});
}

const preflightFailures=new WeakMap<object,NativePreflightReport>();
export class NativePreflightError extends Error {
  constructor(report:NativePreflightReport){super('Native preflight failed');preflightFailures.set(this,report);}
}
export function nativePreflightReport(error:unknown):NativePreflightReport|null {
  return error!==null&&(typeof error==='object'||typeof error==='function')?preflightFailures.get(error)??null:null;
}
