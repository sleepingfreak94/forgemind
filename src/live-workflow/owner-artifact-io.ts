import { constants, openSync, closeSync, fstatSync, lstatSync, realpathSync, mkdirSync,
  writeSync, readSync, fsyncSync, opendirSync, linkSync, unlinkSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, resolve, dirname, join, relative, sep } from 'node:path';
import { artifactFault, safeArtifactError, artifactId, artifactName, encodeOwnerJson, exactKeys,
  validateLimits, validateScope, validateProgress, ownerArtifactDefaults } from './owner-artifact-contracts.js';
import type { OwnerArtifactOptions, OwnerArtifactDescriptor, OwnerArtifactReference, OwnerArtifactManifest,
  OwnerArtifactWriter, OwnerArtifactProgress, OwnerJson, OwnerArtifactInspection, OwnerArtifactBundle } from './owner-artifact-contracts.js';

const descriptorName = 'attempt.json', manifestName = 'accepted.json', temporaryName = 'accept-temp.json';
const failureName = 'failure.json', lockName = '.admission';
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const json = <T>(bytes: Buffer): T => JSON.parse(bytes.toString('utf8')) as T;
const equalJson = (a: unknown, b: unknown): boolean => encodeOwnerJson(a, 65536).equals(encodeOwnerJson(b, 65536));
function identity(): number {
  if (process.platform !== 'darwin' || typeof process.getuid !== 'function') artifactFault('IDENTITY');
  const uid = process.getuid();
  if (!Number.isSafeInteger(uid) || uid < 0) artifactFault('IDENTITY');
  return uid;
}
function same(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function privateStat(stat: Stats, uid: number, directory = false, links = 1): void {
  if (stat.uid !== uid || (stat.mode & 0o7777) !== (directory ? 0o700 : 0o600) ||
      (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== links)) artifactFault('PRIVATE');
}
function stable(a: Stats, b: Stats): boolean {
  return same(a, b) && a.uid === b.uid && a.mode === b.mode && a.nlink === b.nlink &&
    a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
type DirectorySnapshot = Stats[];
// Directory contents may change legitimately; identity, owner and mode may not.
function directoryIdentity(a: Stats, b: Stats): boolean {
  return same(a, b) && a.uid === b.uid && a.mode === b.mode;
}
function sameDirectory(a: DirectorySnapshot, b: DirectorySnapshot): boolean {
  return a.length === b.length && a.every((stat, index) => directoryIdentity(stat, b[index]!));
}
/** Ancestors require metadata access only. Pin just the target in the granted
 * source/scratch tree, and revalidate the entire ancestry around the pin and IO.
 * Trusted ancestors must be root/current-owned and not group/world writable. */
function canonical(path: string, uid: number, privateLeaf = false): DirectorySnapshot {
  if (typeof path !== 'string' || path.length > 4096 || path.includes('\0') || !isAbsolute(path) || resolve(path) !== path) artifactFault('PATH');
  const chain: string[] = [];
  for (let current = path; ; current = dirname(current)) {
    chain.push(current);
    if (dirname(current) === current) break;
  }
  chain.reverse();
  const snapshot = (): DirectorySnapshot => {
    const stats = chain.map(current => {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== 0 && stat.uid !== uid) || (stat.mode & 0o022)) artifactFault('PATH');
      return stat;
    });
    if (realpathSync(path) !== path) artifactFault('PATH');
    return stats;
  };
  const before = snapshot(), leaf = before.at(-1)!;
  if (privateLeaf) privateStat(leaf, uid, true);
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (!directoryIdentity(leaf, fstatSync(fd)) || !sameDirectory(before, snapshot()) ||
        !directoryIdentity(leaf, fstatSync(fd))) artifactFault('PATH');
  } finally { closeSync(fd); }
  return before;
}
function overlaps(a: string, b: string): boolean {
  const rel = relative(a, b);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
}
function names(directory: string, maximum: number): string[] {
  const result: string[] = [], handle = opendirSync(directory);
  try {
    for (;;) {
      const entry = handle.readSync();
      if (!entry) return result.sort();
      if (result.length >= maximum) artifactFault('LIMIT');
      result.push(entry.name);
    }
  } finally { handle.closeSync(); }
}
class Context {
  readonly uid: number;
  readonly rootStat: DirectorySnapshot;
  readonly projectStat: DirectorySnapshot;
  readonly descriptor: OwnerArtifactDescriptor;
  readonly options: OwnerArtifactOptions;
  constructor(options: OwnerArtifactOptions, id: string) {
    this.uid = identity();
    artifactId(id);
    // Configuration and fault port are trusted owner inputs, never native RPC.
    const limits = json<OwnerArtifactDescriptor['limits']>(encodeOwnerJson(options.limits ?? ownerArtifactDefaults, 4096));
    const scope = json<OwnerArtifactDescriptor['scope']>(encodeOwnerJson(options.scope, 1024));
    validateLimits(limits); validateScope(scope);
    this.options = { root: options.root, project: options.project, scope, limits,
      ...(options.fault ? { fault: options.fault } : {}) };
    this.rootStat = canonical(options.root, this.uid, true);
    this.projectStat = canonical(options.project, this.uid);
    if (overlaps(options.root, options.project) || overlaps(options.project, options.root)) artifactFault('PATH');
    this.descriptor = { version: 1, id, project: options.project, scope, limits };
  }
  check(): void {
    if (identity() !== this.uid || !sameDirectory(canonical(this.options.root, this.uid, true), this.rootStat) ||
        !sameDirectory(canonical(this.options.project, this.uid), this.projectStat)) artifactFault('PRIVATE');
  }
  point(operation: Parameters<NonNullable<OwnerArtifactOptions['fault']>>[0]['operation'], name: string): void {
    this.options.fault?.({ operation, name });
  }
  sync(directory: string, final = false): void {
    this.check();
    const before = canonical(directory, this.uid, true);
    const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      if (!directoryIdentity(before.at(-1)!, fstatSync(fd))) artifactFault('PRIVATE');
      this.point(final ? 'final-directory-sync' : 'directory-sync', directory);
      fsyncSync(fd);
      if (!sameDirectory(before, canonical(directory, this.uid, true)) ||
          !directoryIdentity(before.at(-1)!, fstatSync(fd))) artifactFault('PRIVATE');
      this.check();
    } finally { closeSync(fd); }
  }
  read(directory: string, name: string, maximum: number, pairedManifest?: Stats): Buffer {
    this.check(); const parent = canonical(directory, this.uid, true);
    const path = join(directory, name), before = lstatSync(path);
    privateStat(before, this.uid, false, pairedManifest ? 2 : 1);
    if (pairedManifest && (name !== manifestName || !stable(before, pairedManifest))) artifactFault('INTEGRITY');
    if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > maximum) artifactFault('LIMIT');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!stable(before, fstatSync(fd))) artifactFault('INTEGRITY');
      const bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (count <= 0) artifactFault('INTEGRITY');
        offset += count;
      }
      if (!stable(before, fstatSync(fd)) || !stable(before, lstatSync(path))) artifactFault('INTEGRITY');
      this.check();
      if (!sameDirectory(parent, canonical(directory, this.uid, true))) artifactFault('PRIVATE');
      return bytes;
    } finally { closeSync(fd); }
  }
  write(directory: string, name: string, bytes: Buffer): void {
    this.check(); const parent = canonical(directory, this.uid, true);
    const path = join(directory, name);
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const initial = fstatSync(fd); privateStat(initial, this.uid);
      if (initial.size !== 0 || !same(initial, lstatSync(path))) artifactFault('INTEGRITY');
      let offset = 0;
      while (offset < bytes.length) {
        this.point('write', name);
        const count = writeSync(fd, bytes, offset, Math.min(4096, bytes.length - offset), offset);
        if (count <= 0) artifactFault('IO');
        offset += count;
      }
      this.point('file-sync', name); fsyncSync(fd);
      const after = fstatSync(fd); privateStat(after, this.uid);
      if (!same(initial, after) || after.size !== bytes.length || !stable(after, lstatSync(path))) artifactFault('INTEGRITY');
    } finally { closeSync(fd); }
    if (!sameDirectory(parent, canonical(directory, this.uid, true)) || !this.read(directory, name, bytes.length).equals(bytes)) artifactFault('INTEGRITY');
    this.sync(directory);
  }
}
function loadDescriptor(context: Context, directory: string, id: string): OwnerArtifactDescriptor {
  const value = json<OwnerArtifactDescriptor>(context.read(directory, descriptorName, 65536));
  exactKeys(value, 'id,limits,project,scope,version');
  if (value.version !== 1 || value.id !== id || value.project !== context.options.project) artifactFault('INTEGRITY');
  validateLimits(value.limits); validateScope(value.scope);
  // A root has one admission profile: changing it never discounts old reservations.
  if (!equalJson(value.limits, context.descriptor.limits)) artifactFault('LIMIT');
  return value;
}
function inventory(context: Context, directory: string, pairedManifest?: Stats): string[] {
  const limits = context.descriptor.limits, entries = names(directory, limits.files);
  let bytes = 0;
  for (const name of entries) {
    if (![descriptorName, manifestName, temporaryName, failureName].includes(name) && !/^progress-[0-9]{3}\.json$/.test(name)) artifactName(name);
    const stat = lstatSync(join(directory, name));
    const paired = pairedManifest && (name === manifestName || name === temporaryName);
    privateStat(stat, context.uid, false, paired ? 2 : 1);
    if (paired && !stable(stat, pairedManifest)) artifactFault('INTEGRITY');
    const maximum = name === descriptorName || name === manifestName || name === temporaryName ? limits.metadataBytes
      : name === failureName ? 1024 : name.startsWith('progress-') ? 256 : limits.artifactBytes;
    if (stat.size > maximum || stat.size < 0) artifactFault('LIMIT');
    bytes += stat.size;
    if (bytes > limits.bundleBytes) artifactFault('LIMIT');
  }
  return entries;
}
function reference(name: string, kind: OwnerArtifactReference['kind'], bytes: Buffer): OwnerArtifactReference {
  return { name, kind, bytes: bytes.length, sha256: digest(bytes) };
}
// Only accept() supplies a guard. Public recovery always requires single links.
function verify(context: Context, directory: string, guard?: { stat: Stats; bytes: Buffer }): OwnerArtifactBundle {
  const expected = loadDescriptor(context, directory, context.descriptor.id);
  if (!equalJson(expected, context.descriptor)) artifactFault('INTEGRITY');
  const entries = inventory(context, directory, guard?.stat), limits = expected.limits;
  if (guard && (!entries.includes(temporaryName) || !entries.includes(manifestName))) artifactFault('INVENTORY');
  const manifestBytes = context.read(directory, manifestName, limits.metadataBytes, guard?.stat);
  if (guard && !manifestBytes.equals(guard.bytes)) artifactFault('INTEGRITY');
  const manifest = json<OwnerArtifactManifest>(manifestBytes);
  exactKeys(manifest, 'attempt,files,trust,version');
  if (manifest.version !== 1 || manifest.trust !== 'evidence-only' || !equalJson(manifest.attempt, expected) ||
      !Array.isArray(manifest.files) || manifest.files.length > limits.files - 1) artifactFault('INTEGRITY');
  const files = new Map<string, Buffer>();
  let progressCount = 0, progressBytes = 0, artifactCount = 0;
  for (const ref of manifest.files) {
    exactKeys(ref, 'bytes,kind,name,sha256');
    if (typeof ref.name !== 'string' || files.has(ref.name) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 1 ||
        typeof ref.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ref.sha256)) artifactFault('INTEGRITY');
    if (ref.kind === 'descriptor') {
      if (ref.name !== descriptorName) artifactFault('INVENTORY');
    } else if (ref.kind === 'artifact') { artifactName(ref.name); artifactCount++; }
    else if (ref.kind === 'progress') {
      if (ref.name !== `progress-${String(progressCount++).padStart(3, '0')}.json`) artifactFault('INVENTORY');
    } else artifactFault('INVENTORY');
    const maximum = ref.kind === 'artifact' ? limits.artifactBytes : ref.kind === 'progress' ? 256 : limits.metadataBytes;
    const body = context.read(directory, ref.name, maximum);
    if (body.length !== ref.bytes || digest(body) !== ref.sha256) artifactFault('INTEGRITY');
    if (ref.kind === 'progress') {
      const event = json<OwnerArtifactProgress>(body); validateProgress(event);
      if (event.status !== 'running') artifactFault('STATE');
      progressBytes += body.length;
    }
    files.set(ref.name, body);
  }
  const expectedNames = [...files.keys(), manifestName, ...(guard ? [temporaryName] : [])].sort();
  if (!files.has(descriptorName) || entries.join(',') !== expectedNames.join(',') ||
      progressCount >= limits.progressEvents || progressBytes > limits.progressBytes - 256 ||
      artifactCount + limits.progressEvents + 4 > limits.files) artifactFault('INVENTORY');
  // Recheck all private metadata after the full bounded read.
  if (inventory(context, directory, guard?.stat).join(',') !== entries.join(',')) artifactFault('INVENTORY');
  context.check();
  return { manifest, files };
}
class Writer implements OwnerArtifactWriter {
  readonly directory: string;
  readonly directoryStat: DirectorySnapshot;
  readonly refs: OwnerArtifactReference[];
  failed = false;
  accepted = false;
  progressCount = 0;
  progressBytes = 0;
  artifactCount = 0;
  constructor(readonly context: Context, descriptor: Buffer) {
    context.point('writer-prepare', context.descriptor.id);
    this.directory = join(context.options.root, context.descriptor.id);
    this.directoryStat = canonical(this.directory, context.uid, true);
    this.refs = [reference(descriptorName, 'descriptor', descriptor)];
  }
  boundary(): void {
    this.context.check();
    if (!sameDirectory(canonical(this.directory, this.context.uid, true), this.directoryStat)) artifactFault('PRIVATE');
    if (this.failed || this.accepted) artifactFault('STATE');
    if (inventory(this.context, this.directory).join(',') !== this.refs.map(ref => ref.name).sort().join(',')) artifactFault('INVENTORY');
  }
  failure(): void {
    this.failed = true;
    try {
      this.context.check();
      if (!sameDirectory(canonical(this.directory, this.context.uid, true), this.directoryStat)) return;
      this.context.write(this.directory, failureName, Buffer.from('{"version":1,"state":"incomplete"}'));
    } catch { /* Preserve every uncertain file; never inspect an unknown error. */ }
  }
  run<T>(operation: () => T): T {
    try { this.boundary(); return operation(); }
    catch (error) { if (!this.accepted) this.failure(); throw safeArtifactError(error); }
  }
  put(name: string, kind: OwnerArtifactReference['kind'], bytes: Buffer): OwnerArtifactReference {
    const limits = this.context.descriptor.limits;
    const used = this.refs.reduce((sum, ref) => sum + ref.bytes, 0);
    const proposedProgressBytes = this.progressBytes + (kind === 'progress' ? bytes.length : 0);
    const reserve = 2 * limits.metadataBytes + 1024 + limits.progressBytes - proposedProgressBytes;
    if (used + bytes.length + reserve > limits.bundleBytes || this.refs.some(ref => ref.name === name)) artifactFault('LIMIT');
    this.context.write(this.directory, name, bytes);
    const ref = reference(name, kind, bytes); this.refs.push(ref);
    return { ...ref };
  }
  writeJson(name: string, value: OwnerJson): OwnerArtifactReference {
    return this.run(() => {
      artifactName(name);
      if (++this.artifactCount + this.context.descriptor.limits.progressEvents + 4 > this.context.descriptor.limits.files) artifactFault('LIMIT');
      return this.put(name, 'artifact', encodeOwnerJson(value, this.context.descriptor.limits.artifactBytes));
    });
  }
  progress(event: OwnerArtifactProgress): OwnerArtifactReference {
    return this.run(() => {
      const bytes = encodeOwnerJson(event, 256), clean = json<OwnerArtifactProgress>(bytes);
      validateProgress(clean);
      const limits = this.context.descriptor.limits, terminal = clean.status === 'incomplete';
      if (this.progressCount >= limits.progressEvents - (terminal ? 0 : 1) ||
          this.progressBytes + bytes.length > limits.progressBytes - (terminal ? 0 : 256)) artifactFault('LIMIT');
      const ref = this.put(`progress-${String(this.progressCount).padStart(3, '0')}.json`, 'progress', bytes);
      this.progressCount++; this.progressBytes += bytes.length;
      if (terminal) this.failure();
      return ref;
    });
  }
  incomplete(): void { this.run(() => { this.failure(); }); }
  accept(): OwnerArtifactManifest {
    return this.run(() => {
      if (!this.artifactCount) artifactFault('STATE');
      // Verify every earlier durable byte before publishing the declared full set.
      for (const ref of this.refs) {
        const bytes = this.context.read(this.directory, ref.name, ref.bytes);
        if (bytes.length !== ref.bytes || digest(bytes) !== ref.sha256) artifactFault('INTEGRITY');
      }
      const manifest: OwnerArtifactManifest = { version: 1, trust: 'evidence-only',
        attempt: this.context.descriptor, files: this.refs.map(ref => ({ ...ref })) };
      const bytes = encodeOwnerJson(manifest, this.context.descriptor.limits.metadataBytes);
      this.context.write(this.directory, temporaryName, bytes);
      const temporary = join(this.directory, temporaryName), target = join(this.directory, manifestName);
      const before = lstatSync(temporary); privateStat(before, this.context.uid);
      this.context.point('publish', manifestName);
      linkSync(temporary, target); // Atomic, exclusive, and never rename-overwrite.
      this.context.point('published', manifestName);
      const linked = lstatSync(target);
      privateStat(linked, this.context.uid, false, 2);
      if (!same(before, linked) || !stable(linked, lstatSync(temporary))) artifactFault('INTEGRITY');
      // Sync the target entry while the original guard still vetoes recovery.
      this.context.sync(this.directory, true);
      const result = verify(this.context, this.directory, { stat: linked, bytes }).manifest;
      if (!sameDirectory(canonical(this.directory, this.context.uid, true), this.directoryStat) ||
          !stable(linked, lstatSync(temporary)) || !stable(linked, lstatSync(target))) artifactFault('INTEGRITY');
      // A failed own unlink cannot be retried. All reads, closes and preparation
      // precede it; successful removal has no fallible tail or durability claim.
      this.accepted = true;
      unlinkSync(temporary);
      return result;
    });
  }
}
/** The root must already exist privately outside the canonical project. A short
 * exclusive admission lock reserves full bundles, not just currently used bytes.
 * Any failed admission retains its lock for owner reconciliation; no stealing. */
