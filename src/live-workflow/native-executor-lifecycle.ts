import { serialize } from '../context-engine/validation.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { LocalPolicyRuntime } from '../policy/runtime.js';
import { sha256 } from './validation.js';
import { ownerLedger } from './native-executor-owner.js';
import type { NativeTask } from './native-executor-contracts.js';
import type { NativeLaunchPlan, NativeLifecycleReceipt } from './native-executor-launch-contracts.js';

/** Native process authority binds immutable runtime inputs, never mutable project inventory. */
export class NativeLifecycle {
  readonly #runtime: LocalPolicyRuntime;
  readonly #db: ReturnType<typeof ownerLedger>;
  readonly #task: NativeTask;
  readonly #active: () => void;
  readonly authorityBinding: string;
  readonly budgetBinding: string;
  readonly grantDigest: string;
  readonly deadline: number;
  readonly leaseId = randomUUID();
  readonly fencingEpoch: number;
  readonly grantId: string;
  readonly #resource: string;
  #binding = 'preparing-native-runtime';
  #closed = false;
  constructor(directory: string, task: NativeTask, deadline: number, active: () => void, parentBinding: string) {
    if (!/^[a-f0-9]{64}$/.test(parentBinding)) throw new Error('Native parent grant binding required');
    this.#task=structuredClone(task);this.deadline=deadline;this.#active=active;
    this.grantDigest=parentBinding;
    this.authorityBinding=sha256(JSON.stringify({task:{...task,source:undefined},parentBinding}));
    this.budgetBinding=sha256(JSON.stringify(task.budget));
    this.#db=ownerLedger(directory,task.root,'lifecycle');
    this.#db.exec('CREATE TABLE IF NOT EXISTS epochs(id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL); INSERT OR IGNORE INTO epochs VALUES(1,0); UPDATE epochs SET value=value+1 WHERE id=1; CREATE TABLE IF NOT EXISTS runtimes(id TEXT PRIMARY KEY,binding TEXT NOT NULL,status TEXT NOT NULL); CREATE TABLE IF NOT EXISTS terminals(id TEXT PRIMARY KEY,receipt TEXT NOT NULL)');
    this.fencingEpoch=Number(this.#db.prepare('SELECT value FROM epochs WHERE id=1').get()!.value);
    this.#resource='native-runtime:'+task.task+':'+this.leaseId;
    this.#runtime=LocalPolicyRuntime.open({stateDirectory:join(directory,'policy'),workspaceRoot:task.root,repositoryId:task.project,sourceSnapshot:()=>this.#binding});
    const grant=this.#runtime.issueGrant({taskId:task.task,invocationId:this.leaseId,role:'lead',capabilities:[{action:'command.run',resource:this.#resource}],expiresAt:deadline,remainingDepth:0,maxActions:1,maxChildren:0});
    this.grantId=grant.id;
  }
  active(): void {
    this.#active();
    const grant=this.#runtime.grant(this.grantId);
    if(!grant||grant.revoked||grant.sessionId!==this.#runtime.sessionId)throw new Error('Inactive native parent permission grant');
    if(this.#closed||Date.now()>=this.deadline||Number(this.#db.prepare('SELECT value FROM epochs WHERE id=1').get()!.value)!==this.fencingEpoch)throw new Error('Stale native runtime fence');
  }
  reserve(plan: NativeLaunchPlan): NativeLifecycleReceipt {
    this.active();
    if(plan.domain!=='native-runtime-v1'||plan.taskId!==this.#task.task||plan.grantId!==this.grantId||plan.leaseId!==this.leaseId||plan.fencingEpoch!==this.fencingEpoch||plan.model!==this.#task.model||plan.effort!==this.#task.effort||plan.authorityBinding!==this.authorityBinding||plan.budgetBinding!==this.budgetBinding||plan.grantDigest!==this.grantDigest||plan.deadlineEpochMs!==this.deadline)throw new Error('Native runtime plan differs from authority');
    this.#binding=plan.runtimeBinding;
    // The owner validates the parent permission descriptor above before issuing
    // this single-action grant for the exact final sealed runtime envelope.
    const resource='host:'+sha256(serialize(plan));
    const grant=this.#runtime.issueGrant({taskId:this.#task.task,invocationId:this.leaseId,role:'lead',capabilities:[{action:'command.run',resource}],expiresAt:this.deadline,remainingDepth:0,maxActions:1,maxChildren:0});
    const reservation=this.#runtime.reserveExternal(grant.id,this.leaseId,{requestId:randomUUID(),action:'command.run',resource,sourceSnapshot:this.#binding},plan);
    this.#db.prepare('INSERT INTO runtimes VALUES(?,?,?)').run(reservation.receiptId,this.#binding,'running');
    let finished=false;
    return Object.freeze({runtimeBinding:this.#binding,receiptId:reservation.receiptId,
      checkActive:()=>{this.active();if(finished)throw new Error('Finished native runtime');reservation.check();},
      finish:(status:'completed'|'failed'|'indeterminate')=>{
        if(finished)throw new Error('Duplicate native runtime finish');
        let terminalStatus=status;
        try {
          if(status==='completed'){
            try{this.active();reservation.check();}catch{terminalStatus='failed';}
          }
          const terminalReceiptId=reservation.finish(terminalStatus,{viewDigest:sha256(JSON.stringify(plan))});
          this.#db.prepare('INSERT INTO terminals VALUES(?,?)').run(reservation.receiptId,terminalReceiptId);
          this.#db.prepare('UPDATE runtimes SET status=? WHERE id=?').run(terminalStatus,reservation.receiptId);
        } catch(error) {
          this.#db.prepare('UPDATE runtimes SET status=? WHERE id=?').run('indeterminate',reservation.receiptId);
          throw error;
        } finally { finished=true; }
      }});
  }
  assertCompleted(receipt:NativeLifecycleReceipt):void {
    this.active();
    const row=this.#db.prepare('SELECT r.binding,r.status,t.receipt FROM runtimes r LEFT JOIN terminals t ON r.id=t.id WHERE r.id=?').get(receipt.receiptId);
    const terminal=this.#runtime.receipts().find(record=>record.id===row?.receipt);
    if(receipt.runtimeBinding!==this.#binding||!row||row.binding!==receipt.runtimeBinding||row.status!=='completed'||
      !terminal||terminal.event!=='external.finished'||terminal.outcome!=='completed'||terminal.sourceSnapshot!==receipt.runtimeBinding)throw new Error('Native runtime receipt is not completed');
  }
  export(){return{fencingEpoch:this.fencingEpoch,leaseId:this.leaseId,runtimes:this.#db.prepare('SELECT * FROM runtimes').all(),receipts:this.#runtime.receipts()};}
  close():void{if(!this.#closed){this.#closed=true;this.#runtime.close();this.#db.close();}}
}
