import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import childProcess from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from 'node:sqlite';
import { runTask } from "../../src/live-workflow/orchestrator.js";
import { sha256 } from "../../src/live-workflow/validation.js";
import {
  NativeCodexModel,
  startBroker,
} from "../../src/live-workflow/provider.js";
import { fixtureResponse } from './native-fixture.js';
import type { LiveTask } from "../../src/live-workflow/contracts.js";
import { ChatGPTStore } from '../../src/live-workflow/chatgpt-store.js';
import { openChatGPTPlanSession } from '../../src/live-workflow/chatgpt-plan.js';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fm-pipeline-"))),
    repo = join(root, "repo");
  mkdirSync(repo);
  mkdirSync(join(root, "worktrees"));
  mkdirSync(join(repo, "config"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
  git("init", "-b", "main");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Fixture");
  git("remote", "add", "origin", "https://github.com/fixture/project.git");
  writeFileSync(
    join(repo, "config/forgemind-project.json"),
    JSON.stringify({
      schemaVersion: 1,
      projectId: "fixture",
      name: "Fixture",
      documents: { prd: "docs/PRD.md", srs: "docs/SRS.md", adrs: "docs/adr" },
      preferences: {
        askAt: "project",
        draftPr: false,
        evidence: "text",
        planReview: "show",
      },
    }),
  );
  writeFileSync(join(repo, "value.txt"), "before");
  git("add", ".");
  git("commit", "-m", "fixture");
  const task: LiveTask = {
    schemaVersion: 1,
    taskId: "fix-value",
    objective: "Change value to after",
    readPaths: ["value.txt"],
    writePaths: ["value.txt"],
    checks: [
      {
        id: "value",
        executable: realpathSync(process.execPath),
        args: [
          "-e",
          "const fs=require('fs');process.exit(fs.readFileSync('value.txt','utf8')==='after'?0:1)",
        ],
        timeoutMs: 5000,
      },
    ],
    model: "fixture-model",
    effort: "low",
    maxModelRequests: 3,
    maxPromptBytes: 65536,
    maxOutputBytes: 65536,
    maxRuntimeMs: 60000,
    draftPr: false,
  };
  return {
    root,
    repo,
    git,
    task,
    options: {
      workspace: repo,
      task,
      stateDirectory: join(root, "state"),
      worktreeDirectory: join(root, "worktrees"),
      codexExecutable: "/missing",
      confirmPlan: async () => false,
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
test("production task is blocked before worktree, ledger, credentials or provider access", async () => {
  const f = fixture();
  try {
    await assert.rejects(runTask(f.options), /subscription-only/);
    assert.equal(existsSync(f.options.stateDirectory), false);
    assert.equal(f.git("branch", "--list", "task/*"), "");
    assert.equal(readFileSync(join(f.repo, "value.txt"), "utf8"), "before");
  } finally {
    f.cleanup();
  }
});
test("all native inference entry points block without a fixture transport", async () => {
  const f = fixture();
  try {
    const model = new NativeCodexModel({
      executable: "/does-not-exist",
      task: f.task,
      authority: null!,
      source: () => {
        throw Error("must not inspect");
      },
    });
    await assert.rejects(
      model.complete("", {}, {}, new AbortController().signal),
      /subscription-only/,
    );
    await assert.rejects(
      startBroker({
        task: f.task,
        source: () => "",
        authority: null!,
        credentials: () => {
          throw Error("must not read credentials");
        },
        signal: new AbortController().signal,
      }),
      /subscription-only/,
    );
  } finally {
    f.cleanup();
  }
});
test('draft publication forwards trusted author and pinned helper without network access', {
  skip: process.platform !== 'darwin', timeout: 90000,
}, async t => {
  const f = fixture(), ghPath = join(f.root, 'gh-helper');
  writeFileSync(ghPath, 'fixture helper; never executed'); chmodSync(ghPath, 0o755);
  const helper = { ghPath, sha256: sha256(readFileSync(ghPath)) };
  const configFile = join(f.repo, '.git/config'), config = readFileSync(configFile);
  f.task.draftPr = true;
  const network: { executable: string; args: string[] }[] = [];
  const commits: string[][] = [];
  t.mock.method(childProcess, 'execFileSync', (executable: string, args: string[], options: unknown) => {
    const command = args[0]?.endsWith('/repository-supervisor.js')
      ? JSON.parse(Buffer.from(args[1]!, 'base64url').toString()) as { executable: string; args: string[] }
      : { executable, args };
    if (command.executable === 'git' && command.args.includes('commit')) commits.push(command.args);
    if (command.executable === 'gh' || command.executable === 'git' && command.args.includes('push')) {
      network.push(command);
      return Buffer.from(command.executable === 'git' ? '' : command.args[1] === 'list' ? '[]' : 'https://github.com/fixture/project/pull/23\n');
    }
    return execFileSync(executable, args, options as Parameters<typeof execFileSync>[2]);
  });
  let calls = 0;
  const outputs = [
    { objective: f.task.objective, paths: ['value.txt'], steps: ['Fix value'], acceptanceCriteria: ['Value is after'], risks: [] },
    { summary: 'Correct value', edits: [{ path: 'value.txt', beforeSha256: sha256('before'), content: 'after' }] },
    { verdict: 'pass', findings: [], acceptance: ['Value is after'] },
  ];
  try {
    const result = await runTask({ ...f.options, publication: { author: { name: 'Publication Owner',
      email: '123+owner@users.noreply.github.com' }, gitCredentialHelper: helper },
      modelFactory: () => ({ complete: async () => outputs[calls++] }) });
    assert.equal(result.status, 'completed'); assert.equal(calls, 3);
    assert.equal(result.prUrl, 'https://github.com/fixture/project/pull/23');
    assert.equal(commits.length, 1);
    assert.ok(commits[0]!.includes('user.name=Publication Owner'));
    assert.ok(commits[0]!.includes('user.email=123+owner@users.noreply.github.com'));
    assert.equal(network.length, 3);
    assert.ok(network[1]!.args.includes(`credential.https://github.com.helper=${ghPath} auth git-credential`));
    assert.ok(network[1]!.args.includes('credential.helper='));
    assert.equal(execFileSync('git', ['log', '-1', '--format=%an <%ae>'], { cwd: result.worktree!, encoding: 'utf8' }).trim(),
      'Publication Owner <123+owner@users.noreply.github.com>');
    assert.deepEqual(readFileSync(configFile), config);
    assert.equal(readFileSync(join(f.repo, 'value.txt'), 'utf8'), 'before');
  } finally { f.cleanup(); }
});
for (const verdict of ["pass", "revise"] as const)
  test(
    "fixture pipeline isolates edits, repeats checks and honors reviewer " +
      verdict,
    { skip: process.platform !== "darwin", timeout: 60000 },
    async () => {
      const f = fixture();
      let calls = 0;
      try {
        const running = runTask({
          ...f.options,
          modelFactory: () => ({
            async complete(_instructions, input) {
              calls++;
              if (calls === 1)
                return {
                  objective: f.task.objective,
                  paths: ["value.txt"],
                  steps: ["Fix value"],
                  acceptanceCriteria: ["Value is after"],
                  risks: [],
                };
              if (calls === 2)
                return {
                  summary: "Correct value",
                  edits: [
                    {
                      path: "value.txt",
                      beforeSha256: sha256("before"),
                      content: "after",
                    },
                  ],
                };
              assert.equal(
                (input as { beforeChecks: { passed: boolean }[] })
                  .beforeChecks[0]?.passed,
                false,
              );
              assert.equal(
                (input as { afterChecks: { passed: boolean }[] }).afterChecks[0]
                  ?.passed,
                true,
              );
              return {
                verdict,
                findings: verdict === "pass" ? [] : ["Change requested"],
                acceptance: ["Value checked"],
              };
            },
          }),
        });
        if (verdict === "pass") {
          const result = await running;
          assert.equal(result.status, "completed-local");
          assert.equal(
            readFileSync(join(result.worktree!, "value.txt"), "utf8"),
            "after",
          );
          const receipt = JSON.parse(
            readFileSync(join(result.artifacts, "receipt.json"), "utf8"),
          );
          assert.equal(receipt.run.status, "completed");
          assert.ok(receipt.receipts.length >= 3);
        } else
          await assert.rejects(running, /Independent review requires revision/);
        assert.equal(calls, 3);
        assert.equal(readFileSync(join(f.repo, "value.txt"), "utf8"), "before");
        assert.equal(
          f.git("log", "--format=%s", "-1", "task/fix-value"),
          "fixture",
        );
      } finally {
        f.cleanup();
      }
    },
  );

test('real native fixture drives plan, edit and independent review end to end without provider access',{
 skip:process.platform!=='darwin'||!existsSync(join(homedir(),'.local/bin/codex')),timeout:90000},async()=>{
 const f=fixture();f.task.model='gpt-6.1-sol';f.task.maxPromptBytes=262144;let calls=0;
 const outputs=[{objective:f.task.objective,paths:['value.txt'],steps:['Fix value'],acceptanceCriteria:['Value is after'],risks:[]},{summary:'Correct value',edits:[{path:'value.txt',beforeSha256:sha256('before'),content:'after'}]},{verdict:'pass',findings:[],acceptance:['Value is after']}];
 try{const result=await runTask({...f.options,modelFactory:(authority,source)=>new NativeCodexModel({executable:realpathSync(join(homedir(),'.local/bin/codex')),task:f.task,authority,source,credentials:()=>({accessToken:'fixture',accountId:'fixture'}),transport:async(_url,init)=>{const body=JSON.parse(String(init?.body));assert.deepEqual(body.tools,[]);assert.ok(body.input.every((item:{type?:string})=>item.type==='message'||item.type===undefined));return fixtureResponse(f.task.model,outputs[calls++]);}})});
 assert.equal(result.status,'completed-local');assert.equal(calls,3);assert.equal(readFileSync(join(result.worktree!,'value.txt'),'utf8'),'after');assert.equal(readFileSync(join(f.repo,'value.txt'),'utf8'),'before');
 const receipt=JSON.parse(readFileSync(join(result.artifacts,'receipt.json'),'utf8'));assert.equal(receipt.run.requests,3);assert.equal(receipt.run.status,'completed');
 }finally{f.cleanup();}
});

test('plan contents precede owner approval and rejection prevents code and checks', { skip: process.platform !== 'darwin' }, async () => {
  const f = fixture();
  const profilePath = join(f.repo, 'config/forgemind-project.json');
  const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
  profile.preferences.planReview = 'approve';
  writeFileSync(profilePath, JSON.stringify(profile)); f.git('add', '.'); f.git('commit', '-m', 'require plan approval');
  const progress: string[] = []; let calls = 0;
  try {
    const result = await runTask({ ...f.options, onProgress: message => { progress.push(message); },
      confirmPlan: async (_plan, digest) => {
        assert.match(progress.join('\n'), /Value is after/); assert.match(digest, /^[a-f0-9]{64}$/); return false;
      }, modelFactory: () => ({ complete: async () => {
        calls++; return { objective: f.task.objective, paths: ['value.txt'], steps: ['Fix value'], acceptanceCriteria: ['Value is after'], risks: [] };
      } }) });
    assert.equal(result.status, 'needs-plan-approval'); assert.equal(calls, 1);
    assert.equal(existsSync(join(result.artifacts, 'before-checks.json')), false);
    assert.equal(readFileSync(join(result.worktree!, 'value.txt'), 'utf8'), 'before');
  } finally { f.cleanup(); }
});

test('authenticated public-route pipeline uses real sandboxed Codex with synthetic OAuth responses', {
  skip: process.platform !== 'darwin' || !existsSync(join(homedir(), '.local/bin/codex')), timeout: 90000,
}, async () => {
  const f = fixture(), nativeFetch = globalThis.fetch, directory = join(f.root, 'account');
  const store = new ChatGPTStore(directory, f.repo, true);
  try {
    store.lock(); store.save({ schemaVersion: 1, hostId: store.getHostId(), clientId: 'oaiapp_fixture', subject: 'fixture-subject',
      email: 'owner@example.invalid', accessToken: 'synthetic-access-token', idToken: 'synthetic.signed.identity',
      scope: 'chatgpt.tokens.use.direct', expiresAt: Date.now() + 3600000 });
  } finally { store.close(); }
  f.task.model = 'gpt-6.1-sol'; f.task.maxPromptBytes = 262144; let calls = 0;
  const outputs = [
    { objective: f.task.objective, paths: ['value.txt'], steps: ['Fix value'], acceptanceCriteria: ['Value is after'], risks: [] },
    { summary: 'Correct value', edits: [{ path: 'value.txt', beforeSha256: sha256('before'), content: 'after' }] },
    { verdict: 'pass', findings: [], acceptance: ['Value is after'] },
  ];
  try {
    const session = await openChatGPTPlanSession(directory, { isTTY: true, confirm: async prompt => prompt.match(/Enter exactly "([^"]+)"/)![1]! });
    globalThis.fetch = async (url, init) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-access-token');
      assert.equal(JSON.parse(String(init?.body)).store, false);
      return fixtureResponse(f.task.model, outputs[calls++]);
    };
    const result = await runTask({ ...f.options, codexExecutable: realpathSync(join(homedir(), '.local/bin/codex')), planSession: session });
    assert.equal(result.status, 'completed-local'); assert.equal(calls, 3);
    assert.equal(readFileSync(join(result.worktree!, 'value.txt'), 'utf8'), 'after');
    assert.equal(readFileSync(join(f.repo, 'value.txt'), 'utf8'), 'before');
    const text = readFileSync(join(result.artifacts, 'receipt.json'), 'utf8'), receipt = JSON.parse(text);
    assert.equal(receipt.run.requests, 3); assert.equal(receipt.run.status, 'completed');
    assert.doesNotMatch(text, /synthetic-access-token/);
    const ledger = new DatabaseSync(join(f.options.stateDirectory, 'execution/policy/policy.sqlite'), { readOnly: true });
    try {
      const providers = ledger.prepare('SELECT body FROM external_attempts').all()
        .map(row => JSON.parse(row.body as string)).filter(attempt => JSON.parse(attempt.envelopeJson).kind === 'provider');
      assert.equal(providers.length, 3);
      for (const attempt of providers) {
        const envelope = JSON.parse(attempt.envelopeJson);
        assert.equal(envelope.detail.connection.billingReview, 'owner-confirmed-server-credit-control-off');
        assert.equal(envelope.detail.connection.accountSha256, session.binding().accountSha256);
        assert.equal(attempt.intent.resource, 'host:' + sha256(attempt.envelopeJson));
        assert.doesNotMatch(attempt.envelopeJson, /synthetic-access-token/);
      }
    } finally { ledger.close(); }
  } finally { globalThis.fetch = nativeFetch; f.cleanup(); }
});

// Synthetic color clips exercise delivery gating; they are not application evidence.
test('requested video cannot complete locally without approved reviewer delivery', {
  skip: process.platform !== 'darwin' || !existsSync('/opt/homebrew/bin/ffmpeg') || !existsSync('/opt/homebrew/bin/ffprobe'),
  timeout: 90000,
}, async () => {
  const f = fixture(), artifacts = join(f.root, 'videos');
  mkdirSync(artifacts); let calls = 0;
  const probe = realpathSync('/opt/homebrew/bin/ffprobe');
  const recording = (phase: string) => ({
    explicitlyRequested: true as const, taskId: f.task.taskId, scenarioId: 'delivery-gate-fixture',
    artifactsDirectory: artifacts, outputPath: join(artifacts, phase + '.mp4'),
    captureTarget: 'synthetic color fixture; no application behavior',
    command: { executable: realpathSync('/opt/homebrew/bin/ffmpeg'), argv: ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=10', '-t', '0.5', '-c:v', 'libx264', join(artifacts, phase + '.mp4')] },
    limits: { maxDurationSeconds: 2, maxRuntimeMs: 5000, maxOutputBytes: 8192, maxArtifactBytes: 1048576, terminateGraceMs: 100 },
  });
  const outputs = [
    { objective: f.task.objective, paths: ['value.txt'], steps: ['Fix value'], acceptanceCriteria: ['Value is after'], risks: [] },
    { summary: 'Correct value', edits: [{ path: 'value.txt', beforeSha256: sha256('before'), content: 'after' }] },
    { verdict: 'pass', findings: [], acceptance: ['Value checked'] },
  ];
  try {
    const result = await runTask({ ...f.options,
      recording: { before: recording('before'), after: recording('after'), probe: { kind: 'ffprobe', executable: probe, sha256: sha256(readFileSync(probe)) } },
      modelFactory: () => ({ complete: async () => outputs[calls++] }),
    });
    assert.equal(result.status, 'needs-video-sharing');
    const receipt = JSON.parse(readFileSync(join(result.artifacts, 'receipt.json'), 'utf8'));
    assert.equal(receipt.run.status, 'blocked');
    assert.equal(JSON.parse(readFileSync(join(result.artifacts, 'video-delivery.json'), 'utf8')).status, 'local-only-blocked');
    assert.equal(readFileSync(join(f.repo, 'value.txt'), 'utf8'), 'before');
  } finally { f.cleanup(); }
});
