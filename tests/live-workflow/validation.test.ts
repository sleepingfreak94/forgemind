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
