import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEdits } from "../../src/live-workflow/edits.js";
import { sha256 } from "../../src/live-workflow/validation.js";
test("edit application validates all preimages before any write and limits host to granted paths", () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "fm-edit-")));
  try {
    writeFileSync(join(d, "one"), "before");
    let calls = 0;
    const authority = {
      reserve: () => {
        calls++;
        return { check: () => {}, finish: () => {} };
      },
    };
    assert.throws(() =>
      applyEdits(
        d,
        "source",
        ["one", "two"],
        {
          summary: "x",
          edits: [
            { path: "one", beforeSha256: sha256("before"), content: "after" },
            { path: "two", beforeSha256: sha256("missing"), content: "new" },
          ],
        },
        authority,
        () => {},
      ),
    );
    assert.equal(readFileSync(join(d, "one"), "utf8"), "before");
    assert.equal(calls, 0);
    applyEdits(
      d,
      "source",
      ["one"],
      {
        summary: "x",
        edits: [
          { path: "one", beforeSha256: sha256("before"), content: "after" },
        ],
      },
      authority,
      () => {},
    );
    assert.equal(readFileSync(join(d, "one"), "utf8"), "after");
    assert.equal(calls, 1);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
