import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "../../src/live-workflow/orchestrator.js";
import { sha256 } from "../../src/live-workflow/validation.js";
import {
  NativeCodexModel,
  startBroker,
} from "../../src/live-workflow/provider.js";
import type { LiveTask } from "../../src/live-workflow/contracts.js";

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
