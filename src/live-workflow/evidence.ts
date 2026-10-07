import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, lstatSync, openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';

export type EvidencePhase = 'before' | 'after';
export interface ExactCommand { executable: string; argv: readonly string[] }
export interface RecordingLimits {
  maxDurationSeconds: number; maxRuntimeMs: number; maxOutputBytes: number;
  maxArtifactBytes: number; terminateGraceMs: number;
}
export interface RecordingRequest {
  explicitlyRequested: true; taskId: string; scenarioId: string; phase: EvidencePhase;
  /** Immutable commit or snapshot identities; caller is responsible for their provenance. */
  baselineIdentity: string; sourceIdentity: string; artifactsDirectory: string;
  outputPath: string; captureTarget: string; command: ExactCommand; limits: RecordingLimits;
}
export interface ProbeConfiguration {
  kind: 'ffprobe' | 'fixture-only'; executable: string; sha256: string;
}
export interface AuthorizationEnvelope {
  action: 'record' | 'probe'; request: Readonly<RecordingRequest>; command: ExactCommand;
  executableSha256: string; environment: Readonly<Record<string, string>>;
  envelopeSha256: string; probeKind: ProbeConfiguration['kind'];
}
export interface AuthorizationDecision { allowed: boolean; receiptId: string }
export type EvidenceAuthorizer = (envelope: Readonly<AuthorizationEnvelope>) => Promise<AuthorizationDecision>;
export interface EvidenceOptions { authorize: EvidenceAuthorizer; probe: ProbeConfiguration; signal?: AbortSignal }
export interface VideoMetadata { durationSeconds: number; width: number; height: number; frames: number }
export interface EvidenceManifest {
  version: 1; taskId: string; scenarioId: string; phase: EvidencePhase; label: 'Before' | 'After';
  baselineIdentity: string; sourceIdentity: string; captureTarget: string;
  provenance: 'host-recording' | 'fixture-only'; delivery: 'local-only'; artifactPath: string;
  artifactSha256: string; artifactBytes: number; video: VideoMetadata;
  startedAt: string; completedAt: string;
  authorizations: readonly { action: 'record' | 'probe'; receiptId: string; envelopeSha256: string }[];
  manifestSha256: string;
}
const environment = Object.freeze({ LANG: 'C', LC_ALL: 'C' });
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192 || value.includes('\0')) throw new Error('invalid text');
}
function positive(value: number, maximum: number): void {
  if (!Number.isFinite(value) || value <= 0 || value > maximum) throw new Error('invalid limit');
}
/** Every existing component must be a real directory/file, never a symlink. */
function cleanPath(path: string): void {
  text(path);
  if (!isAbsolute(path) || resolve(path) !== path || path.split('/').includes('..')) throw new Error('invalid absolute path');
  const root = parse(path).root;
  let current = root;
  for (const part of relative(root, path).split('/').filter(Boolean)) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error('symlink path forbidden');
  }
}
function artifactPath(request: RecordingRequest, existing: boolean): void {
  cleanPath(request.artifactsDirectory);
  const root = lstatSync(request.artifactsDirectory);
  if (!root.isDirectory() || (root.mode & 0o022)) throw new Error('private task artifacts directory required');
  text(request.outputPath);
  const rel = relative(request.artifactsDirectory, request.outputPath);
  if (!isAbsolute(request.outputPath) || resolve(request.outputPath) !== request.outputPath || !rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('artifact escapes task directory');
  }
  cleanPath(dirname(request.outputPath));
  if (existing) cleanPath(request.outputPath);
  else {
    try { lstatSync(request.outputPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    throw new Error('artifact already exists');
  }
}
function inspectFile(path: string, maximum: number, executable = false): { sha256: string; bytes: number } {
  cleanPath(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size <= 0n || before.size > BigInt(maximum) ||
        (executable && ((Number(before.mode) & 0o6022) !== 0 || (Number(before.mode) & 0o111) === 0))) throw new Error('invalid file');
    const hash = createHash('sha256'), buffer = Buffer.alloc(65536);
    let bytes = 0, count: number;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      bytes += count; if (bytes > maximum) throw new Error('artifact size limit'); hash.update(buffer.subarray(0, count));
    }
    const after = fstatSync(fd, { bigint: true }), linked = lstatSync(path, { bigint: true });
    if ([after, linked].some(s => s.dev !== before.dev || s.ino !== before.ino || s.size !== before.size ||
        s.mtimeNs !== before.mtimeNs || s.ctimeNs !== before.ctimeNs || s.nlink !== 1n)) throw new Error('file changed during validation');
    return { sha256: hash.digest('hex'), bytes };
  } finally { closeSync(fd); }
}
function validateCommand(command: ExactCommand): void {
  text(command.executable);
  if (!isAbsolute(command.executable) || !Array.isArray(command.argv) || command.argv.length > 256 ||
      command.argv.some(arg => typeof arg !== 'string' || arg.includes('\0')) ||
      Buffer.byteLength(JSON.stringify(command.argv)) > 65536) throw new Error('invalid exact command');
}
function validateRequest(request: RecordingRequest): void {
  for (const key of ['taskId', 'scenarioId', 'baselineIdentity', 'sourceIdentity', 'captureTarget'] as const) text(request[key]);
  if (request.explicitlyRequested !== true || !['before', 'after'].includes(request.phase)) throw new Error('explicit recording request required');
  if (request.phase === 'before' && request.baselineIdentity !== request.sourceIdentity) throw new Error('before source mismatch');
  const l = request.limits;
  positive(l.maxDurationSeconds, 3600); positive(l.maxRuntimeMs, 3_660_000);
  positive(l.maxOutputBytes, 16 * 1024 * 1024); positive(l.maxArtifactBytes, 2 * 1024 ** 3);
  positive(l.terminateGraceMs, 5000);
  for (const n of [l.maxRuntimeMs, l.maxOutputBytes, l.maxArtifactBytes, l.terminateGraceMs]) {
    if (!Number.isSafeInteger(n)) throw new Error('integer limit required');
  }
  validateCommand(request.command); artifactPath(request, false);
}
function aborted(signal?: AbortSignal): void { if (signal?.aborted) throw new Error('recording cancelled'); }

