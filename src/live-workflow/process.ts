import { fork, execFileSync } from 'node:child_process';
import { realpathSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinFile, verifyFile } from '../host-enforcement/manifest.js';
export interface ProcessRequest {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  profile: string;
  timeoutMs: number;
  maxOutputBytes: number;
  dependencies?: string[];
  input?: string;
  signal?: AbortSignal;
  check?: () => void;
}
export async function supervised(
  request: ProcessRequest,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  if (process.platform !== 'darwin') throw new Error('Live process enforcement currently requires macOS');
  request.signal?.throwIfAborted();
  const executable = pinFile(request.executable),
    supervisor = pinFile(fileURLToPath(new URL('./supervisor.js', import.meta.url)));
  const node = pinFile(process.execPath);
  const dependencies = (request.dependencies ?? []).map((path) => pinFile(path));
  dependencies.forEach((file) => verifyFile(file));
  verifyFile(executable);
  verifyFile(supervisor);
  verifyFile(node);
  request.check?.();
  const config = {
    executable: executable.path,
    args: request.args,
    cwd: request.cwd,
    env: request.env,
    profile: request.profile,
    timeoutMs: request.timeoutMs,
    maxOutputBytes: request.maxOutputBytes,
  };
  return await new Promise((resolve, reject) => {
    const p = fork(supervisor.path, [Buffer.from(JSON.stringify(config)).toString('base64url')], {
      execPath: node.path,
      execArgv: [],
      env: { LANG: 'C', LC_ALL: 'C' },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
    let out = '',
      err = '',
      total = 0,
      reaped = false,
      result: { stdout: string; stderr: string; code: number | null } | undefined,
      failure: Error | undefined;
    const stop = (reason: string) => {
      failure ??= new Error(reason);
      if (p.connected) p.send('stop');
    };
    const abort = () => stop('Cancelled');
    request.signal?.addEventListener('abort', abort, { once: true });
    const poll = setInterval(() => {
      try {
        dependencies.forEach((file) => verifyFile(file, false));
        verifyFile(node, false);
        verifyFile(executable, false);
        verifyFile(supervisor, false);
        request.check?.();
      } catch {
        stop('Authority or executable drift');
      }
    }, 50);
    const deadline = setTimeout(() => stop('Deadline'), request.timeoutMs + 1000);
    const kill = setTimeout(() => {
      failure ??= new Error('Supervisor cleanup uncertain');
      p.kill('SIGKILL');
    }, request.timeoutMs + 5000);
    p.on('message', (m: unknown) => {
      if (!m || typeof m !== 'object') return;
      const v = m as Record<string, unknown>;
      if (v.type === 'stopping') failure ??= new Error(String(v.reason));
      if (v.type === 'reaped') {
        reaped = true;
        result = {
          stdout: out,
          stderr: err,
          code: typeof v.code === 'number' ? v.code : null,
        };
      }
    });
    p.on('error', () => stop('Supervisor failed'));
    p.stdout!.on('data', (b: Buffer) => {
      total += b.length;
      if (total > request.maxOutputBytes) stop('Output limit');
      else out += b.toString();
    });
    p.stderr!.on('data', (b: Buffer) => {
      total += b.length;
      if (total > request.maxOutputBytes) stop('Output limit');
      else err += b.toString();
    });
    p.on('close', () => {
      clearInterval(poll);
      clearTimeout(deadline);
      clearTimeout(kill);
      request.signal?.removeEventListener('abort', abort);
      if (!reaped || !result) return reject(new Error('Supervisor cleanup uncertain'));
      if (failure) return reject(failure);
      try {
        dependencies.forEach((file) => verifyFile(file));
        verifyFile(node);
        verifyFile(executable);
        verifyFile(supervisor);
        request.check?.();
        resolve({ ...result, stdout: out, stderr: err });
      } catch (e) {
        reject(e);
      }
    });
    p.stdin!.on('error', () => {});
    p.stdin!.end(request.input ?? '');
    p.send('start');
  });
}
const literal = (p: string) => `(literal ${JSON.stringify(p)})`;
export function runtimeFiles(executable: string): string[] {
  const files = new Set<string>(),
    entry = realpathSync(executable);
  const visit = (path: string, inherited: string[]) => {
    const p = realpathSync(path);
    if (files.has(p)) return;
    files.add(p);
    const expand = (value: string) =>
      value.replace('@loader_path', dirname(p)).replace('@executable_path', dirname(entry));
    const commands = execFileSync('/usr/bin/otool', ['-l', p], {
      encoding: 'utf8',
      maxBuffer: 1048576,
    });
    const rpaths = [...commands.matchAll(/cmd LC_RPATH\s+cmdsize \d+\s+path (.+?) \(offset/g)]
      .map((m) => resolve(expand(m[1]!)))
      .concat(inherited);
    const output = execFileSync('/usr/bin/otool', ['-L', p], {
      encoding: 'utf8',
      maxBuffer: 1048576,
    });
    for (const line of output.split('\n').slice(1)) {
      const lib = line.trim().split(' ')[0];
      if (!lib || lib.startsWith('/usr/lib/') || lib.startsWith('/System/Library/')) continue;
      const candidates = lib.startsWith('@rpath/')
        ? rpaths.map((r) => resolve(r, lib.slice(7)))
        : [expand(lib)];
      const selected = candidates.find(existsSync);
      if (!selected) throw new Error('Unresolved runtime library');
      visit(selected, rpaths);
    }
  };
  visit(entry, []);
  return [...files];
}
/** Permit Codex managed preferences and the cfprefsd read-only shared-memory caches.
 * No preference writes, broad managed-directory reads, forks, or direct provider egress. */
export function inferenceProfile(
  executable: string,
  scratch: string,
  port: number,
  readFiles: string[],
): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid broker port');
  return `(version 1)\n(deny default)\n(allow process-exec ${literal(realpathSync(executable))})\n(allow process-info* (target same-sandbox))\n(allow sysctl-read)\n(allow file-read-metadata)\n(allow file-read* (literal "/") (subpath "/usr/lib") (subpath "/System/Library") (literal "/dev/null") ${readFiles.map(literal).join(' ')} (subpath ${JSON.stringify(scratch)}))\n(allow file-write* (subpath ${JSON.stringify(scratch)}))\n(allow mach-lookup (global-name "com.apple.cfprefsd.agent") (global-name "com.apple.cfprefsd.daemon"))\n(allow ipc-posix-shm-read* (ipc-posix-name "apple.cfprefs.${process.getuid!()}v1") (ipc-posix-name "apple.cfprefs.daemonv1"))\n(allow user-preference-read (preference-domain "com.openai.codex"))\n(allow file-read-data (literal "/private/etc/codex/requirements.toml") (literal "/private/etc/codex/managed_config.toml") (literal "/private/etc/codex/config.toml"))\n(allow network-outbound (remote ip "localhost:${port}"))`;
}
