import { realpathSync,mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatGPTStore } from '../../src/live-workflow/chatgpt-store.js';
import { openChatGPTPlanSession } from '../../src/live-workflow/chatgpt-plan.js';
import { ChatGPTExecutionLedger } from '../../src/live-workflow/chatgpt-execution-ledger.js';
export function executionFixture(lifetime=600000){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'fm-execution-'))),directory=join(root,'account');
  const store=new ChatGPTStore(directory,process.cwd(),true);
  try{store.lock();const connection={schemaVersion:1 as const,hostId:store.getHostId(),clientId:'oaiapp_fixture',subject:'fixture-owner',accessToken:'synthetic-only-access',refreshToken:'synthetic-only-refresh',idToken:'synthetic.only.id',scope:'chatgpt.tokens.use.direct',email:'fixture@example.invalid',expiresAt:Date.now()+lifetime};store.save(connection);store.confirmBillingReview(connection);}
  finally{store.close();}
  new ChatGPTExecutionLedger(directory).close();
  return {directory,root,open:()=>openChatGPTPlanSession(directory,{isTTY:true,confirm:async()=>{throw new Error('Unexpected fixture prompt');}}),close:()=>rmSync(root,{recursive:true,force:true})};
}
