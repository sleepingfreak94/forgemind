import { spawn } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pinFile, verifyFile } from '../host-enforcement/manifest.js';
import { dataSnapshot, object, positive } from '../context-engine/validation.js';
import { text } from './validation.js';
import { BROWSER_QA_MAX_BYTES, validateBrowserQaReport } from './browser-qa.js';
import type { BrowserQaRequest, BrowserQaSetup } from './browser-qa.js';

export interface BrowserQaCommandConfiguration {
  version: 1;
  scenarioId: string;
  executable: string;
  args: readonly string[];
  timeoutMs: number;
  maxOutputBytes: number;
}
const outside = (root: string, path: string) => {
  const rel = relative(root, path); return rel === '..' || rel.startsWith('..' + sep);
};
function canonical(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || /[\x00-\x1f\x7f]/.test(path) || realpathSync(path) !== path)
    throw new Error('Browser QA canonical path required');
}
/** Host-only configuration; no shell, ambient environment, model plugin or task override.
 * This is a cooperative command handoff, not a browser implementation or OS sandbox.
 */
export function loadBrowserQaConfiguration(path: string, workspace: string): BrowserQaSetup {
  canonical(workspace); canonical(path);
  if (!outside(workspace, path)) throw new Error('Browser QA host config must be outside project source');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 65536 ||
      stat.uid !== process.getuid?.() || stat.mode & 0o077) throw new Error('Browser QA private bounded host config required');
  const configPin = pinFile(path);
  const content = readFileSync(path);
  if (content.length > 65536) throw new Error('Browser QA config limit');
  const config = dataSnapshot(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content))) as unknown;
  object(config, ['version', 'scenarioId', 'executable', 'args', 'timeoutMs', 'maxOutputBytes']);
  text(config.scenarioId, 128); text(config.executable, 4096);
  positive(config.timeoutMs, 120000); positive(config.maxOutputBytes, BROWSER_QA_MAX_BYTES);
  if (config.version !== 1 || !Array.isArray(config.args) || config.args.length > 64)
    throw new Error('Browser QA invalid command config');
  config.args.forEach(arg => {
    if (typeof arg !== 'string' || /[\x00-\x1f\x7f]/.test(arg) || Buffer.byteLength(arg) > 8192)
      throw new Error('Browser QA invalid pinned argument');
  });
  if (Buffer.byteLength(JSON.stringify(config.args)) > 16384) throw new Error('Browser QA argument limit');
  canonical(config.executable);
  if (!outside(workspace, config.executable) || !(lstatSync(config.executable).mode & 0o111) ||
      lstatSync(config.executable).size > 256 * 1024 * 1024) throw new Error('Browser QA trusted executable outside source required');
  const executablePin = pinFile(config.executable);
  verifyFile(configPin);
  const command = config as unknown as Readonly<BrowserQaCommandConfiguration>;
  const verify = (hash = true) => { verifyFile(configPin, hash); verifyFile(executablePin, hash); };
  return Object.freeze({ scenarioId: command.scenarioId,
    command: Object.freeze({ configPath: configPin.path, configSha256: configPin.digest,
      executable: executablePin.path, executableSha256: executablePin.digest, args: command.args,
      timeoutMs: command.timeoutMs, maxOutputBytes: command.maxOutputBytes }),
    adapter: async (request: Readonly<BrowserQaRequest>) => {
    request.signal.throwIfAborted(); verify(); canonical(request.workspace);
    if (request.scenarioId !== command.scenarioId || !outside(request.workspace, executablePin.path) || !outside(request.workspace, path))
      throw new Error('Browser QA host configuration binding mismatch');
    const args = [...command.args, '--workspace', request.workspace, '--source', request.currentSource,
      '--baseline-source', request.baselineSource, '--phase', request.phase, '--task-id', request.task.taskId,
      '--scenario-id', request.scenarioId, '--request-id', request.requestId, '--requested-at', String(request.requestedAt)];
    const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'forgemind-browser-qa-'));
    try {
      const stdout = await run(command, args, request, scratch, verify);
      verify(); request.signal.throwIfAborted();
      return validateBrowserQaReport(JSON.parse(stdout), request);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  } });
}
async function run(config: Readonly<BrowserQaCommandConfiguration>, args: string[], request: Readonly<BrowserQaRequest>,
  scratch: string, verify: (hash?: boolean) => void): Promise<string> {
  if (process.platform === 'win32') throw new Error('Browser QA command handoff requires POSIX process groups');
  return new Promise((resolveRun, reject) => {
    const child = spawn(config.executable, args, { cwd: request.workspace, shell: false, detached: true,
      env: { LANG: 'C', LC_ALL: 'C', HOME: scratch, TMPDIR: scratch, XDG_CONFIG_HOME: scratch,
        XDG_CACHE_HOME: scratch, OPENSSL_CONF: '/dev/null' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let bytes = 0, failure: Error | undefined, closed = false, reaped = false, exitCode: number | null = null;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const chunks: Buffer[] = [];
    const killGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= new Error('Browser QA process cleanup failed');
      }
    };
    const finish = () => {
      if (!closed || !reaped) return;
      clearTimeout(deadline); clearInterval(monitor); request.signal.removeEventListener('abort', cancel);
      if (failure) reject(failure);
      else if (exitCode !== 0) reject(new Error('Browser QA command failed'));
      else {
        try { resolveRun(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
        catch { reject(new Error('Browser QA stdout must be UTF-8 JSON')); }
      }
    };
    const stop = (error?: Error) => {
      failure ??= error;
      if (killTimer) return;
      killGroup('SIGTERM');
      killTimer = setTimeout(() => { killGroup('SIGKILL'); reaped = true; finish(); }, 100);
    };
    const cancel = () => stop(new Error('Browser QA command cancelled'));
    const deadline = setTimeout(() => stop(new Error('Browser QA command timeout')), config.timeoutMs);
    const monitor = setInterval(() => {
      try { verify(false); } catch { stop(new Error('Browser QA command/config pin drift')); }
    }, 50);
    request.signal.addEventListener('abort', cancel, { once: true });
    if (request.signal.aborted) cancel();
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > config.maxOutputBytes) stop(new Error('Browser QA command output limit')); else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > config.maxOutputBytes) stop(new Error('Browser QA command output limit'));
    });
    child.on('error', () => stop(new Error('Browser QA command spawn failed')));
    child.on('exit', code => { exitCode = code; stop(); });
    child.on('close', code => { exitCode = code; closed = true; stop(); finish(); });
  });
}
