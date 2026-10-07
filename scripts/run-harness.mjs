#!/usr/bin/env node

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const RUFLO_VERSION = "3.38.0";
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = dirname(scriptDirectory);
const harnessDirectory = join(projectDirectory, ".askme-harness", "ruflo");

const enabledTools = [
  "agent_spawn",
  "agent_status",
  "agent_list",
  "agent_terminate",
  "swarm_init",
  "swarm_status",
  "swarm_health",
  "swarm_shutdown",
  "memory_store",
  "memory_retrieve",
  "memory_search",
  "memory_stats",
  "task_create",
  "task_status",
  "task_list",
  "task_complete",
  "task_update",
  "analyze_diff",
  "analyze_diff-risk",
  "analyze_file-risk",
  "system_health"
];

function toml(value) {
  return JSON.stringify(value);
}

function fail(message) {
  process.stderr.write(`ForgeMind harness: ${message}\n`);
  process.exit(1);
}

function commandAvailable(command) {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

function resolveCodexCommand() {
  const candidates = [
    process.env.CODEX_CLI_PATH,
    "codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex"
  ].filter(Boolean);

  return candidates.find(commandAvailable);
}

const rawArguments = process.argv.slice(2);
const checkOnly = rawArguments.length === 1 && rawArguments[0] === "--check";
if (!checkOnly) {
  fail("Live coding is disabled pending provider, spend and write-policy enforcement. " +
    "Use npm run test:host for the enforced offline host; --check remains a development diagnostic.");
}
const codexCommand = resolveCodexCommand();

if (!codexCommand) {
  fail(
    "Codex CLI was not found. Install it from https://learn.chatgpt.com/docs/codex/cli " +
      "or set CODEX_CLI_PATH to the executable."
  );
}
if (!commandAvailable("npx")) {
  fail("npx is required and was not found on PATH.");
}

mkdirSync(harnessDirectory, { recursive: true });

const configOverrides = [
  ["mcp_servers.ruflo.command", "npx"],
  ["mcp_servers.ruflo.args", ["-y", `ruflo@${RUFLO_VERSION}`, "mcp", "start"]],
  ["mcp_servers.ruflo.cwd", harnessDirectory],
  ["mcp_servers.ruflo.enabled", true],
  ["mcp_servers.ruflo.required", true],
  ["mcp_servers.ruflo.startup_timeout_sec", 120],
  ["mcp_servers.ruflo.tool_timeout_sec", 120],
  ["mcp_servers.ruflo.default_tools_approval_mode", "prompt"],
  ["mcp_servers.ruflo.enabled_tools", enabledTools]
].flatMap(([key, value]) => ["-c", `${key}=${toml(value)}`]);

if (checkOnly) {
  const result = spawnSync(
    codexCommand,
    [...configOverrides, "mcp", "list"],
    { cwd: projectDirectory, stdio: "inherit" }
  );
  process.exit(result.status ?? 1);
}
