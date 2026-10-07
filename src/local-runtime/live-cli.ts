import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  inspectProject,
  LIVE_BLOCK_REASON,
} from "../live-workflow/readiness.js";
import { task } from "../live-workflow/validation.js";

const usage = `Project execution readiness:
  npm run project:inspect -- --workspace /absolute/path/to/repo
  npm run project:run -- --workspace /absolute/path/to/repo --task /absolute/path/to/task.json

Live requests are blocked until subscription-only spending is enforceable.
Run validates the task and reports the block without creating worktrees or reading credentials.
No task option, environment flag, or profile setting can enable live execution.\n`;
function main(): void {
  const [mode, ...raw] = process.argv.slice(2);
  if (mode === "--help" || raw.includes("--help")) {
    process.stdout.write(usage);
    return;
  }
  if (mode !== "inspect" && mode !== "run")
    throw new Error("Expected inspect or run");
  const args: Record<string, string> = {};
  for (let i = 0; i < raw.length; i += 2) {
    const key = raw[i]!,
      value = raw[i + 1];
    if (
      !["--workspace", ...(mode === "run" ? ["--task"] : [])].includes(key) ||
      key in args ||
      !value ||
      value.startsWith("--")
    )
      throw new Error("Invalid arguments");
    args[key] = value;
  }
  if (!args["--workspace"]) throw new Error("Required --workspace");
  const root = realpathSync(resolve(args["--workspace"]));
  if (mode === "inspect") {
    process.stdout.write(JSON.stringify(inspectProject(root), null, 2) + "\n");
    return;
  }
  if (!args["--task"]) throw new Error("Required --task");
  const input = realpathSync(resolve(args["--task"])),
    stat = lstatSync(input);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536)
    throw new Error("Invalid task manifest");
  const manifest = task(JSON.parse(readFileSync(input, "utf8")));
  process.stdout.write(
    JSON.stringify(
      {
        status: "blocked",
        taskId: manifest.taskId,
        workspace: root,
        liveCodingEnabled: false,
        reason: LIVE_BLOCK_REASON,
        worktreeCreated: false,
        providerRequests: 0,
      },
      null,
      2,
    ) + "\n",
  );
  process.exitCode = 2;
}
try {
  main();
} catch (error) {
  process.stderr.write(
    `Project execution: ${error instanceof Error ? error.message : "failed"}. Use --help.\n`,
  );
  process.exitCode = 2;
}
