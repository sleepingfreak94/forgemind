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
