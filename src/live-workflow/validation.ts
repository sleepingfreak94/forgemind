import { createHash } from "node:crypto";
import { lstatSync, realpathSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve, relative } from "node:path";
import type {
  LiveTask,
  GeneratedPlan,
  CodingProposal,
  ReviewResult,
} from "./contracts.js";
export const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
export function object(
  value: unknown,
  keys: string[],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    throw new Error("Unexpected object fields");
}
export function text(value: unknown, max = 8192): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    Buffer.byteLength(value) > max ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)
  )
    throw new Error("Invalid text");
}
function integer(value: unknown, max: number): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max)
    throw new Error("Invalid bound");
}
export function sourcePath(value: unknown): asserts value is string {
  text(value, 1024);
  if (
    isAbsolute(value) ||
    /[\\\x00-\x1f]/.test(value) ||
    value
      .split("/")
      .some(
        (p) =>
          !p ||
          p === "." ||
          p === ".." ||
          p === ".git" ||
          p === ".codex" ||
          p === ".ssh" ||
          p === ".aws" ||
          p === ".vercel" ||
          p === "node_modules" ||
          p === "vendor" ||
          p === "dist" ||
          p === "build" ||
          (/^(?:\.env(?:\..*)?|auth\.json|credentials.*|.*\.(?:pem|key|p12))$/i.test(
            p,
          ) &&
            p !== ".env.example"),
      )
  )
    throw new Error("Unsafe or secret source path");
}
export function safePath(root: string, path: string, missing = false): string {
  sourcePath(path);
  if (realpathSync(root) !== root)
    throw new Error("Workspace must be canonical");
  let current = root;
  const parts = path.split("/");
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    try {
      const s = lstatSync(current);
      if (
        s.isSymbolicLink() ||
        (!s.isDirectory() && i < parts.length - 1) ||
        (s.isFile() && s.nlink !== 1)
      )
        throw new Error("Unsafe source link");
    } catch (e) {
      if (!missing || (e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return current;
}
export function task(raw: unknown): LiveTask {
  object(raw, [
    "schemaVersion",
    "taskId",
    "objective",
    "readPaths",
    "writePaths",
    "checks",
    "model",
    "effort",
    "maxModelRequests",
    "maxPromptBytes",
    "maxOutputBytes",
    "maxRuntimeMs",
    "draftPr",
  ]);
  if (raw.schemaVersion !== 1 || typeof raw.draftPr !== "boolean")
    throw new Error("Invalid task version/preferences");
  text(raw.taskId, 80);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(raw.taskId))
    throw new Error("Invalid task ID");
  text(raw.objective);
  text(raw.model, 100);
  if (
    !/^[a-zA-Z0-9._-]+$/.test(raw.model) ||
    !["low", "medium", "high"].includes(String(raw.effort))
  )
    throw new Error("Invalid model routing");
  for (const key of ["readPaths", "writePaths"] as const) {
    const list = raw[key];
    if (
      !Array.isArray(list) ||
      !list.length ||
      list.length > 100 ||
      new Set(list).size !== list.length
    )
      throw new Error("Exact source paths required");
    list.forEach(sourcePath);
  }
  if (
    !Array.isArray(raw.checks) ||
    !raw.checks.length ||
    raw.checks.length > 12
  )
    throw new Error("Checks required");
  for (const c of raw.checks) {
    object(c, ["id", "executable", "args", "timeoutMs"]);
    text(c.id, 80);
    text(c.executable, 4096);
    if (
      !isAbsolute(c.executable) ||
      !Array.isArray(c.args) ||
      c.args.length > 64 ||
      c.args.some((a) => typeof a !== "string" || a.includes("\0"))
    )
      throw new Error("Exact command required");
    integer(c.timeoutMs, 300000);
  }
  integer(raw.maxModelRequests, 12);
  integer(raw.maxPromptBytes, 262144);
  integer(raw.maxOutputBytes, 2097152);
  integer(raw.maxRuntimeMs, 900000);
  return structuredClone(raw) as unknown as LiveTask;
}
export function plan(raw: unknown, allowed: string[]): GeneratedPlan {
  object(raw, ["objective", "paths", "steps", "acceptanceCriteria", "risks"]);
  text(raw.objective);
  for (const key of ["paths", "steps", "acceptanceCriteria", "risks"]) {
    const v = raw[key];
    if (!Array.isArray(v) || v.length > 100 || (key !== "risks" && !v.length))
      throw new Error("Incomplete plan");
    v.forEach((x) => text(x));
  }
  if ((raw.paths as string[]).some((p) => !allowed.includes(p)))
    throw new Error("Plan expands write scope");
  return raw as unknown as GeneratedPlan;
}
export function coding(raw: unknown, allowed: string[]): CodingProposal {
  object(raw, ["summary", "edits"]);
  text(raw.summary);
  if (!Array.isArray(raw.edits) || !raw.edits.length || raw.edits.length > 100)
    throw new Error("Missing edits");
  const seen = new Set();
  let replacementBytes = 0;
  for (const edit of raw.edits) {
    const compact = !!edit && typeof edit === "object" && "format" in edit;
    object(edit, compact ? ["path", "beforeSha256", "format", "replacements"] : ["path", "beforeSha256", "content"]);
    sourcePath(edit.path);
    if (!allowed.includes(edit.path) || seen.has(edit.path))
      throw new Error("Edit outside grant or duplicated");
    seen.add(edit.path);
    if (
      edit.beforeSha256 !== null &&
      (typeof edit.beforeSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(edit.beforeSha256))
    )
      throw new Error("Edit source digest missing");
    if (compact) {
      if (edit.format !== "text-replacements-v1" || edit.beforeSha256 === null ||
          !Array.isArray(edit.replacements) || !edit.replacements.length || edit.replacements.length > 100)
        throw new Error("Invalid compact edit");
      for (const replacement of edit.replacements) {
        object(replacement, ["before", "after"]);
        for (const key of ["before", "after"] as const) {
          const value = replacement[key];
          if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value) > 262144 ||
              Buffer.from(value, "utf8").toString("utf8") !== value)
            throw new Error("Invalid replacement text");
          replacementBytes += Buffer.byteLength(value);
        }
        if (replacement.before === "" || replacement.before === replacement.after)
          throw new Error("Empty or unchanged replacement");
      }
      if (replacementBytes > 1048576) throw new Error("Replacement payload limit");
    } else if (
      edit.content !== null &&
      (typeof edit.content !== "string" ||
        Buffer.byteLength(edit.content) > 262144 ||
        edit.content.includes("\0"))
    )
      throw new Error("Invalid edit content");
  }
  return raw as unknown as CodingProposal;
}
export function review(raw: unknown): ReviewResult {
  object(raw, ["verdict", "findings", "acceptance"]);
  if (!["pass", "revise", "blocked"].includes(String(raw.verdict)))
    throw new Error("Invalid review verdict");
  for (const key of ["findings", "acceptance"]) {
    if (!Array.isArray(raw[key]) || (raw[key] as unknown[]).length > 100)
      throw new Error("Invalid review");
    (raw[key] as unknown[]).forEach((v) => text(v));
  }
  return raw as unknown as ReviewResult;
}
export function readSources(
  root: string,
  paths: string[],
  limit: number,
): { path: string; sha256: string | null; content: string | null }[] {
  let bytes = 0;
  return paths.map((path) => {
    const p = safePath(root, path, true);
    try {
      const stat = lstatSync(p);
      if (!stat.isFile() || stat.size > limit)
        throw new Error("Source file limit");
      const b = readFileSync(p);
      bytes += b.length;
      if (bytes > limit || b.includes(0))
        throw new Error("Source context limit/binary input");
      return { path, sha256: sha256(b), content: b.toString("utf8") };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        return { path, sha256: null, content: null };
      throw e;
    }
  });
}
