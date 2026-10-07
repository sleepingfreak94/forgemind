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
const binary = join(homedir(), ".local/bin/codex");
test(
  "native 0.161.0 worker completes JSON through loopback fixture under no-fork Seatbelt",
  {
    skip:
      process.env.FORGEMIND_NATIVE_DIAGNOSTIC !== "1" ||
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
      transport: async () => {
        const item = {
          id: "msg_fixture",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            { type: "output_text", text: '{"ok":true}', annotations: [] },
          ],
        };
        const response = {
          id: "resp_fixture",
          object: "response",
          created_at: 1,
          status: "completed",
          model: task.model,
          output: [item],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        };
        const events = [
          {
            type: "response.created",
            response: { ...response, status: "in_progress", output: [] },
          },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...item, status: "in_progress", content: [] },
          },
          {
            type: "response.content_part.added",
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          },
          {
            type: "response.output_text.delta",
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            delta: '{"ok":true}',
          },
          { type: "response.output_item.done", output_index: 0, item },
          { type: "response.completed", response },
        ];
        return new Response(
          events.map((e) => "data: " + JSON.stringify(e) + "\n\n").join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
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