export function createOwnerArtifactAttempt(options: OwnerArtifactOptions, id: string): OwnerArtifactWriter {
  try {
    const context = new Context(options, id), limits = context.descriptor.limits;
    const root = context.options.root, lock = join(root, lockName);
    context.write(root, lockName, Buffer.alloc(0));
    const lockStat = lstatSync(lock), entries = names(root, limits.archiveAttempts + 1).filter(name => name !== lockName);
    let reservation = limits.bundleBytes;
    if (entries.length >= limits.archiveAttempts) artifactFault('LIMIT');
    for (const name of entries) {
      artifactId(name);
      const directory = join(root, name); canonical(directory, context.uid, true);
      const previous = loadDescriptor(context, directory, name);
      inventory(context, directory);
      reservation += previous.limits.bundleBytes;
      if (reservation > limits.archiveBytes) artifactFault('LIMIT');
    }
    if (reservation > limits.archiveBytes) artifactFault('LIMIT');
    const descriptor = encodeOwnerJson(context.descriptor, limits.metadataBytes);
    if (descriptor.length + 2 * limits.metadataBytes + 1024 + limits.progressBytes > limits.bundleBytes) artifactFault('LIMIT');
    const directory = join(root, id);
    mkdirSync(directory, { mode: 0o700 });
    const directoryStat = canonical(directory, context.uid, true);
    context.sync(root);
    context.write(directory, descriptorName, descriptor);
    context.sync(root, true);
    const writer = new Writer(context, descriptor);
    if (!sameDirectory(directoryStat, writer.directoryStat)) artifactFault('PRIVATE');
    writer.boundary();
    privateStat(lockStat, context.uid);
    if (!stable(lockStat, lstatSync(lock))) artifactFault('PRIVATE');
    // No sync, constructor, descriptor close or boundary may follow this commit.
    unlinkSync(lock);
    return writer;
  } catch (error) { throw safeArtifactError(error); }
}
export function readOwnerArtifactBundle(options: OwnerArtifactOptions, id: string): OwnerArtifactBundle {
  try {
    const context = new Context(options, id);
    const directory = join(options.root, id); canonical(directory, context.uid, true);
    return verify(context, directory);
  } catch (error) { throw safeArtifactError(error); }
}
/** Inspection reports unfinished evidence without reopening a writer or acquiring
 * any execution capability. It exposes names/status, never arbitrary error text. */
export function inspectOwnerArtifactAttempt(options: OwnerArtifactOptions, id: string): OwnerArtifactInspection {
  try {
    const context = new Context(options, id), directory = join(options.root, id);
    canonical(directory, context.uid, true);
    const attempt = loadDescriptor(context, directory, id);
    if (!equalJson(attempt, context.descriptor)) artifactFault('INTEGRITY');
    const entries = inventory(context, directory);
    if (entries.includes(failureName) || entries.includes(temporaryName)) return {
      state: 'incomplete', reason: entries.includes(failureName) ? 'failed' : 'publication', attempt, names: entries,
    };
    if (!entries.includes(manifestName)) return { state: 'incomplete', reason: 'unaccepted', attempt, names: entries };
    return { state: 'accepted', manifest: verify(context, directory).manifest };
  } catch (error) { throw safeArtifactError(error); }
}