/** Cooperative host commands only: process groups are not an OS sandbox or disk quota.
 * The host must approve the exact command, choose the private capture target and prevent
 * concurrent directory mutation. No ambient environment, shell, PATH lookup or stdin.
 */
async function run(command: ExactCommand, request: RecordingRequest, signal?: AbortSignal, watchArtifact = false): Promise<string> {
  aborted(signal);
  if (process.platform === 'win32') throw new Error('POSIX process groups required');
  return new Promise((resolveRun, reject) => {
    const child = spawn(command.executable, [...command.argv], {
      cwd: request.artifactsDirectory, env: environment, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let reason: Error | undefined, bytes = 0, stdout = '', stderr = '', closed = false, reaped = false;
    let exitCode: number | null = null, killTimer: ReturnType<typeof setTimeout> | undefined;
    const killGroup = (kind: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, kind); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') reason ??= new Error('process group termination failed');
      }
    };
    const finish = () => {
      if (!closed || !reaped) return;
      clearTimeout(deadline); clearInterval(monitor); signal?.removeEventListener('abort', cancel);
      if (reason) reject(reason);
      else if (exitCode !== 0) reject(new Error(`command failed (${exitCode})`));
      else if (!watchArtifact && stderr.trim()) reject(new Error('probe reported decoding errors'));
      else resolveRun(stdout);
    };
    const stop = (error?: Error) => {
      reason ??= error;
      if (killTimer) return;
      killGroup('SIGTERM');
      killTimer = setTimeout(() => { killGroup('SIGKILL'); reaped = true; finish(); }, request.limits.terminateGraceMs);
    };
    const cancel = () => stop(new Error('recording cancelled'));
    const deadline = setTimeout(() => stop(new Error('recording timeout')), request.limits.maxRuntimeMs);
    const monitor = setInterval(() => {
      if (!watchArtifact) return;
      try {
        artifactPath(request, true);
        const stat = lstatSync(request.outputPath);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > request.limits.maxArtifactBytes) stop(new Error('artifact output limit or type'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') stop(new Error('unsafe artifact path'));
      }
    }, 20);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > request.limits.maxOutputBytes) stop(new Error('process output limit')); else stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > request.limits.maxOutputBytes) stop(new Error('process output limit')); else stderr += chunk.toString();
    });
    child.on('error', () => stop(new Error('command spawn failed')));
    child.on('exit', code => { exitCode = code; stop(); }); // Also terminate children after a normal parent exit.
    child.on('close', code => { exitCode = code; closed = true; stop(); finish(); });
  });
}

