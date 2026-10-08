import test from "node:test";
import assert from "node:assert/strict";
import { startBroker } from "../../src/live-workflow/provider.js";
import type { LiveTask } from "../../src/live-workflow/contracts.js";
const task: LiveTask = {
  schemaVersion: 1,
  taskId: "test",
  objective: "test",
  readPaths: ["src/x.ts"],
  writePaths: ["src/x.ts"],
  checks: [],
  model: "test-model",
  effort: "low",
  maxModelRequests: 4,
  maxPromptBytes: 20000,
  maxOutputBytes: 20000,
  maxRuntimeMs: 5000,
  draftPr: false,
};
const source = "a".repeat(64);
const fixture = () => {
  const actions: string[] = [];
  return {
    actions,
    authority: {
      reserve: () => ({
        check: () => {},
        finish: (status: string) => {
          actions.push(status);
        },
      }),
      reserveRequest: (bytes: number) => {
        actions.push("reserved:" + bytes);
        return 1;
      },
    },
  };
};
test("provider broker strips native tools, scopes egress and reserves full prompt before forwarding", async () => {
  const f = fixture();
  let calls = 0;
  const b = await startBroker({
    task,
    source: () => source,
    authority: f.authority,
    credentials: () => ({
      accessToken: "fixture-token",
      accountId: "fixture-account",
    }),
    signal: AbortSignal.timeout(5000),
    transport: async (url, init) => {
      calls++;
      assert.equal(url, "https://chatgpt.com/backend-api/codex/responses");
      assert.equal(init?.redirect, "error");
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.tools, []);
      assert.equal(body.tool_choice, "none");
      assert.equal(body.service_tier, "default");
      assert.ok(f.actions[0]?.startsWith("reserved:"));
      return new Response(
        "data: " +
          JSON.stringify({
            type: "response.completed",
            response: { status: "completed", model: task.model },
          }) +
          "\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  try {
    const r = await fetch(`http://127.0.0.1:${b.port}/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer " + b.token },
      body: JSON.stringify({
        model: task.model,
        input: [],
        instructions: "protected",
        stream: true,
        tools: [{ type: "function", name: "shell" }],
      }),
    });
    assert.equal(r.status, 200);
    await r.text();
    b.assertSuccess();
    assert.equal(calls, 1);
    assert.equal(f.actions.at(-1), "completed");
    const replay = await fetch(`http://127.0.0.1:${b.port}/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer " + b.token },
      body: "{}",
    });
    assert.equal(replay.status, 502);
    assert.equal(calls, 1);
  } finally {
    await b.close();
  }
});
for (const reason of [
  "wrong-model",
  "oversize",
  "tool-call",
  "redirect",
  "incomplete",
])
  test("provider fails closed on " + reason, async () => {
    const f = fixture();
    let calls = 0;
    const b = await startBroker({
      task,
      source: () => source,
      authority: f.authority,
      credentials: () => ({ accessToken: "fixture", accountId: "fixture" }),
      signal: AbortSignal.timeout(5000),
      transport: async () => {
        calls++;
        if (reason === "redirect") return new Response("", { status: 302 });
        if (reason === "tool-call")
          return new Response(
            "data: " +
              JSON.stringify({
                type: "response.output_item.added",
                item: { type: "function_call" },
              }) +
              "\n\n",
          );
        return new Response(
          "data: " + JSON.stringify({ type: "response.created" }) + "\n\n",
        );
      },
    });
    try {
      const body =
        reason === "oversize"
          ? "x".repeat(20001)
          : JSON.stringify({
              model: reason === "wrong-model" ? "bad" : task.model,
              input: [],
              stream: true,
            });
      try {
        const r = await fetch(`http://127.0.0.1:${b.port}/v1/responses`, {
          method: "POST",
          headers: { authorization: "Bearer " + b.token },
          body,
        });
        await r.text();
      } catch {}
      assert.throws(() => b.assertSuccess());
      assert.equal(calls, ["wrong-model", "oversize"].includes(reason) ? 0 : 1);
    } finally {
      await b.close();
    }
  });

test('native advertised tools are removed from input; executable tool history is rejected',async()=>{
 for(const kind of ['additional_tools','function_call_output']){
  const f=fixture();let calls=0;
  const broker=await startBroker({task,source:()=>source,authority:f.authority,credentials:()=>({accessToken:'fixture',accountId:'fixture'}),signal:AbortSignal.timeout(5000),transport:async(_url,init)=>{calls++;const body=JSON.parse(String(init?.body));assert.equal(body.additional_tools,undefined);assert.deepEqual(body.tools,[]);assert.deepEqual(body.input,[{type:'message',role:'user',content:'fixture'}]);return new Response('data: '+JSON.stringify({type:'response.completed',response:{status:'completed',model:task.model}})+'\n\n');}});
  try{const response=await fetch(`http://127.0.0.1:${broker.port}/v1/responses`,{method:'POST',headers:{authorization:'Bearer '+broker.token},body:JSON.stringify({model:task.model,stream:true,additional_tools:[{type:'function',name:'shell'}],input:[{type:kind,tools:[{type:'function',name:'shell'}]},{type:'message',role:'user',content:'fixture'}]})});await response.text();assert.equal(calls,kind==='additional_tools'?1:0);if(kind==='additional_tools')broker.assertSuccess();else assert.throws(()=>broker.assertSuccess());}finally{await broker.close();}
 }
});
