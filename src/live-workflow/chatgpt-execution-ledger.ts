import type { Stats } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { constants,openSync,closeSync,fstatSync,lstatSync,realpathSync,existsSync } from 'node:fs';
import { join,dirname,parse,sep } from 'node:path';
import { randomUUID } from 'node:crypto';
export class ChatGPTRefreshDeferred extends Error {
  readonly code='chatgpt-refresh-deferred';
  constructor(){super('ChatGPT renewal deferred while execution leases remain active');}
}
export interface ExecutionRow {
  id:string; generation:string; account:string; host:string; review:string; run:string;
  deadline:number; capability:string; runtime:string|null; status:string;
}
function secure(path:string,directory=false){
  const s=lstatSync(path);
  if(realpathSync(path)!==path||s.isSymbolicLink()||s.uid!==process.getuid?.()||
    (directory?!s.isDirectory()||(s.mode&0o777)!==0o700:!s.isFile()||s.nlink!==1||(s.mode&0o777)!==0o600))throw new Error('Unsafe execution ledger');
  return s;
}
/** Separate admission mutex, never the credential writer lock. No expiry/PID stealing. */
export class ChatGPTExecutionLedger {
  readonly #db:DatabaseSync;readonly #fd:number;readonly #identity:ReturnType<typeof fstatSync>;
  readonly #directoryIdentity:Stats;readonly path:string;
  constructor(readonly directory:string){
    let part=parse(directory).root;
    for(const segment of directory.slice(part.length).split(sep).filter(Boolean)){
      part=join(part,segment);const stat=lstatSync(part);
      if(!stat.isDirectory()||stat.isSymbolicLink()||((stat.mode&0o022)!==0&&(stat.mode&0o1000)===0))throw new Error('Unsafe execution ledger ancestors');
    }
    this.#directoryIdentity=secure(directory,true);this.path=join(directory,'chatgpt-execution.sqlite');
    let created=false;
    try{closeSync(openSync(this.path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600));created=true;}
    catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    secure(this.path);this.#fd=openSync(this.path,constants.O_RDONLY|constants.O_NOFOLLOW);this.#identity=fstatSync(this.#fd);
    let db:DatabaseSync|undefined;
    try{
      this.check();db=new DatabaseSync(this.path,{timeout:1000});
      const version=db.prepare('PRAGMA user_version').get()!.user_version;
      if(version!==1&&!(created&&version===0))throw new Error('Unsupported execution ledger schema');
      db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;');
      if(created)db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE leases(id TEXT PRIMARY KEY,generation TEXT NOT NULL,account TEXT NOT NULL,host TEXT NOT NULL,
          review TEXT NOT NULL,run TEXT NOT NULL,deadline INTEGER NOT NULL,capability TEXT NOT NULL,runtime TEXT,
          status TEXT NOT NULL CHECK(status IN ('active','revoked','indeterminate','completed','failed'))) STRICT;
        CREATE TABLE refresh(singleton INTEGER PRIMARY KEY CHECK(singleton=1),id TEXT NOT NULL,generation TEXT NOT NULL) STRICT;
        PRAGMA user_version=1; COMMIT;`);
      const objects=db.prepare("SELECT name,type FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
      if(JSON.stringify(objects.map(x=>[x.name,x.type]))!==JSON.stringify([['leases','table'],['refresh','table']]))throw new Error('Invalid execution ledger schema');
      const columns=(name:string)=>db!.prepare('PRAGMA table_info('+name+')').all().map(row=>[row.name,row.type,row.notnull,row.pk]);
      if(JSON.stringify(columns('leases'))!==JSON.stringify([['id','TEXT',1,1],['generation','TEXT',1,0],['account','TEXT',1,0],['host','TEXT',1,0],['review','TEXT',1,0],['run','TEXT',1,0],['deadline','INTEGER',1,0],['capability','TEXT',1,0],['runtime','TEXT',0,0],['status','TEXT',1,0]])||
        JSON.stringify(columns('refresh'))!==JSON.stringify([['singleton','INTEGER',0,1],['id','TEXT',1,0],['generation','TEXT',1,0]]))throw new Error('Invalid execution ledger columns');
      this.check();this.#db=db;
    }catch(error){db?.close();closeSync(this.#fd);throw error;}
  }
  check():void{
    const dir=secure(this.directory,true),current=secure(this.path),held=fstatSync(this.#fd);
    if(dir.dev!==this.#directoryIdentity.dev||dir.ino!==this.#directoryIdentity.ino||
      current.dev!==this.#identity.dev||current.ino!==this.#identity.ino||held.ino!==current.ino)throw new Error('Execution ledger replaced');
    for(const suffix of ['-journal','-wal','-shm'])if(existsSync(this.path+suffix))secure(this.path+suffix);
  }
  transaction<T>(work:()=>T):T{
    this.check();this.#db.exec('BEGIN IMMEDIATE');
    try{this.check();const result=work();this.check();this.#db.exec('COMMIT');return result;}
    catch(error){this.#db.exec('ROLLBACK');throw error;}
  }
  admit(row:ExecutionRow,check:()=>void):void{
    this.transaction(()=>{
      if(this.#db.prepare('SELECT 1 FROM refresh').get())throw new ChatGPTRefreshDeferred();
      check();this.#db.prepare('INSERT INTO leases VALUES(?,?,?,?,?,?,?,?,?,?)').run(row.id,row.generation,row.account,row.host,row.review,row.run,row.deadline,row.capability,row.runtime,row.status);check();
    });
  }
  row(id:string):ExecutionRow{
    this.check();const row=this.#db.prepare('SELECT * FROM leases WHERE id=?').get(id);
    if(!row)throw new Error('Unknown execution lease');
    for(const key of ['generation','account','host','review','run','capability'])if(typeof row[key]!=='string'||!/^[a-f0-9]{64}$/.test(row[key] as string))throw new Error('Invalid execution lease record');
    if(typeof row.id!=='string'||!Number.isSafeInteger(row.deadline)||(row.deadline as number)<1||
      (row.runtime!==null&&(typeof row.runtime!=='string'||!/^[a-f0-9]{64}$/.test(row.runtime)))||
      typeof row.status!=='string'||!['active','revoked','indeterminate','completed','failed'].includes(row.status))throw new Error('Invalid execution lease record');
    return row as unknown as ExecutionRow;
  }
  update(id:string,capability:string,status:string,runtime?:string):void{
    this.transaction(()=>{
      const old=this.row(id);
      if(old.capability!==capability||!['active','revoked','indeterminate'].includes(old.status))throw new Error('Execution lease replay or capability mismatch');
      if(runtime!==undefined&&(old.status!=='active'||old.runtime!==null))throw new Error('Execution launch admission revoked or replayed');
      this.#db.prepare('UPDATE leases SET status=?,runtime=? WHERE id=?').run(status,runtime??old.runtime,id);
    });
  }
  beginRefresh(generation:string,check:()=>void):string{
    return this.transaction(()=>{
      if(this.#db.prepare("SELECT 1 FROM leases WHERE status IN ('active','revoked','indeterminate') LIMIT 1").get()||this.#db.prepare('SELECT 1 FROM refresh').get())throw new ChatGPTRefreshDeferred();
      check();const id=randomUUID();this.#db.prepare('INSERT INTO refresh VALUES(1,?,?)').run(id,generation);return id;
    });
  }
  refreshIntent():Readonly<{id:string;generation:string}>|null{
    this.check();const row=this.#db.prepare('SELECT id,generation FROM refresh').get();
    if(!row)return null;
    if(typeof row.id!=='string'||typeof row.generation!=='string'||!/^[a-f0-9]{64}$/.test(row.generation))throw new Error('Invalid refresh intent');
    return Object.freeze({id:row.id,generation:row.generation});
  }
  assertRefreshIntent(expected:Readonly<{id:string;generation:string}>|null):void{
    if(JSON.stringify(this.refreshIntent())!==JSON.stringify(expected))throw new Error('Reconnect refresh intent changed');
  }
  reconcileReconnect(expected:Readonly<{id:string;generation:string}>|null,check:()=>void):void{
    this.transaction(()=>{
      this.assertRefreshIntent(expected);check();
      if(expected)this.#db.prepare('DELETE FROM refresh WHERE id=? AND generation=?').run(expected.id,expected.generation);
    });
  }
  finishRefresh(id:string):void{
    this.transaction(()=>{
      if(this.#db.prepare('SELECT id FROM refresh').get()?.id!==id)throw new Error('Refresh admission intent changed');
      this.#db.prepare('DELETE FROM refresh WHERE id=?').run(id);
    });
  }
  revoke():void{this.transaction(()=>this.#db.exec("UPDATE leases SET status='revoked' WHERE status='active'"));}
  close():void{try{this.#db.close();}finally{closeSync(this.#fd);}}
}
export function revokeChatGPTExecutions(directory:string):void{
  if(!existsSync(join(directory,'chatgpt-execution.sqlite')))return;
  const ledger=new ChatGPTExecutionLedger(directory);try{ledger.revoke();}finally{ledger.close();}
}
