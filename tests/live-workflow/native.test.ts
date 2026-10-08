import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { RunAuthority } from "../../src/live-workflow/authority.js";
import { NativeCodexModel } from "../../src/live-workflow/provider.js";
import type { LiveTask } from "../../src/live-workflow/contracts.js";
import { fixtureResponse } from './native-fixture.js';
const binary = join(homedir(), ".local/bin/codex");
test(
  "native 0.161.0 worker completes JSON through loopback fixture under no-fork Seatbelt",
  {
    skip:
      process.platform !== "darwin" ||
      !existsSync(binary),
    timeout: 65000,
  },
  async () => {
    const root = realpathSync(
        mkdtempSync(join(tmpdir(), "fm-native-fixture-")),
      ),
      workspace = join(root, "workspace");
    mkdirSync(workspace);
    const task: LiveTask = {
      schemaVersion: 1,
      taskId: "native-fixture",
      objective: "Return JSON",
      readPaths: ["file"],
      writePaths: ["file"],
      checks: [],
      model: "gpt-6.1-sol",
      effort: "low",
      maxModelRequests: 1,
      maxPromptBytes: 262144,
      maxOutputBytes: 1048576,
      maxRuntimeMs: 60000,
      draftPr: false,
    };
    const source = "a".repeat(64);
    const authority = new RunAuthority(
      join(root, "state"),
      workspace,
      "fixture",
      task,
      source,
    );
    const model = new NativeCodexModel({
      executable: realpathSync(binary),
      task,
      authority,
      source: () => source,
      credentials: () => ({ accessToken: "fixture", accountId: "fixture" }),
      transport: async () => fixtureResponse(task.model,{ok:true}),
    });
    try {
      assert.deepEqual(
        await model.complete(
          "Return JSON",
          { test: true },
          {
            type: "object",
            required: ["ok"],
            additionalProperties: false,
            properties: { ok: { type: "boolean" } },
          },
          AbortSignal.timeout(60000),
        ),
        { ok: true },
      );
    } catch (e) {
      console.error(JSON.stringify(authority.export()));
      throw e;
    } finally {
      authority.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