export function ffprobeArgs(path: string): readonly string[] {
  return Object.freeze(['-v', 'error', '-protocol_whitelist', 'file', '-select_streams', 'v:0', '-count_frames',
    '-show_entries', 'stream=codec_type,width,height,nb_read_frames,duration:format=duration', '-of', 'json', '-i', path]);
}
export function parseVideoProbe(raw: string, maximumDuration: number): VideoMetadata {
  positive(maximumDuration, 3600);
  const result = JSON.parse(raw) as { streams?: Record<string, unknown>[]; format?: { duration?: unknown } };
  if (!Array.isArray(result.streams) || result.streams.length !== 1) throw new Error('readable video stream required');
  const stream = result.streams[0]!;
  const number = (value: unknown) => typeof value === 'number' || (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value)) ? Number(value) : NaN;
  const durationSeconds = number(result.format?.duration ?? stream.duration), width = number(stream.width),
    height = number(stream.height), frames = number(stream.nb_read_frames);
  if (stream.codec_type !== 'video' || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > maximumDuration ||
      ![width, height, frames].every(n => Number.isSafeInteger(n) && n > 0) || width > 32768 || height > 32768) throw new Error('invalid video metadata');
  return { durationSeconds, width, height, frames };
}

/** Returns a digest-bound manifest for the host to persist; never claims remote delivery.
 * Fixture probes are explicitly classified and cannot satisfy validateEvidencePair.
 */
