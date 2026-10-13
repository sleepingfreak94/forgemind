import { DatabaseSync } from 'node:sqlite';
import { lstatSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { isAbsolute, resolve, relative, sep, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { openChatGPTPlanSession } from '../live-workflow/chatgpt-plan.js';
import { runNativeTask, validateNativeTask, nativePacketBinding, NativeRunError } from '../live-workflow/native-executor-run.js';
import type { NativeTask } from '../live-workflow/native-executor-contracts.js';
import { sha256 } from '../live-workflow/validation.js';

export function parseNativeArguments(argv: readonly string[]) {
  if (argv.length===1&&argv[0]==='--help')return null;
  const values:Record<string,string>=Object.create(null);
  const allowed=['--packet','--connection','--codex','--state'];
  for(let i=0;i<argv.length;i+=2){
    const key=argv[i]!,value=argv[i+1];
    if(!allowed.includes(key)||key in values||!value||!isAbsolute(value)||resolve(value)!==value||/[\0\r\n]/.test(value))throw new Error('Exact native owner paths required');
    values[key]=value;
  }
  if(allowed.some(key=>!values[key]))throw new Error('Packet, connection, codex and state paths required');
  return values;
}
export async function nativeMain(argv=process.argv.slice(2)):Promise<void>{
  const args=parseNativeArguments(argv);
  if(!args){process.stdout.write('node dist/src/local-runtime/native-cli.js --packet /absolute/owner-packet.json --connection /private/account --codex /absolute/codex --state /private/run\n');return;}
  if(!process.stdin.isTTY||!process.stdout.isTTY)throw new Error('Native execution requires the owner terminal');
  const {packet,path,fileDigest,parentBinding}=loadNativePacket(args['--packet']!,args['--state']!);
  const controller=new AbortController(),abort=()=>controller.abort();
  process.once('SIGINT',abort);process.once('SIGTERM',abort);
  const terminal=createInterface({input:process.stdin,output:process.stderr});
  const check=()=>{
    controller.signal.throwIfAborted();
    if(sha256(readFileSync(path))!==fileDigest)throw new Error('Native parent permission packet changed');
  };
  try{
    // Existing account-bound review is reused. A missing review remains an actual
    // owner interaction; this CLI does not synthesize an acknowledgement.
    const session=await openChatGPTPlanSession(args['--connection']!,{isTTY:true,confirm:prompt=>terminal.question(prompt,{signal:controller.signal})});
    const result=await runNativeTask({task:packet.task,objective:packet.objective,runDirectory:args['--state']!,codexExecutable:args['--codex']!,session,parent:{binding:parentBinding,check},signal:controller.signal});
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
  }finally{
    terminal.close();process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);
  }
}
if(process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url)){
  nativeMain().catch(error=>{
    const result=error instanceof NativeRunError?{status:'stopped',phase:error.phase,code:error.code,receipts:error.receipts}:{status:'blocked',phase:'preflight',code:'owner-input-or-account-required'};
    process.stderr.write(JSON.stringify(result)+'\n');process.exitCode=2;
  });
}

export function loadNativePacket(packetPath:string,stateDirectory:string){
  const path=realpathSync(packetPath),stat=lstatSync(path),parent=lstatSync(dirname(path));
  if(path!==packetPath||!stat.isFile()||stat.nlink!==1||stat.size>65536||stat.uid!==process.getuid?.()||stat.mode&0o077||!parent.isDirectory()||parent.uid!==process.getuid?.()||parent.mode&0o077)throw new Error('Owner-private native packet required');
  const raw=readFileSync(path,'utf8'),packet=JSON.parse(raw) as {schema:string;task:NativeTask;objective:string};
  if(packet.schema!=='native-owner-packet-v1'||!packet.task||typeof packet.objective!=='string')throw new Error('Invalid native owner packet');
  validateNativeTask(packet.task);
  const outside=relative(packet.task.root,path);
  if(!(outside==='..'||outside.startsWith('..'+sep)))throw new Error('Native permission packet must be outside worker project');
  const parentBinding=nativePacketBinding(packet),fileDigest=sha256(raw);
  const checkpoint=join(stateDirectory,'checkpoint','native.sqlite');
  if(existsSync(checkpoint)){
    const file=lstatSync(checkpoint);
    if(!file.isFile()||file.nlink!==1||file.isSymbolicLink()||file.uid!==process.getuid?.()||file.mode&0o077)throw new Error('Unsafe native checkpoint');
    const db=new DatabaseSync(checkpoint,{readOnly:true});
    try{
      const row=db.prepare('SELECT value FROM checkpoint WHERE id=1').get();
      const value=row?JSON.parse(String(row.value)):null;
      if(!value||typeof value.source!=='string'||!/^[a-f0-9]{64}$/.test(value.source))throw new Error('Invalid native checkpoint source');
      packet.task.source=value.source;
    }finally{db.close();}
  }
  return{packet,path,fileDigest,parentBinding};
}
