import { spawn } from 'node:child_process';
// This entrypoint receives secrets ONLY over private parent IPC, never argv/logs.
interface Config { executable: string; profile: string; home: string; tmp: string; port: number;
  accessToken: string; deadlineEpochMs: number; maxWireBytes: number }
let child: ReturnType<typeof spawn> | undefined, stopping = false, bytes = 0;
let deadline: ReturnType<typeof setTimeout> | undefined;
function stop() {
  if (stopping) return;
  stopping = true;
  if (!child?.pid) { process.exit(1); return; }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
}
process.on('disconnect', stop);
process.on('SIGTERM', stop); process.on('SIGINT', stop);
process.on('message', (message: unknown) => {
  if (message === 'stop') { stop(); return; }
  if (!message || typeof message !== 'object' || child || stopping) return;
  const config = message as Config;
  if (!process.connected || typeof config.accessToken !== 'string' || !config.accessToken ||
      !Number.isSafeInteger(config.deadlineEpochMs) || config.deadlineEpochMs <= Date.now()) { stop(); return; }
  child = spawn('/usr/bin/sandbox-exec', ['-p', config.profile, config.executable, 'app-server', '--listen', 'stdio://'], {
    cwd: config.home, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { HOME: config.home, CODEX_HOME: config.home, TMPDIR: config.tmp, LANG: 'C', LC_ALL: 'C',
      OPENSSL_CONF: '/dev/null', SSL_CERT_FILE: '/private/etc/ssl/cert.pem', ACCESS_TOKEN: config.accessToken,
      HTTPS_PROXY: `http://127.0.0.1:${config.port}`, HTTP_PROXY: `http://127.0.0.1:${config.port}`, NO_PROXY: '' },
  });
  config.accessToken = '';
  deadline = setTimeout(stop, Math.max(1, config.deadlineEpochMs - Date.now()));
  child.on('error', stop); child.stdin!.on('error', stop);
  process.stdin.pipe(child.stdin!);
  child.stdout!.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > config.maxWireBytes) { stop(); return; }
    if (!process.stdout.write(chunk)) { child!.stdout!.pause(); process.stdout.once('drain', () => child!.stdout!.resume()); }
  });
  // Native stderr may contain credentials in diagnostics: drain without retaining or forwarding.
  child.stderr!.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > config.maxWireBytes) stop(); });
  child.once('spawn', () => process.send?.({ type: 'started', pid: child!.pid }));
  child.once('close', () => {
    if (deadline) clearTimeout(deadline);
    let confirmed = false;
    try { process.kill(-child!.pid!, 'SIGKILL'); } catch {}
    try { process.kill(-child!.pid!, 0); } catch (e) { confirmed = (e as NodeJS.ErrnoException).code === 'ESRCH'; }
    if (process.connected) process.send?.({ type: 'reaped', confirmed }, () => process.exit(confirmed ? 0 : 2));
    else process.exit(confirmed ? 0 : 2);
  });
});
