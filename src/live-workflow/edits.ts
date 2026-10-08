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
import type { ActionAuthority, CodingResult, TextReplacementEdit } from "./contracts.js";

/** Resolve all anchors against one original, never text introduced by another operation. */
function replaceText(original: Buffer, edit: TextReplacementEdit): string {
  const content = original.toString("utf8");
  if (original.includes(0) || !Buffer.from(content, "utf8").equals(original))
    throw new Error("Compact edit requires UTF-8 source");
  const ranges = edit.replacements.map(({ before, after }) => {
    const start = content.indexOf(before);
    if (start < 0 || content.indexOf(before, start + 1) !== -1)
      throw new Error("Replacement anchor missing or ambiguous");
    return { start, end: start + before.length, after };
  }).sort((a, b) => a.start - b.start);
  const resultBytes = ranges.reduce((size, range) => size + Buffer.byteLength(range.after) -
    Buffer.byteLength(content.slice(range.start, range.end)), original.length);
  if (resultBytes > 262144) throw new Error("Replacement result limit");
  let result = "", cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) throw new Error("Overlapping replacements");
    result += content.slice(cursor, range.start) + range.after;
    cursor = range.end;
  }
  result += content.slice(cursor);
  if (Buffer.byteLength(result) > 262144) throw new Error("Replacement result limit");
  return result;
}
/** Validate the entire batch before the first write. A failed batch is retained for owner reconciliation. */
export function applyEdits(
  root: string,
  source: string,
  allowed: string[],
  raw: unknown,
  authority: ActionAuthority,
  assertCurrent: () => void,
): CodingResult {
  const input = coding(raw, allowed);
  const before = (path: string): string | null => {
    const file = safePath(root, path, true);
    if (!existsSync(file)) return null;
    const stat = lstatSync(file);
    if (!stat.isFile()) throw new Error("Edit target is not a regular file");
    return sha256(readFileSync(file));
  };
  const proposal: CodingResult = { summary: input.summary, edits: input.edits.map(edit => {
    if (!("format" in edit)) {
      if (before(edit.path) !== edit.beforeSha256) throw new Error("Stale edit preimage");
      if (edit.content === null && edit.beforeSha256 === null)
        throw new Error("Cannot delete absent source");
      return edit;
    }
    const file = safePath(root, edit.path);
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 262144) throw new Error("Invalid compact edit source");
    const original = readFileSync(file);
    if (sha256(original) !== edit.beforeSha256) throw new Error("Stale edit preimage");
    return { path: edit.path, beforeSha256: edit.beforeSha256, content: replaceText(original, edit) };
  }) };
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
