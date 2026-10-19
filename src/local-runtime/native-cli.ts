import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { openChatGPTPlanSession } from '../live-workflow/chatgpt-plan.js';
import { runNativeTask, nativeRunErrorDetails, nativeTaskContext } from '../live-workflow/native-executor-run.js';
import { loadNativePacket, nativePacketReason, NATIVE_PACKET_MAX_BYTES } from '../live-workflow/native-packet.js';
import { preflightNativeTask, NativePreflightError, nativePreflightReport } from '../live-workflow/native-preflight.js';
import type { NativePreflightReport } from '../live-workflow/native-preflight.js';
import { runManagedNativeWorker } from '../live-workflow/native-managed-launch.js';
export { loadNativePacket, encodeNativePacket, NATIVE_PACKET_MAX_BYTES } from '../live-workflow/native-packet.js';

export function parseNativeArguments(argv: readonly string[]) {
  if(argv.length===1&&argv[0]==='--help')return null;
  const values:Record<string,string>=Object.create(null),allowed=['--packet','--connection','--codex','--state'];
  for(let i=0;i<argv.length;){
    const key=argv[i++]!;
    if(key==='--preflight'){
      if(key in values)throw new Error('Duplicate native preflight flag');values[key]='true';continue;
    }
    const value=argv[i++];
    if(!allowed.includes(key)||key in values||!value||!isAbsolute(value)||resolve(value)!==value||/[\0\r\n]/.test(value))throw new Error('Exact native owner paths required');
    values[key]=value;
  }
  if(allowed.some(key=>!values[key]))throw new Error('Packet, connection, codex and state paths required');
  return values;
}
async function inspect(args:Record<string,string>,expected?:{fileDigest:string;parentBinding:string}){
  let loaded:ReturnType<typeof loadNativePacket>;
  try{loaded=loadNativePacket(args['--packet']!,args['--state']!,expected);}
  catch(error){
    const report:NativePreflightReport=Object.freeze({schema:'native-preflight-v1',ready:false,source:null,
      checks:Object.freeze([Object.freeze({id:'packet',status:'failed' as const})]),
      issues:Object.freeze([Object.freeze({code:nativePacketReason(error)??'task-invalid'})])});
    return {report,loaded:null};
  }
  const base=await preflightNativeTask({task:loaded.packet.task,objective:loaded.packet.objective,
    codexExecutable:args['--codex']!,runDirectory:args['--state']!});
  const assembled=base.ready?nativeTaskContext(loaded.packet.task,loaded.packet.objective):null;
  const oversized=assembled!==null&&Buffer.byteLength(assembled,'utf8')>loaded.packet.task.budget.inputBytes;
  const report=Object.freeze({...base,ready:base.ready&&!oversized,
    checks:Object.freeze([Object.freeze({id:'packet',status:'passed' as const}),...base.checks,
      ...(oversized?[Object.freeze({id:'assembled-input',status:'failed' as const})]:[])]),
    issues:Object.freeze([...base.issues,...(oversized?[Object.freeze({code:'objective-too-large' as const})]:[])]),
    packet:Object.freeze({maximumBytes:NATIVE_PACKET_MAX_BYTES})});
  return {report,loaded};
}
export function writeNativeCliFailure(error:unknown):void{
  const failure=nativeRunErrorDetails(error),report=nativePreflightReport(error),reason=nativePacketReason(error);
  const result=failure?{status:'stopped',...failure}:{status:'blocked',phase:'preflight',
    code:'owner-input-or-account-required',...(report?{preflight:report}:{}),...(reason?{reason}:{})};
  process.stderr.write(JSON.stringify(result)+'\n');process.exitCode=2;
}
/** Maintained owner entry point. --preflight is offline and creates no run state. */
export async function nativeMain(argv=process.argv.slice(2)):Promise<void>{
  const args=parseNativeArguments(argv);
  if(!args){process.stdout.write('node dist/src/local-runtime/native-cli.js [--preflight] --packet /absolute/owner-packet.json --connection /private/account --codex /absolute/codex --state /private/run\n');return;}
  const offline=args['--preflight']==='true';
  if(!offline&&(!process.stdin.isTTY||!process.stdout.isTTY))throw new Error('Native execution requires the owner terminal');
  const {report,loaded}=await inspect(args);
  if(offline){process.stdout.write(JSON.stringify(report,null,2)+'\n');if(!report.ready)process.exitCode=2;return;}
  if(!report.ready||!loaded)throw new NativePreflightError(report);
  const controller=new AbortController(),abort=()=>controller.abort();
  process.once('SIGINT',abort);process.once('SIGTERM',abort);
  try{
    const result=await runManagedNativeWorker({task:loaded.packet.task,runDirectory:args['--state']!,parentBinding:loaded.parentBinding,packetDigest:loaded.fileDigest,
      packetPath:args['--packet']!,connection:args['--connection']!,codexExecutable:args['--codex']!,
      workerPath:fileURLToPath(new URL('./native-worker-cli.js',import.meta.url)),signal:controller.signal});
    process.exitCode=result.exitCode;
  }finally{process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);}
}
export function parseNativeWorkerArguments(argv:readonly string[]){
  const tail=argv.slice(-4),fileDigest=tail[1],parentBinding=tail[3];
  if(tail[0]!=='--expected-packet-digest'||tail[2]!=='--expected-parent-binding'||
    !fileDigest||!/^[a-f0-9]{64}$/.test(fileDigest)||!parentBinding||!/^[a-f0-9]{64}$/.test(parentBinding))
    throw new Error('Exact native parent handoff required');
  const args=parseNativeArguments(argv.slice(0,-4));
  if(!args||args['--preflight'])throw new Error('Native worker requires a run');
  return {args,expected:{fileDigest,parentBinding}};
}
/** Internal fixed worker, invoked by the managed owner launcher under its PTY. */
export async function nativeWorkerMain(argv=process.argv.slice(2)):Promise<void>{
  const {args,expected}=parseNativeWorkerArguments(argv);
  const {report,loaded}=await inspect(args,expected);if(!report.ready||!loaded)throw new NativePreflightError(report);
  if(!process.stdin.isTTY||!process.stdout.isTTY)throw new Error('Native execution requires the owner terminal');
  const {packet,path,parentBinding}=loaded;
  const controller=new AbortController(),abort=()=>controller.abort();
  process.once('SIGINT',abort);process.once('SIGTERM',abort);
  const terminal=createInterface({input:process.stdin,output:process.stderr});
  const check=()=>{controller.signal.throwIfAborted();loadNativePacket(path,args['--state']!,expected);};
  try{
    const session=await openChatGPTPlanSession(args['--connection']!,{isTTY:true,confirm:prompt=>terminal.question(prompt,{signal:controller.signal})});
    const result=await runNativeTask({task:packet.task,objective:packet.objective,runDirectory:args['--state']!,codexExecutable:args['--codex']!,session,parent:{binding:parentBinding,check},signal:controller.signal});
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
  }finally{terminal.close();process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);}
}
if(process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url))nativeMain().catch(writeNativeCliFailure);
