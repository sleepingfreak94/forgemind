import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { CODEX_VERSION, initializeParams, record } from '../agent-drivers/codex-wire.js';
import { JsonlRpc } from '../agent-drivers/jsonl-rpc.js';
import { DriverError } from '../agent-drivers/contracts.js';

// Deliberately limited to initialize. No login, thread/start or turn/start.
const binary = process.argv[2];
if (!binary || !isAbsolute(binary)) throw new DriverError('invalid-input');
const executable = realpathSync(binary);
const scratch = mkdtempSync(join(tmpdir(), 'forgemind-codex-probe-'));
const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', CODEX_HOME: join(scratch, 'codex'), TMPDIR: scratch };
mkdirSync(env.CODEX_HOME, { mode: 0o700 });
try {
  const version = spawnSync(executable, ['--version'], { cwd: scratch, env, encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
  if (version.status !== 0 || version.stdout.trim() !== `codex-cli ${CODEX_VERSION}`) throw new DriverError('invalid-input');
  const child = spawn(executable, ['app-server', '--listen', 'stdio://', '-c', 'analytics.enabled=false'], { cwd: scratch, env, stdio: ['pipe', 'pipe', 'ignore'], shell: false });
  const exit = new Promise<void>((resolve, reject) => { child.once('close', () => resolve()); child.once('error', reject); });
  void exit.catch(() => {});
  const rpc = new JsonlRpc(child.stdout, child.stdin, { timeoutMs: 5000, maxLineBytes: 65536, maxTotalBytes: 1024 * 1024 });
  try {
    const response = record(await rpc.request('initialize', initializeParams));
    if (typeof response.userAgent !== 'string') throw new DriverError('protocol-error');
    await rpc.notify('initialized', {});
    console.log(JSON.stringify({ cliVersion: CODEX_VERSION, handshake: 'passed', isolatedHome: true,
      workspace: 'temporary empty directory', methods: ['initialize', 'initialized'], threadStarts: 0, modelTurns: 0 }, null, 2));
  } finally {
    rpc.close(); child.kill('SIGKILL');
    let timer!: ReturnType<typeof setTimeout>;
    try { await Promise.race([exit, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DriverError('cleanup-failed')), 1000); })]); }
    finally { clearTimeout(timer); }
  }
} finally { await rm(scratch, { recursive: true, force: true }); }
