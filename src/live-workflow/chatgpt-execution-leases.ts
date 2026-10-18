import { randomBytes,randomUUID,createHash } from 'node:crypto';
import { ChatGPTExecutionLedger } from './chatgpt-execution-ledger.js';
import { ChatGPTStore,connectionDigest,chatGPTAccountFingerprint } from './chatgpt-store.js';
import type { ChatGPTConnection,ChatGPTBillingReview } from './chatgpt-store.js';
import { assertNativeCleanupEvidence,consumeNativeCleanupEvidence } from './native-executor-process.js';
import type { NativeCleanupEvidence } from './native-executor-process.js';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
interface State{
  ledger:ChatGPTExecutionLedger;connection:ChatGPTConnection;review:ChatGPTBillingReview;
  capability:string;id:string;run:string;deadline:number;runtime:string|null;check:()=>void;signal:AbortSignal;settled:boolean;outcome:string;launchClaimed:boolean;
}
const handles=new WeakMap<object,State>();
/** Opaque execution ownership: callback-scoped token scans do not own this lease. */
export class ChatGPTExecutionLease {
  private constructor(){}
  static admit(directory:string,connection:ChatGPTConnection,review:ChatGPTBillingReview,
    options:{runBinding:string;deadline:number;signal:AbortSignal;check:()=>void}):ChatGPTExecutionLease{
    if(!/^[a-f0-9]{64}$/.test(options.runBinding)||!Number.isSafeInteger(options.deadline)||options.deadline<=Date.now()||options.deadline>=connection.expiresAt)throw new Error('Invalid execution lease lifetime or run binding');
    const capability=hash(randomBytes(32).toString('hex')),id=randomUUID();
    const check=()=>{
      options.signal.throwIfAborted();options.check();
      const store=new ChatGPTStore(directory);try{
        const selected=store.reviewedSnapshot();
        if(connectionDigest(selected.connection)!==connectionDigest(connection)||selected.review?.reviewId!==review.reviewId)throw new Error('Execution account generation or review changed');
      }finally{store.close();}
    };
    check();const ledger=new ChatGPTExecutionLedger(directory);
    try{
      ledger.admit({id,generation:connectionDigest(connection),account:chatGPTAccountFingerprint(connection),host:hash(connection.hostId),review:hash(review.reviewId),run:options.runBinding,deadline:options.deadline,capability,runtime:null,status:'active'},check);
      const lease=new ChatGPTExecutionLease();handles.set(lease,{ledger,connection,review,capability,id,run:options.runBinding,deadline:options.deadline,runtime:null,signal:options.signal,check,settled:false,outcome:'active',launchClaimed:false});return lease;
    }catch(error){ledger.close();throw error;}
  }
  assertActive():void{
    const state=handles.get(this);if(!state||state.settled)throw new Error('Inactive execution lease');
    state.check();if(Date.now()>=state.deadline)throw new Error('Execution lease expired');
    const row=state.ledger.row(state.id);
    if(row.status!=='active'||row.capability!==state.capability||row.generation!==connectionDigest(state.connection)||row.runtime!==state.runtime||row.account!==chatGPTAccountFingerprint(state.connection)||row.host!==hash(state.connection.hostId)||row.review!==hash(state.review.reviewId)||row.run!==state.run||row.deadline!==state.deadline)throw new Error('Execution lease revoked or changed');
  }
  assertContext(directory:string,connection:ChatGPTConnection,review:ChatGPTBillingReview,run:string,deadline:number):void{
    this.assertActive();const state=handles.get(this)!;
    if(state.ledger.directory!==directory||connectionDigest(state.connection)!==connectionDigest(connection)||
      state.review.reviewId!==review.reviewId||state.run!==run||deadline>state.deadline)throw new Error('Execution lease account or run mismatch');
  }
  beginLaunch(runtime:string):void{
    this.assertActive();const state=handles.get(this)!;
    if(state.runtime||!/^[a-f0-9]{64}$/.test(runtime))throw new Error('Execution lease launch replay');
    state.ledger.update(state.id,state.capability,'active',runtime);state.runtime=runtime;
  }
  settle(outcome:'completed'|'failed',proof:NativeCleanupEvidence|null):void{
    const state=handles.get(this);if(!state||state.settled)throw new Error('Execution lease settlement replay');
    const row=state.ledger.row(state.id);
    if(row.capability!==state.capability||row.generation!==connectionDigest(state.connection)||row.runtime!==state.runtime||
      row.account!==chatGPTAccountFingerprint(state.connection)||row.host!==hash(state.connection.hostId)||
      row.review!==hash(state.review.reviewId)||row.run!==state.run||row.deadline!==state.deadline)throw new Error('Execution lease binding changed');
    // Cleanup is independent of successful account/authority checks. Revoked and
    // cancelled work still releases only after proven containment/reaping.
    if(state.runtime){if(!proof)throw new Error('Execution cleanup indeterminate');assertNativeCleanupEvidence(proof,state.runtime,state.id);}
    else if(proof||outcome==='completed')throw new Error('Unexpected prelaunch cleanup or completion');
    if(outcome==='completed')this.assertActive();
    state.ledger.update(state.id,state.capability,outcome);
    if(state.runtime)consumeNativeCleanupEvidence(proof!,state.runtime,state.id);
    state.settled=true;state.outcome=outcome;state.ledger.close();
  }
  retainIndeterminate():void{
    const state=handles.get(this);if(!state||state.settled)return;
    try{state.ledger.update(state.id,state.capability,'indeterminate');}finally{state.settled=true;state.outcome='indeterminate';state.ledger.close();}
  }
  receipt():Readonly<{id:string;deadline:number;runtime:string|null;status:string}>{
    const state=handles.get(this);if(!state)throw new Error('Unknown execution lease');
    return Object.freeze({id:state.id,deadline:state.deadline,runtime:state.runtime,status:state.settled?state.outcome:state.ledger.row(state.id).status});
  }
}
export function assertChatGPTExecutionLease(lease:ChatGPTExecutionLease):void{
  if(!handles.has(lease))throw new Error('Unrecognized execution lease');lease.assertActive();
}

/** Explicit owner reconciliation requires genuine runtime-bound containment evidence.
 * A crashed owner has no automatic proof acquisition or lease-stealing fallback. */
export function reconcileChatGPTExecution(directory:string,id:string,proof:NativeCleanupEvidence,check:()=>void):void{
  check();const ledger=new ChatGPTExecutionLedger(directory);
  try{
    const row=ledger.row(id);
    if(!row.runtime)throw new Error('Execution reconciliation needs runtime containment evidence');
    assertNativeCleanupEvidence(proof,row.runtime,row.id);check();
    ledger.update(id,row.capability,'failed');consumeNativeCleanupEvidence(proof,row.runtime,row.id);
  }finally{ledger.close();}
}

/** Claim exactly one prepared launch for a recognized execution owner. Cancellation
 * may prevent launch, but a second launch can never counterfeit its cleanup. */
export function claimChatGPTExecutionLaunch(lease:ChatGPTExecutionLease,runtime:string):string{
  const state=handles.get(lease);
  if(!state||state.settled||state.runtime!==runtime||state.launchClaimed)throw new Error('Invalid or replayed execution launch admission');
  state.ledger.check();state.launchClaimed=true;return state.id;
}
