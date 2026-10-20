import { spawn } from "node:child_process";
// Host launches this pinned supervisor with private IPC. Child cannot inherit IPC.
const cfg = JSON.parse(
  Buffer.from(process.argv[2]!, "base64url").toString(),
) as {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  profile: string;
  timeoutMs: number;
  maxOutputBytes: number;
};
let child: ReturnType<typeof spawn> | undefined,
  total = 0,
  stopping = false,
  reaped = false;
let timer: ReturnType<typeof setTimeout> | undefined;
function stop(reason: string) {
  if (stopping) return;
  stopping = true;
  if (process.connected) process.send?.({ type: "stopping", reason }, () => {});
  if (child?.pid && !reaped) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  } else if (!child) process.exit(1);
  setTimeout(() => process.exit(2), 2000).unref();
}
process.stdout.on("error", () => stop("output-failed"));
process.stderr.on("error", () => stop("output-failed"));
process.on("disconnect", () => stop("parent-disconnected"));
process.on("SIGTERM", () => stop("cancelled"));
process.on("SIGINT", () => stop("cancelled"));
process.on("message", (m) => {
  if (m === "stop") {
    stop("cancelled");
    return;
  }
  if (m !== "start" || child || stopping) return;
  child = spawn(
    "/usr/bin/sandbox-exec",
    ["-p", cfg.profile, cfg.executable, ...cfg.args],
    {
      cwd: cfg.cwd,
      env: cfg.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  timer = setTimeout(() => stop("deadline"), cfg.timeoutMs);
  child.on("error", () => stop("spawn-failed"));
  child.stdin!.on("error", () => {});
  process.stdin.pipe(child.stdin!);
  for (const [source, destination] of [
    [child.stdout!, process.stdout],
    [child.stderr!, process.stderr],
  ] as const)
    source.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > cfg.maxOutputBytes) {
        stop("output-limit");
        return;
      }
      if (!destination.write(chunk)) {
        source.pause();
        destination.once("drain", () => source.resume());
      }
    });
  child.on("close", (code, signal) => {
    reaped = true;
    if (timer) clearTimeout(timer);
    if (child?.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
    // Child close does not flush writes already queued on our parent pipes.
    // Bound both output completion and terminal IPC; no receipt on drain failure.
    setTimeout(() => {
      stop("output-drain-timeout");
      process.exit(2);
    }, 2000);
    let pending = 2;
    const drained = () => {
      if (--pending) return;
      if (process.connected)
        process.send?.({ type: "reaped", code, signal, stopping }, () =>
          process.exit(0),
        );
      else process.exit(0);
    };
    process.stdout.once("finish", drained);
    process.stderr.once("finish", drained);
    process.stdout.end();
    process.stderr.end();
  });
});
