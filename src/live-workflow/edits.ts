import {
  readFileSync,
  lstatSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { safePath, sha256, coding } from "./validation.js";
import type { ActionAuthority, CodingResult } from "./contracts.js";
/** Validate the entire batch before the first write. A failed batch is retained for owner reconciliation. */
export function applyEdits(
  root: string,
  source: string,
  allowed: string[],
  raw: unknown,
  authority: ActionAuthority,
  assertCurrent: () => void,
): CodingResult {
  const proposal = coding(raw, allowed);
  const before = (path: string): string | null => {
    const file = safePath(root, path, true);
    if (!existsSync(file)) return null;
    const stat = lstatSync(file);
    if (!stat.isFile()) throw new Error("Edit target is not a regular file");
    return sha256(readFileSync(file));
  };
  for (const edit of proposal.edits)
    if (before(edit.path) !== edit.beforeSha256)
      throw new Error("Stale edit preimage");
  assertCurrent();
  const receipt = authority.reserve({
    kind: "files.apply",
    source,
    detail: {
      edits: proposal.edits.map((e) => ({
        path: e.path,
        before: e.beforeSha256,
        after: e.content === null ? null : sha256(e.content),
      })),
    },
  });
  try {
    receipt.check();
    assertCurrent();
    for (const edit of proposal.edits) {
      receipt.check();
      const file = safePath(root, edit.path, true);
      if (before(edit.path) !== edit.beforeSha256)
        throw new Error("Source changed during edit batch");
      if (edit.content === null) {
        if (edit.beforeSha256 === null)
          throw new Error("Cannot delete absent source");
        unlinkSync(file);
      } else {
        mkdirSync(dirname(file), { recursive: true });
        safePath(root, edit.path, true);
        const tmp = file + ".forgemind-" + randomUUID();
        const mode = existsSync(file) ? lstatSync(file).mode & 0o777 : 0o644;
        writeFileSync(tmp, edit.content, { flag: "wx", mode });
        renameSync(tmp, file);
      }
    }
    receipt.finish("completed", sha256(JSON.stringify(proposal.edits)));
    return proposal;
  } catch (error) {
    try {
      receipt.finish("indeterminate");
    } catch {}
    throw error;
  }
}
