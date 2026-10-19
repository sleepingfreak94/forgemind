import { DatabaseSync } from 'node:sqlite';
import { constants, closeSync, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { NativeTask } from './native-executor-contracts.js';
import { validateNativeTask, nativePacketBinding } from './native-task-validation.js';
import { sha256 } from './validation.js';

export const NATIVE_PACKET_MAX_BYTES = 65536;
export interface NativeOwnerPacket {
  schema: 'native-owner-packet-v1';
  task: NativeTask;
  objective: string;
}
export type NativePacketReason = 'packet-too-large' | 'packet-private' | 'packet-invalid' |
  'packet-task-invalid' | 'packet-changed' | 'packet-in-project' | 'checkpoint-private' | 'checkpoint-invalid';
/** Fixed local codes only: never reflect input, filesystem or remote errors. */
const packetReasons=new WeakMap<object,NativePacketReason>();
export function nativePacketReason(error:unknown):NativePacketReason|null{return error!==null&&(typeof error==='object'||typeof error==='function')?packetReasons.get(error)??null:null;}
export class NativePacketError extends Error {
  readonly code: NativePacketReason;
  constructor(readonly reason: NativePacketReason) {
    super(reason==='packet-private'?'Owner-private native packet required':reason==='packet-in-project'?'Native permission packet must be outside worker project':'Native packet rejected: '+reason);
    packetReasons.set(this,reason);
    this.name='NativePacketError';this.code=reason;
  }
}
export function encodeNativePacket(task: NativeTask, objective: string): string {
  let raw: string;
  try {
    validateNativeTask(task);
    if(typeof objective!=='string'||!objective.trim())throw new NativePacketError('packet-invalid');
    const packet: NativeOwnerPacket={schema:'native-owner-packet-v1',task,objective};
    raw=JSON.stringify(packet,null,2)+'\n';
  } catch(error) {
    if(error instanceof NativePacketError)throw error;
    throw new NativePacketError('packet-task-invalid');
  }
  if(Buffer.byteLength(raw,'utf8')>NATIVE_PACKET_MAX_BYTES)throw new NativePacketError('packet-too-large');
  return raw;
}
/** Bounded read rejects oversize before JSON parsing or any account operation. */
function readPacket(path: string): string {
  let fd: number | undefined;
  try {
    const canonical=realpathSync(path),stat=lstatSync(canonical),parent=lstatSync(dirname(canonical));
    if(stat.size>NATIVE_PACKET_MAX_BYTES)throw new NativePacketError('packet-too-large');
    if(canonical!==path||!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid?.()||
       stat.mode&0o077||!parent.isDirectory()||parent.uid!==process.getuid?.()||parent.mode&0o077)
      throw new NativePacketError('packet-private');
    fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    const opened=fstatSync(fd);
    if(opened.dev!==stat.dev||opened.ino!==stat.ino)throw new NativePacketError('packet-private');
    const buffer=Buffer.alloc(NATIVE_PACKET_MAX_BYTES+1);
    let length=0,chunk=0;
    do {chunk=readSync(fd,buffer,length,buffer.length-length,null);length+=chunk;} while(chunk&&length<buffer.length);
    if(length>NATIVE_PACKET_MAX_BYTES)throw new NativePacketError('packet-too-large');
    const bytes=buffer.subarray(0,length),raw=bytes.toString('utf8');
    if(!Buffer.from(raw,'utf8').equals(bytes))throw new NativePacketError('packet-invalid');
    return raw;
  } catch(error) {
    if(error instanceof NativePacketError)throw error;
    throw new NativePacketError('packet-private');
  } finally {if(fd!==undefined)closeSync(fd);}
}
export function loadNativePacket(packetPath: string, stateDirectory: string, expected?: {fileDigest: string; parentBinding: string}) {
  const raw=readPacket(packetPath);
  if(expected&&(!/^[a-f0-9]{64}$/.test(expected.fileDigest)||sha256(raw)!==expected.fileDigest))throw new NativePacketError('packet-changed');
  let packet: NativeOwnerPacket;
  try {
    packet=JSON.parse(raw) as NativeOwnerPacket;
    if(!packet||packet.schema!=='native-owner-packet-v1'||!packet.task||typeof packet.objective!=='string')
      throw new Error();
  } catch {throw new NativePacketError('packet-invalid');}
  try {validateNativeTask(packet.task);} catch {throw new NativePacketError('packet-task-invalid');}
  const outside=relative(packet.task.root,packetPath);
  if(!(outside==='..'||outside.startsWith('..'+sep)))throw new NativePacketError('packet-in-project');
  const parentBinding=nativePacketBinding(packet),fileDigest=sha256(raw);
  if(expected&&(!/^[a-f0-9]{64}$/.test(expected.parentBinding)||parentBinding!==expected.parentBinding))throw new NativePacketError('packet-changed');
  const checkpoint=join(stateDirectory,'checkpoint','native.sqlite');
  if(existsSync(checkpoint)){
    try {
      const file=lstatSync(checkpoint);
      if(!file.isFile()||file.nlink!==1||file.isSymbolicLink()||file.uid!==process.getuid?.()||file.mode&0o077)
        throw new NativePacketError('checkpoint-private');
      const db=new DatabaseSync(checkpoint,{readOnly:true});
      try {
        const row=db.prepare('SELECT value FROM checkpoint WHERE id=1').get();
        const value=row?JSON.parse(String(row.value)):null;
        if(!value||typeof value.source!=='string'||!/^[a-f0-9]{64}$/.test(value.source))throw new Error();
        packet.task.source=value.source;
      } finally {db.close();}
    } catch(error) {
      if(error instanceof NativePacketError)throw error;
      throw new NativePacketError('checkpoint-invalid');
    }
  }
  return {packet,path:packetPath,fileDigest,parentBinding};
}
