import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, writeSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inside } from '../policy/validation.js';
import { sourceIdentity } from '../live-workflow/repository.js';
import { privateFile, safeAncestors } from '../live-workflow/continuation-store.js';
import { maxQualificationBytes } from '../live-workflow/qualification-contracts.js';
import type { QualificationBuild } from '../live-workflow/qualification-contracts.js';
import { createQualificationReport, verifyQualificationReport } from '../live-workflow/qualification.js';
import { canonical, digest, integer, lifetime, parseQualificationJson, validateBuild } from '../live-workflow/qualification-validation.js';

export const maxQualificationArtifactBytes = 32 * 1024 * 1024;
export const maxQualificationArtifactTotalBytes = 64 * 1024 * 1024;
export const qualificationHelp = `Usage (after npm run build):
  node dist/src/local-runtime/qualification-cli.js native|supervised --workspace /canonical/repo --input /private/input.json --build /private/build.json --created-at EPOCH_MS --expires-at EPOCH_MS --output /private/report.json [--review /private/review.json]
  node dist/src/local-runtime/qualification-cli.js verify --workspace /canonical/repo --input /private/report.json [--expected-source SHA256]
  node dist/src/local-runtime/qualification-cli.js --help
Offline historical evidence consistency only; authority:none. No services, grants or publication.`;
interface CommonArguments { readonly workspace: string; readonly input: string }
export type QualificationArguments = (CommonArguments & {
  readonly command: 'native' | 'supervised'; readonly build: string; readonly createdAt: number;
  readonly expiresAt: number; readonly output: string; readonly review?: string;
}) | (CommonArguments & { readonly command: 'verify'; readonly expectedSource?: string });
function deny(): never { throw new Error('qualification denied'); }
function canonicalPath(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || path.length > 4096 || /[\x00-\x1f\x7f\\]/.test(path) ||
      (path !== '/' && path.split('/').slice(1).some(part => !part || part === '.' || part === '..'))) deny();
}
/** Reject credential-bearing locations before opening any evidence or build file. */
function evidencePath(path: string): void {
  canonicalPath(path);
  if (path.split('/').some(part => /^(?:\.git|\.aws|\.ssh|\.config|\.codex|\.netrc|\.npmrc|\.pypirc|\.?credentials(?:\..*)?|auth\.json|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/i.test(part) ||
      (part.toLowerCase().startsWith('.env') && part !== '.env.example'))) deny();
}
function timestamp(value: string): number {
  if (!/^[1-9][0-9]{0,15}$/.test(value)) deny();
  return integer(Number(value), 1);
}
export function parseQualificationArgs(argv: readonly string[]): QualificationArguments | 'help' {
  if (argv.length === 1 && argv[0] === '--help') return 'help';
  if (argv.length > 17 || argv.some(arg => typeof arg !== 'string' || !arg || arg.length > 4096 || /[\x00-\x1f\x7f]/.test(arg))) deny();
  const command = argv[0];
  if (command !== 'native' && command !== 'supervised' && command !== 'verify') deny();
  const allowed = ['--workspace', '--input', ...(command === 'verify' ? ['--expected-source'] :
    ['--build', '--created-at', '--expires-at', '--output', '--review'])];
  const flags: Record<string, string> = Object.create(null) as Record<string, string>;
  for (let i = 1; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!key || !allowed.includes(key) || Object.hasOwn(flags, key) || !value || value.startsWith('--')) deny();
    flags[key] = value;
  }
  for (const key of ['--workspace', '--input', ...(command === 'verify' ? [] : ['--build', '--created-at', '--expires-at', '--output'])]) {
    if (!flags[key]) deny();
  }
  for (const key of ['--workspace', '--input', '--build', '--output', '--review']) {
    if (flags[key]) canonicalPath(flags[key]);
  }
  const common = { workspace: flags['--workspace']!, input: flags['--input']! };
  if (command === 'verify') return { ...common, command,
    ...(flags['--expected-source'] ? { expectedSource: digest(flags['--expected-source']) } : {}) };
  const createdAt = timestamp(flags['--created-at']!), expiresAt = timestamp(flags['--expires-at']!);
  if (expiresAt <= createdAt) deny();
  return { ...common, command, build: flags['--build']!, output: flags['--output']!, createdAt, expiresAt,
    ...(flags['--review'] ? { review: flags['--review'] } : {}) };
}
function owner(): number {
  if (!process.getuid) deny();
  return process.getuid();
}
function privateParent(path: string, root: string): void {
  evidencePath(path);
  if (inside(root, path)) deny();
  const parent = dirname(path);
  safeAncestors(parent);
  const st = lstatSync(parent);
  if (st.uid !== owner() || (st.mode & 0o7777) !== 0o700) deny();
}
function regular(st: Stats, privateMode: boolean): void {
  if (!st.isFile() || st.nlink !== 1 || st.uid !== owner() ||
      (privateMode ? (st.mode & 0o7777) !== 0o600 : (st.mode & 0o7022) !== 0)) deny();
}
function unchanged(before: Stats, after: Stats): void {
  if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mode !== after.mode ||
      before.uid !== after.uid || before.nlink !== after.nlink || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) deny();
}
function binding(path: string, fd: number, snapshot: Stats, privateMode: boolean, root: string): void {
  if (privateMode) { privateParent(path, root); privateFile(path); }
  else { evidencePath(path); safeAncestors(dirname(path)); }
  if (realpathSync(path) !== path) deny();
  const current = fstatSync(fd), named = lstatSync(path);
  regular(current, privateMode); regular(named, privateMode);
  unchanged(snapshot, current); unchanged(snapshot, named);
}
/** Bounded nofollow descriptor reads, including UTF-8 roundtrip and complete stat/path binding. */
function readPrivate(path: string, root: string): string {
  privateParent(path, root); privateFile(path);
  const named = lstatSync(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    regular(st, true); unchanged(named, st);
    if (st.size > maxQualificationBytes) deny();
    const bytes = Buffer.alloc(maxQualificationBytes + 1);
    let used = 0;
    while (used < bytes.length) {
      const count = readSync(fd, bytes, used, bytes.length - used, null);
      if (!count) break;
      used += count;
    }
    if (used > maxQualificationBytes || used !== st.size) deny();
    binding(path, fd, st, true, root);
    const raw = bytes.subarray(0, used), text = raw.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(raw)) deny();
    return text;
  } finally { closeSync(fd); }
}
interface ArtifactSnapshot { readonly path: string; readonly sha256: string; readonly stat: Stats }
function artifactPins(build: QualificationBuild, root: string, stable: () => void, previous?: readonly ArtifactSnapshot[]): ArtifactSnapshot[] {
  let total = 0;
  return build.artifacts.map((pin, index) => {
    stable(); evidencePath(pin.path); safeAncestors(dirname(pin.path));
    if (realpathSync(pin.path) !== pin.path) deny();
    const named = lstatSync(pin.path);
    regular(named, false);
    total += named.size;
    if (named.size > maxQualificationArtifactBytes || total > maxQualificationArtifactTotalBytes) deny();
    const fd = openSync(pin.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const st = fstatSync(fd);
      regular(st, false); unchanged(named, st);
      const prior = previous?.[index];
      if (previous && (!prior || prior.path !== pin.path || prior.sha256 !== pin.sha256)) deny();
      if (prior) unchanged(prior.stat, st);
      const hash = createHash('sha256'), chunk = Buffer.alloc(65536);
      let used = 0;
      for (;;) {
        const count = readSync(fd, chunk, 0, Math.min(chunk.length, maxQualificationArtifactBytes + 1 - used), null);
        if (!count) break;
        used += count;
        if (used > maxQualificationArtifactBytes) deny();
        hash.update(chunk.subarray(0, count));
      }
      if (used !== st.size || hash.digest('hex') !== pin.sha256) deny();
      binding(pin.path, fd, st, false, root); stable();
      return { path: pin.path, sha256: pin.sha256, stat: st };
    } finally { closeSync(fd); }
  });
}
export interface QualificationCliPorts {
  /** Host-only injection. The default is the actual repository sourceIdentity reader. */
  readonly source?: (root: string) => string;
  readonly clock?: () => number;
  readonly stdout?: (value: string) => void;
  readonly stderr?: (value: string) => void;
}
function run(args: QualificationArguments, ports: QualificationCliPorts): unknown {
  canonicalPath(args.workspace);
  const root = realpathSync(args.workspace);
  if (args.workspace !== root) deny();
  safeAncestors(root);
  const source = (): string => {
    if (realpathSync(root) !== root) deny();
    return digest((ports.source ?? sourceIdentity)(root));
  };
  const clock = ports.clock ?? Date.now, current = source();
  const stable = (): void => { if (source() !== current) deny(); };
  const read = (path: string): string => { stable(); const text = readPrivate(path, root); stable(); return text; };
  if (args.command === 'verify') {
    const raw = read(args.input);
    const verification = verifyQualificationReport(raw, args.expectedSource ?? current, clock());
    stable();
    return { status: 'historical-evidence-only', evidenceOnly: true, scope: 'historical-evidence-consistency', ...verification };
  }
  lifetime(args.createdAt, args.expiresAt, clock());
  const rawInput = read(args.input), input = parseQualificationJson(rawInput);
  const build = validateBuild(parseQualificationJson(read(args.build)), current);
  const review = args.review === undefined ? undefined : parseQualificationJson(read(args.review));
  const snapshots = artifactPins(build, root, stable);
  stable();
  const report = createQualificationReport({ mode: args.command, input, rawInput, build, expectedSource: current,
    createdAt: args.createdAt, expiresAt: args.expiresAt, now: clock(), ...(review === undefined ? {} : { review }) });
  const bytes = Buffer.from(canonical(report) + '\n', 'utf8');
  if (bytes.length > maxQualificationBytes) deny();
  privateParent(args.output, root);
  artifactPins(build, root, stable, snapshots);
  stable();
  const fd = openSync(args.output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const fresh = fstatSync(fd);
    regular(fresh, true); binding(args.output, fd, fresh, true, root); stable();
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset);
      if (count <= 0) deny();
      offset += count;
    }
    fsyncSync(fd);
    const written = fstatSync(fd);
    if (written.size !== bytes.length) deny();
    binding(args.output, fd, written, true, root); stable();
    artifactPins(build, root, stable, snapshots);
    verifyQualificationReport(report, current, clock());
    stable(); binding(args.output, fd, written, true, root);
  } finally { closeSync(fd); }
  return { status: 'created', digest: report.digest, source: report.source, outcome: report.outcome,
    authority: 'none', scope: 'historical-evidence-consistency' };
}
/** Importing this module performs no execution. Returns an exit code; errors never expose raw evidence. */
export function qualificationMain(argv: readonly string[], ports: QualificationCliPorts = {}): number {
  const stdout = ports.stdout ?? (value => { process.stdout.write(value); });
  const stderr = ports.stderr ?? (value => { process.stderr.write(value); });
  try {
    const args = parseQualificationArgs(argv);
    if (args === 'help') { stdout(qualificationHelp + '\n'); return 0; }
    const result = canonical(run(args, ports));
    if (Buffer.byteLength(result) > 4096) deny();
    stdout(result + '\n'); return 0;
  } catch {
    stderr('{"status":"denied","error":"qualification-request-denied","authority":"none"}\n');
    return 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = qualificationMain(process.argv.slice(2));
