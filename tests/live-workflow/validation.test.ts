import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sourcePath,
  safePath,
  coding,
  plan,
  readSources,
  task,
} from "../../src/live-workflow/validation.js";
import {
  CLAUDE_PHASE_MODELS,
  CURSOR_PHASE_MODELS,
  CURSOR_TEST_MODEL,
} from "../../src/live-workflow/routing-profile.js";
test("exact path boundary rejects secrets traversal links and unauthorized model writes", () => {
  for (const p of [
    "../x",
    "/tmp/x",
    "a/../../b",
    ".git/config",
    ".env",
    "a/.env.local",
    ".codex/auth.json",
    "x\\y",
    "node_modules/x",
  ])
    assert.throws(() => sourcePath(p));
  sourcePath("src/app.ts");
  sourcePath(".env.example");
  const d = realpathSync(mkdtempSync(join(tmpdir(), "fm-live-path-")));
  try {
    writeFileSync(join(d, "file"), "ok");
    symlinkSync("/etc/passwd", join(d, "link"));
    assert.throws(() => safePath(d, "link"));
    assert.deepEqual(readSources(d, ["missing"], 100), [
      { path: "missing", sha256: null, content: null },
    ]);
    assert.throws(() =>
      coding(
        {
          summary: "x",
          edits: [{ path: "other", beforeSha256: null, content: "x" }],
        },
        ["file"],
      ),
    );
    assert.throws(() =>
      plan(
        {
          objective: "x",
          paths: ["other"],
          steps: ["x"],
          acceptanceCriteria: ["x"],
          risks: [],
        },
        ["file"],
      ),
    );
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
test("cursor provider routing is owner-fixed and validated", () => {
  const common = {
    schemaVersion: 1,
    taskId: "cursor-route",
    objective: "x",
    readPaths: ["value.txt"],
    writePaths: ["value.txt"],
    checks: [
      { id: "c", executable: "/usr/bin/true", args: [] as string[], timeoutMs: 1000 },
    ],
    effort: "low",
    maxModelRequests: 1,
    maxPromptBytes: 1000,
    maxOutputBytes: 1000,
    maxRuntimeMs: 1000,
    draftPr: false,
  };
  assert.ok(Object.isFrozen(CURSOR_PHASE_MODELS));
  for (const p of ["plan", "coding", "review"] as const)
    assert.equal(CURSOR_PHASE_MODELS[p], "grok-4.7-high");
  assert.equal(CURSOR_TEST_MODEL, "auto");
  for (const model of [CURSOR_PHASE_MODELS.coding, CURSOR_TEST_MODEL]) {
    const r = task({ ...common, provider: "cursor", model });
    assert.equal(r.provider, "cursor");
    assert.equal(r.model, model);
  }
  assert.equal(
    task({ ...common, provider: "cursor", model: "grok-4.7-high", codingMode: "single-call" }).codingMode,
    "single-call",
  );
  for (const model of ["gpt-test", CLAUDE_PHASE_MODELS.coding, "grok-4.7"])
    assert.throws(() => task({ ...common, provider: "cursor", model }), /Invalid model routing/);
  for (const model of ["grok-4.7-high", "auto"])
    for (const provider of [undefined, "openai", "anthropic"])
      assert.throws(() => task({ ...common, provider, model }), /Invalid model routing/);
  for (const provider of ["xai", "Cursor", null])
    assert.throws(() => task({ ...common, provider, model: "gpt-test" }), /Invalid provider/);
  assert.throws(
    () => task({ ...common, provider: "cursor", model: "grok-4.7-high", codingMode: "tools", maxToolCalls: 8 }),
    /Invalid coding mode/,
  );
  assert.equal(task({ ...common, provider: "anthropic", model: CLAUDE_PHASE_MODELS.coding }).provider, "anthropic");
  assert.equal(task({ ...common, provider: "openai", model: "gpt-test" }).provider, "openai");
});
test("check profiles and placeholders are validated", () => {
  const manifest = (check: unknown) => ({
    schemaVersion: 1,
    taskId: "check-profile",
    objective: "x",
    readPaths: ["value.txt"],
    writePaths: ["value.txt"],
    checks: [check],
    model: "gpt-test",
    effort: "low",
    maxModelRequests: 1,
    maxPromptBytes: 1000,
    maxOutputBytes: 1000,
    maxRuntimeMs: 1000,
    draftPr: false,
  });
  const baseCheck = {
    id: "c",
    executable: "/usr/bin/true",
    args: [] as string[],
    timeoutMs: 1000,
  };
  const placeholderArgs = ["--dir={scratch}", "{nodeModules}/x"];
  const ok = task(
    manifest({ ...baseCheck, args: placeholderArgs, profile: "node-project" }),
  );
  assert.equal(ok.checks[0]!.profile, "node-project");
  assert.throws(
    () => task(manifest({ ...baseCheck, profile: "docker" })),
    /Invalid check profile/,
  );
  assert.throws(
    () => task(manifest({ ...baseCheck, args: placeholderArgs })),
    /Check placeholders require the node-project profile/,
  );
  assert.throws(
    () =>
      task(
        manifest({
          ...baseCheck,
          args: placeholderArgs,
          profile: "single-process",
        }),
      ),
    /Check placeholders require the node-project profile/,
  );
  const plain = task(manifest(baseCheck));
  assert.deepEqual(plain.checks[0], baseCheck);
  assert.equal("profile" in plain.checks[0]!, false);
});
test("read scope requires repository value and tools coding mode", () => {
  const common = {
    schemaVersion: 1,
    taskId: "read-scope",
    objective: "x",
    readPaths: ["value.txt"],
    writePaths: ["value.txt"],
    checks: [
      { id: "c", executable: "/usr/bin/true", args: [] as string[], timeoutMs: 1000 },
    ],
    effort: "low",
    maxModelRequests: 1,
    maxPromptBytes: 1000,
    maxOutputBytes: 1000,
    maxRuntimeMs: 1000,
    draftPr: false,
  };
  const anthropic = { ...common, provider: "anthropic", model: CLAUDE_PHASE_MODELS.coding };
  const tools = { ...anthropic, codingMode: "tools", maxToolCalls: 8 };
  assert.equal(task({ ...tools, readScope: "repository" }).readScope, "repository");
  assert.equal("readScope" in task(tools), false);
  for (const s of ["all", "Repository", null])
    assert.throws(() => task({ ...tools, readScope: s }), /Invalid read scope/);
  assert.throws(() => task({ ...anthropic, readScope: "repository" }), /Invalid read scope/);
  assert.throws(
    () => task({ ...anthropic, codingMode: "single-call", readScope: "repository" }),
    /Invalid read scope/,
  );
  assert.throws(
    () => task({ ...common, model: "gpt-test", readScope: "repository" }),
    /Invalid read scope/,
  );
  assert.throws(
    () => task({ ...common, model: "gpt-test", codingMode: "tools", maxToolCalls: 8, readScope: "repository" }),
    /Invalid coding mode/,
  );
});
test("coding mode and tool-call budget are validated", () => {
  const common = {
    schemaVersion: 1,
    taskId: "coding-mode",
    objective: "x",
    readPaths: ["value.txt"],
    writePaths: ["value.txt"],
    checks: [
      { id: "c", executable: "/usr/bin/true", args: [] as string[], timeoutMs: 1000 },
    ],
    effort: "low",
    maxModelRequests: 1,
    maxPromptBytes: 1000,
    maxOutputBytes: 1000,
    maxRuntimeMs: 1000,
    draftPr: false,
  };
  const anthropic = {
    ...common,
    provider: "anthropic",
    model: CLAUDE_PHASE_MODELS.coding,
  };
  const openai = { ...common, model: "gpt-test" };
  assert.equal("codingMode" in task(anthropic), false);
  assert.equal(task({ ...openai, codingMode: "single-call" }).codingMode, "single-call");
  assert.equal(task({ ...anthropic, codingMode: "single-call" }).codingMode, "single-call");
  for (const n of [1, 64]) {
    const r = task({ ...anthropic, codingMode: "tools", maxToolCalls: n });
    assert.equal(r.codingMode, "tools");
    assert.equal(r.maxToolCalls, n);
  }
  for (const m of ["agent", null])
    assert.throws(() => task({ ...anthropic, codingMode: m }), /Invalid coding mode/);
  assert.throws(
    () => task({ ...openai, codingMode: "tools", maxToolCalls: 8 }),
    /Invalid coding mode/,
  );
  assert.throws(
    () => task({ ...openai, provider: "openai", codingMode: "tools", maxToolCalls: 8 }),
    /Invalid coding mode/,
  );
  assert.throws(
    () => task({ ...anthropic, codingMode: "tools" }),
    /Invalid tool-call budget/,
  );
  for (const n of [0, 65, 1.5, "8", -1])
    assert.throws(
      () => task({ ...anthropic, codingMode: "tools", maxToolCalls: n }),
      /Invalid tool-call budget/,
    );
  assert.throws(
    () => task({ ...anthropic, maxToolCalls: 8 }),
    /Invalid tool-call budget/,
  );
  assert.throws(
    () => task({ ...anthropic, codingMode: "single-call", maxToolCalls: 8 }),
    /Invalid tool-call budget/,
  );
  assert.throws(
    () => task({ ...anthropic, toolBudget: 8 }),
    /Unexpected object fields/,
  );
});
