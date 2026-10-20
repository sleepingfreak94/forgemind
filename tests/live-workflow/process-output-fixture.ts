import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export interface OutputRun {
  stdout: Buffer;
  stderr: Buffer;
  messages: Record<string, unknown>[];
  code: number | null;
  signal: NodeJS.Signals | null;
  events: string[];
  elapsedMs: number;
}
export async function outputRun(script: string, options: {
  slow?: boolean;
  stalled?: boolean;
  manualDisconnect?: boolean;
  preload?: string;
  maxOutputBytes?: number;
  timeoutMs?: number;
  ready?: (p: ChildProcess) => void;
} = {}): Promise<OutputRun> {
  const cfg = { executable: process.execPath, args: ['-e', script], cwd: process.cwd(),
    env: { LANG: 'C', LC_ALL: 'C' }, profile: '(version 1)(allow default)',
    timeoutMs: options.timeoutMs ?? 5000, maxOutputBytes: options.maxOutputBytes ?? 1048576 };
  const p = fork(fileURLToPath(new URL('../../src/live-workflow/supervisor.js', import.meta.url)),
    [Buffer.from(JSON.stringify(cfg)).toString('base64url')], { execPath: process.execPath,
      execArgv: options.preload ? ['--import', options.preload] : [], env: cfg.env, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  const start = performance.now(), stdout: Buffer[] = [], stderr: Buffer[] = [],
    events: string[] = [], messages: Record<string, unknown>[] = [];
  let ready = false;
  const collect = (chunks: Buffer[], b: Buffer) => {
    chunks.push(b);
    if (chunks === stdout && !ready && Buffer.concat(chunks).includes(10)) {
      ready = true; options.ready?.(p);
    }
  };
  let reader: ReturnType<typeof setInterval> | undefined;
  if (!options.stalled) {
    p.stdout!.on('data', (b: Buffer) => collect(stdout, b));
    p.stderr!.on('data', (b: Buffer) => collect(stderr, b));
  }
  if (options.slow) {
    p.stdout!.pause(); p.stderr!.pause();
    reader = setInterval(() => {
      if (performance.now() - start < 500) return;
      for (const stream of [p.stdout!, p.stderr!]) {
        stream.read(8192);
      }
    }, 2);
  }
  let watchdog = false;
  const kill = setTimeout(() => { watchdog = true; p.kill('SIGTERM'); }, 8000);
  const hardKill = setTimeout(() => { p.kill('SIGKILL'); }, 11000);
  p.on('message', (m: Record<string, unknown>) => { messages.push(m); events.push(String(m.type)); });
  p.on('exit', () => {
    events.push('exit');
    if (options.stalled) {
      p.stdout!.on('data', (b: Buffer) => collect(stdout, b));
      p.stderr!.on('data', (b: Buffer) => collect(stderr, b));
    }
  });
  p.stdin!.on('error', () => {});
  const ends = Promise.all([p.stdout!, p.stderr!].map(stream =>
    new Promise<void>(resolve => stream.once('end', resolve))));
  p.stdin!.end(); p.send('start');
  try {
    const terminal = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      p.on('error', reject);
      if (options.manualDisconnect) p.once('exit', (code, signal) => {
        // Node need not emit ChildProcess close after a manual IPC disconnect.
        // Require supervisor exit, both output ends, and explicit PID checks.
        p.stdin!.destroy();
        void ends.then(() => resolve({ code, signal }));
      });
      p.on('close', (code, signal) => { events.push('close'); resolve({ code, signal }); });
    });
    if (watchdog) throw new Error('Output regression watchdog fired');
    return { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), messages,
      ...terminal, events, elapsedMs: performance.now() - start };
  } finally {
    if (reader) clearInterval(reader);
    clearTimeout(kill); clearTimeout(hardKill);
  }
}
export const workerTree = `const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},100)'],{stdio:'ignore'});process.stdout.write(process.pid+','+c.pid+'\\n');setInterval(()=>{},100);`;
export async function assertGone(pid: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Worker ${pid} survived terminal cleanup`);
}
