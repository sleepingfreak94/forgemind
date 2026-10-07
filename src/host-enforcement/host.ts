import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { DriverHost, DriverIntent, DriverLease, DriverTerminal } from '../agent-drivers/contracts.js';
import { DriverError } from '../agent-drivers/contracts.js';
import { JsonlRpc } from '../agent-drivers/jsonl-rpc.js';
import { dataSnapshot, object, serialize } from '../context-engine/validation.js';
import type { LocalPolicyRuntime } from '../policy/runtime.js';
import type { ExternalReservation } from '../policy/contracts.js';
import { assertPreparedPlan, hostEnvelope, hostResource, intentSnapshot, verifyPlan } from './manifest.js';
import type { HostPlan } from './manifest.js';
import { offlineProfile } from './seatbelt.js';
class CleanupUncertain extends Error {}

export interface OfflineHostOptions {
  runtime: LocalPolicyRuntime;
  grantId: string;
  plan: HostPlan;
  /** Private host directory outside the worker workspace and policy database. */
  scratchRoot: string;
}
/** Real durable authorization + macOS Seatbelt. Never enables live provider access. */
export class OfflineSeatbeltHost implements DriverHost {
  readonly #options: OfflineHostOptions;
  #used = false;
  constructor(options: OfflineHostOptions) {
    assertPreparedPlan(options.plan);
    const plan = options.plan, grant = options.runtime.grant(options.grantId), scope = plan.intent.scope;
    if (!grant || grant.principalId !== scope.principalId || grant.sessionId !== scope.sessionId || grant.repositoryId !== scope.projectId ||
        grant.taskId !== scope.taskId || grant.invocationId !== scope.invocationId || grant.policyVersion !== scope.policyVersion ||
        grant.workspaceRoot !== plan.intent.workspaceRoot || plan.intent.expiresAt > grant.expiresAt ||
        !grant.capabilities.some(c => c.action === 'command.run' && c.resource === hostResource(plan))) throw new Error('host grant mismatch');
    const root = realpathSync(options.scratchRoot), stat = lstatSync(root);
    if (root !== options.scratchRoot || !stat.isDirectory() || stat.uid !== process.getuid!() || (stat.mode & 0o077) ||
        !relative(plan.intent.workspaceRoot, root).startsWith(`..${sep}`)) throw new Error('unsafe scratch root');
    this.#options = Object.freeze({ ...options });
  }
  async open(raw: DriverIntent, signal: AbortSignal): Promise<DriverLease> {
    if (this.#used) throw new DriverError('busy');
    const intent = intentSnapshot(raw), { runtime, plan, grantId, scratchRoot } = this.#options;
    // Always reserve the requested canonical envelope first; mismatch cannot launch.
    const resource = serialize(intent) === serialize(plan.intent) ? hostResource(plan) : `host:invalid-${randomUUID()}`;
    const reservation = runtime.reserveExternal(grantId, intent.scope.invocationId, { requestId: randomUUID(), action: 'command.run', resource, sourceSnapshot: intent.scope.sourceSnapshot },
      resource === hostResource(plan) ? hostEnvelope(plan) : undefined);
    this.#used = true;
    let scratch: string | undefined;
    let stop: (() => Promise<void>) | undefined;
    try {
      signal.throwIfAborted(); reservation.check(); verifyPlan(plan);
      if (process.platform !== 'darwin' || !lstatSync('/usr/bin/sandbox-exec').isFile()) throw new Error('native sandbox unavailable');
      scratch = realpathSync(mkdtempSync(join(scratchRoot, 'attempt-')));
      mkdirSync(join(scratch, 'codex'), { mode: 0o700 }); mkdirSync(join(scratch, 'tmp'), { mode: 0o700 });
      mkdirSync(join(scratch, 'cache'), { mode: 0o700 });
      const lease = await this.#launch(plan, scratch, signal, reservation);
      stop = () => lease.stop();
      await lease.check(signal);
      return lease;
    } catch (error) {
      let status: DriverTerminal['status'] = error instanceof CleanupUncertain ? 'indeterminate' : signal.aborted ? 'cancelled' : 'failed';
      try { if (stop) await stop(); } catch { status = 'indeterminate'; }
      reservation.finish(status, undefined, status === 'indeterminate' ? 'cleanup-uncertain' : signal.aborted ? 'cancelled' : 'host-enforcement');
      if (scratch && status !== 'indeterminate') rmSync(scratch, { recursive: true, force: true });
      throw error;
    }
  }
  async #launch(plan: HostPlan, scratch: string, signal: AbortSignal, reservation: ExternalReservation): Promise<DriverLease> {
    const deadline = Math.min(plan.intent.expiresAt, Date.now() + plan.intent.maxRuntimeMs);
    const configuration = { driver: plan.intent.driver, executable: plan.executable.path, args: plan.args, cwd: plan.intent.workspaceRoot,
      profile: offlineProfile(plan, scratch), scratch, deadline, maxOutputBytes: plan.intent.maxOutputBytes };
    reservation.check(); verifyPlan(plan); signal.throwIfAborted();
    const supervisor = spawn(plan.supervisorNode.path, ['--disable-proto=throw', plan.supervisor.path, Buffer.from(JSON.stringify(configuration)).toString('base64url')], {
      cwd: scratch, env: { HOME: scratch, TMPDIR: join(scratch, 'tmp'), OPENSSL_CONF: '/dev/null' }, shell: false, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
    let closed = false, reaped = false, failure: Error | undefined, finished = false, stopping = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const rpc = new JsonlRpc(supervisor.stdout!, supervisor.stdin!, { timeoutMs: 1000, maxLineBytes: Math.min(1024 * 1024, plan.intent.maxOutputBytes), maxTotalBytes: plan.intent.maxOutputBytes, strictJsonrpc: plan.intent.driver === 'cursor' });
    let settle!: () => void;
    const exited = new Promise<void>(resolve => { settle = resolve; });
    let ready!: () => void, rejectReady!: (error: Error) => void;
    const started = new Promise<void>((resolve, reject) => { ready = resolve; rejectReady = reject; });
    const requestStop = () => {
      if (supervisor.connected) supervisor.send('stop', error => { if (error) failure ??= new Error('supervisor disconnected'); });
    };
    const fail = (error: Error) => { failure ??= error; rpc.close(new DriverError('denied')); rejectReady(error); requestStop(); };
    const abort = () => fail(new DriverError('cancelled'));
    const check = async (current: AbortSignal, hash = true) => {
      current.throwIfAborted(); signal.throwIfAborted();
      if (failure || closed || stopping || Date.now() >= deadline) throw failure ?? new Error('host deadline or worker exit');
      reservation.check(); verifyPlan(plan, hash);
    };
    supervisor.on('message', message => {
      const event = message as { type?: string; code?: number | null; signal?: string | null };
      if (event.type === 'started') ready();
      else if (event.type === 'reaped') {
        reaped = true;
        if (!stopping || (event.code !== 0 && event.signal !== 'SIGKILL')) failure ??= new Error('unexpected worker exit');
      }
      else fail(new Error('supervisor enforcement failure'));
    });
    supervisor.once('error', () => { failure ??= new Error('supervisor spawn failed'); rejectReady(failure); });
    supervisor.once('close', () => {
      closed = true; if (timer) clearInterval(timer); signal.removeEventListener('abort', abort);
      rejectReady(new Error('supervisor exited')); settle();
    });
    supervisor.stderr!.on('data', () => {}); // Bounded in supervisor; never print potentially sensitive output.
    rpc.onFailure(error => { if (!finished && error.code !== 'disconnected') fail(error); });
    signal.addEventListener('abort', abort, { once: true });
    timer = setInterval(() => { void check(signal, false).catch(error => fail(error as Error)); }, 25);
    const stop = async () => {
      stopping = true; if (timer) clearInterval(timer); signal.removeEventListener('abort', abort);
      requestStop();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([exited, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('reaping uncertain')), 2500); })]);
      } finally { if (timeout) clearTimeout(timeout); }
      if (!reaped) throw new Error('reaping uncertain');
    };
    try {
      reservation.check(); verifyPlan(plan); signal.throwIfAborted();
      supervisor.send('start', error => { if (error) fail(error); });
      await Promise.race([started, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('supervisor start timeout')), 1000).unref())]);
    } catch (error) {
      try { await stop(); } catch { throw new CleanupUncertain('reaping uncertain'); }
      throw error;
    }
    return Object.freeze({ rpc, receiptId: reservation.receiptId, check, stop,
      finish: async (raw: DriverTerminal) => {
        const terminal = dataSnapshot(raw);
        object(terminal, ['status', 'viewDigest', 'outputDigest']);
        if (!['completed', 'failed', 'interrupted', 'denied', 'cancelled', 'timed-out', 'indeterminate'].includes(terminal.status) ||
            (terminal.outputDigest !== undefined && !/^[a-f0-9]{64}$/.test(terminal.outputDigest))) throw new Error('invalid terminal');
        if (finished || ((!closed || !reaped) && terminal.status !== 'indeterminate')) throw new Error('finish requires confirmed reaping');
        if (terminal.viewDigest !== plan.intent.viewDigest) throw new Error('terminal context mismatch');
        if (terminal.status === 'completed') {
          try { signal.throwIfAborted(); if (Date.now() >= deadline) throw new Error('host deadline'); verifyPlan(plan); }
          catch (error) { failure ??= error as Error; }
        }
        finished = true; rpc.close();
        let receipt: string;
        try { receipt = reservation.finish(failure && terminal.status === 'completed' ? 'denied' : terminal.status,
          { viewDigest: terminal.viewDigest, ...(terminal.outputDigest ? { outputDigest: terminal.outputDigest } : {}) },
          failure ? 'host-enforcement' : 'executor-terminal'); }
        finally { if (closed && reaped) rmSync(scratch, { recursive: true, force: true }); }
        if (failure && terminal.status === 'completed') throw failure;
        return receipt;
      },
    });
  }
}