export async function recordEvidence(input: RecordingRequest, options: EvidenceOptions): Promise<EvidenceManifest> {
  const request = freeze(structuredClone(input)), probe = freeze(structuredClone(options.probe));
  validateRequest(request); aborted(options.signal);
  if (!['ffprobe', 'fixture-only'].includes(probe.kind) || !/^[a-f0-9]{64}$/.test(probe.sha256)) throw new Error('pinned probe required');
  const receipts: EvidenceManifest['authorizations'][number][] = [];
  const execute = async (action: 'record' | 'probe', command: ExactCommand) => {
    validateCommand(command); aborted(options.signal);
    const executableSha256 = inspectFile(command.executable, 512 * 1024 ** 2, true).sha256;
    if (action === 'probe' && executableSha256 !== probe.sha256) throw new Error('probe pin mismatch');
    const body = { action, request, command, executableSha256, environment, probeKind: probe.kind };
    const envelope = freeze({ ...body, envelopeSha256: digest(JSON.stringify(body)) });
    const decision = await options.authorize(envelope);
    if (decision.allowed !== true) throw new Error('recording authorization denied');
    text(decision.receiptId); aborted(options.signal);
    artifactPath(request, action === 'probe');
    if (inspectFile(command.executable, 512 * 1024 ** 2, true).sha256 !== executableSha256) throw new Error('executable changed after authorization');
    receipts.push({ action, receiptId: decision.receiptId, envelopeSha256: envelope.envelopeSha256 });
    return run(command, request, options.signal, action === 'record');
  };
  // Check the probe before recording, so a missing or wrong validator cannot waste a capture.
  if (inspectFile(probe.executable, 512 * 1024 ** 2, true).sha256 !== probe.sha256) throw new Error('probe pin mismatch');
  const startedAt = new Date().toISOString();
  await execute('record', request.command); aborted(options.signal);
  artifactPath(request, true);
  const artifact = inspectFile(request.outputPath, request.limits.maxArtifactBytes);
  const raw = await execute('probe', freeze({ executable: probe.executable, argv: ffprobeArgs(request.outputPath) }));
  aborted(options.signal); artifactPath(request, true);
  const verified = inspectFile(request.outputPath, request.limits.maxArtifactBytes);
  if (verified.sha256 !== artifact.sha256 || verified.bytes !== artifact.bytes) throw new Error('artifact changed during probe');
  const video = parseVideoProbe(raw, request.limits.maxDurationSeconds);
  const body = { version: 1 as const, taskId: request.taskId, scenarioId: request.scenarioId, phase: request.phase,
    label: request.phase === 'before' ? 'Before' as const : 'After' as const, baselineIdentity: request.baselineIdentity,
    sourceIdentity: request.sourceIdentity, captureTarget: request.captureTarget,
    provenance: probe.kind === 'fixture-only' ? 'fixture-only' as const : 'host-recording' as const,
    delivery: 'local-only' as const, artifactPath: request.outputPath, artifactSha256: artifact.sha256,
    artifactBytes: artifact.bytes, video, startedAt, completedAt: new Date().toISOString(), authorizations: receipts };
  return freeze({ ...body, manifestSha256: digest(JSON.stringify(body)) });
}
export function validateEvidencePair(before: EvidenceManifest, after: EvidenceManifest,
  expected: { taskId: string; scenarioId: string; baselineIdentity: string; sourceIdentity: string }): void {
  for (const item of [before, after]) {
    const { manifestSha256, ...body } = item;
    if (digest(JSON.stringify(body)) !== manifestSha256 || item.provenance !== 'host-recording' || item.delivery !== 'local-only') throw new Error('invalid or fixture evidence');
    if (item.taskId !== expected.taskId || item.scenarioId !== expected.scenarioId || item.baselineIdentity !== expected.baselineIdentity) throw new Error('pair source mismatch');
  }
  if (before.phase !== 'before' || after.phase !== 'after' || before.sourceIdentity !== expected.baselineIdentity ||
      after.sourceIdentity !== expected.sourceIdentity || before.artifactPath === after.artifactPath ||
      before.captureTarget !== after.captureTarget || before.video.width !== after.video.width || before.video.height !== after.video.height) throw new Error('pair source or framing mismatch');
}
export function buildAvfoundationCommand(options: {
  executable: string; deviceIndex: number; outputPath: string; durationSeconds: number; maxArtifactBytes: number; frameRate?: number;
}): ExactCommand {
  if (!Number.isSafeInteger(options.deviceIndex) || options.deviceIndex < 0 || options.deviceIndex > 1024) throw new Error('numeric avfoundation device index required');
  positive(options.durationSeconds, 3600); positive(options.maxArtifactBytes, 2 * 1024 ** 3);
  const frameRate = options.frameRate ?? 15; positive(frameRate, 60);
  if (!Number.isSafeInteger(options.maxArtifactBytes) || !Number.isSafeInteger(frameRate) || !isAbsolute(options.outputPath) ||
      resolve(options.outputPath) !== options.outputPath || options.outputPath.includes('\0')) throw new Error('invalid recording output');
  const command = { executable: options.executable, argv: ['-nostdin', '-n', '-v', 'error', '-f', 'avfoundation',
    '-framerate', String(frameRate), '-i', `${options.deviceIndex}:none`, '-t', String(options.durationSeconds),
    '-fs', String(options.maxArtifactBytes), '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-f', 'mp4', options.outputPath] };
  validateCommand(command); return freeze(command);
}
