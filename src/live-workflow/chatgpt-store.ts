import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname, isAbsolute, join, normalize, parse, relative, sep } from 'node:path';

export interface ChatGPTConnection {
  schemaVersion: 1;
  hostId: string;
  clientId: string;
  subject: string;
  accessToken: string;
  refreshToken?: string;
  idToken: string;
  scope: string;
  /** Unix time in milliseconds. Expiry requires reconnect; no automatic refresh. */
  expiresAt: number;
  email?: string;
}

const MAX_BYTES = 128 * 1024;
const DIRECT_SCOPE = 'chatgpt.tokens.use.direct';
const CONNECTION = 'chatgpt-connection.json';
const HOST = 'chatgpt-host.json';
const LOCK = 'chatgpt.lock';
const BILLING_REVIEW = 'chatgpt-billing-review.json';
export interface ChatGPTBillingReview {
  schemaVersion: 1;
  accountSha256: string;
  identitySha256: string;
  confirmedAt: number;
  reviewId: string;
}
export const chatGPTAccountFingerprint = (c: ChatGPTConnection): string =>
  createHash('sha256').update(JSON.stringify([c.clientId, c.subject])).digest('hex');
const billingIdentity = (c: ChatGPTConnection): string =>
  createHash('sha256').update(JSON.stringify([c.hostId, c.clientId, c.subject, c.email])).digest('hex');
export const requestedChatGPTScopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';

class ChatGPTAuthError extends Error {}
export function authError(message: string): Error { return new ChatGPTAuthError(`ChatGPT connection: ${message}`); }
export function isAuthError(error: unknown): error is Error { return error instanceof ChatGPTAuthError; }
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw authError('invalid data');
  return value as Record<string, unknown>;
}
export function textField(value: unknown, max = 32768): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
}
export function issuedClient(value: unknown): value is string {
  return textField(value, 256) && /^[A-Za-z0-9_-]+$/.test(value) && value !== 'dynamic_agent_client';
}
export function directScope(scope: unknown): scope is string {
  return textField(scope, 4096) && scope.split(' ').includes(DIRECT_SCOPE);
}
function hostId(value: unknown): value is string {
  return typeof value === 'string' && /^urn:uuid:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
}
export function validateConnection(value: unknown, allowExpired = false): ChatGPTConnection {
  const v = record(value);
  const fields = ['schemaVersion', 'hostId', 'clientId', 'subject', 'accessToken', 'refreshToken', 'idToken', 'scope', 'expiresAt', 'email'];
  if (Object.keys(v).some(key => !fields.includes(key)) || v.schemaVersion !== 1 || !hostId(v.hostId)
    || !issuedClient(v.clientId) || !textField(v.subject, 512) || !textField(v.accessToken)
    || !textField(v.idToken, 65536) || v.idToken.split('.').length !== 3 || !directScope(v.scope)
    || !Number.isSafeInteger(v.expiresAt) || (v.expiresAt as number) <= 0
    || (v.refreshToken !== undefined && !textField(v.refreshToken))
    || (v.email !== undefined && !textField(v.email, 320))) throw authError('invalid stored credentials; reconnect');
  if (!allowExpired && (v.expiresAt as number) <= Date.now()) throw authError('expired; reconnect required');
  return v as unknown as ChatGPTConnection;
}
function sameFile(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function secureFile(s: Stats): void {
  if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid?.() || (s.mode & 0o7777) !== 0o600)
    throw authError('unsafe credential file');
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }
function inside(root: string, path: string): boolean {
  const r = relative(root, path);
  return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}
function outsideGit(directory: string): void {
  let part = directory;
  for (;;) {
    try { lstatSync(join(part, '.git')); throw authError('state must be outside every Git checkout'); }
    catch (e) { if (!missing(e)) throw e; }
    const parent = dirname(part);
    if (parent === part) return;
    part = parent;
  }
}
function checkAncestors(directory: string): void {
  let part = parse(directory).root;
  for (const segment of directory.slice(part.length).split(sep).filter(Boolean)) {
    part = join(part, segment);
    const s = lstatSync(part);
    if (!s.isDirectory() || s.isSymbolicLink() || ((s.mode & 0o022) !== 0 && (s.mode & 0o1000) === 0))
      throw authError('unsafe state path');
  }
}

/** Internal storage primitive: no credential import or environment/ambient credential lookup. */
export class ChatGPTStore {
  private fd: number;
  private identity: Stats;
  private lockFd: number | undefined;
  private lockIdentity: Stats | undefined;
  readonly directory: string;
  constructor(directory: string, projectRoot = process.cwd(), create = false) {
    try {
      if (!isAbsolute(directory) || normalize(directory) !== directory) throw authError('state path must be canonical and absolute');
      const project = realpathSync(projectRoot);
      if (inside(project, directory)) throw authError('state must be outside the project');
      outsideGit(directory);
      if (create) {
        checkAncestors(dirname(directory));
        try { mkdirSync(directory, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      }
      checkAncestors(directory);
      if (realpathSync(directory) !== directory) throw authError('state path must be canonical');
      this.directory = directory;
      this.fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      this.identity = fstatSync(this.fd);
      try { this.check(); } catch (e) { closeSync(this.fd); throw e; }
    } catch { throw authError('unsafe or unavailable state directory (must be canonical, owner-only, outside project)'); }
  }
  private check(): void {
    outsideGit(this.directory);
    checkAncestors(this.directory);
    const s = lstatSync(this.directory);
    if (!sameFile(s, this.identity) || !s.isDirectory() || s.uid !== process.getuid?.()
      || (s.mode & 0o7777) !== 0o700 || realpathSync(this.directory) !== this.directory)
      throw authError('state directory changed or is unsafe');
  }
  private read(name: string, parseJSON = true): unknown | undefined {
    this.check();
    let fd: number;
    try { fd = openSync(join(this.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (e) { if (missing(e)) return undefined; throw authError('unavailable credential file'); }
    try {
      const before = fstatSync(fd);
      secureFile(before);
      if (before.size > MAX_BYTES) throw authError('credential file exceeds limit');
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      let count = 0, n = 0;
      do { n = readSync(fd, bytes, count, bytes.length - count, null); count += n; } while (n && count < bytes.length);
      const after = fstatSync(fd);
      secureFile(after);
      this.check();
      const current = lstatSync(join(this.directory, name));
      secureFile(current);
      if (count > MAX_BYTES || !sameFile(before, after) || before.size !== after.size
        || before.ctimeMs !== after.ctimeMs || !sameFile(after, current) || after.ctimeMs !== current.ctimeMs)
        throw authError('credential file changed or exceeds limit');
      return parseJSON ? JSON.parse(bytes.subarray(0, count).toString('utf8')) as unknown : true;
    } catch { throw authError('unsafe or invalid credential file'); }
    finally { closeSync(fd); }
  }
  private checkLock(): void {
    this.check();
    if (this.lockFd === undefined || !this.lockIdentity) throw authError('storage lock required');
    const held = fstatSync(this.lockFd), current = lstatSync(join(this.directory, LOCK));
    secureFile(held); secureFile(current);
    if (!sameFile(held, this.lockIdentity) || !sameFile(current, this.lockIdentity)) throw authError('storage lock changed');
  }
  private write(name: string, value: unknown): void {
    this.checkLock();
    this.read(name); // Validate any existing target; never replace a linked or unsafe file.
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > MAX_BYTES) throw authError('credential file exceeds limit');
    const temp = join(this.directory, `.chatgpt-${randomBytes(16).toString('hex')}.tmp`);
    let fd: number | undefined;
    let renamed = false;
    try {
      fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      secureFile(fstatSync(fd));
      writeFileSync(fd, bytes);
      fsyncSync(fd);
      const tempIdentity = fstatSync(fd), tempPathIdentity = lstatSync(temp);
      secureFile(tempIdentity); secureFile(tempPathIdentity);
      if (!sameFile(tempIdentity, tempPathIdentity)) throw authError('temporary credential file changed');
      this.checkLock();
      this.read(name);
      renameSync(temp, join(this.directory, name));
      renamed = true;
      fsyncSync(this.fd);
    } catch { throw authError('could not safely persist credentials'); }
    finally { if (fd !== undefined) closeSync(fd); if (!renamed) { try { unlinkSync(temp); } catch { /* no blind retry */ } } }
  }
  lock(): void {
    this.check();
    if (this.lockFd !== undefined) throw authError('storage already locked');
    try { this.lockFd = openSync(join(this.directory, LOCK), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch { throw authError('state is locked; inspect existing lock before reconnecting'); }
    this.lockIdentity = fstatSync(this.lockFd);
    secureFile(this.lockIdentity);
    writeFileSync(this.lockFd, randomBytes(32).toString('hex'));
    fsyncSync(this.lockFd);
    fsyncSync(this.fd);
  }
  getHostId(): string {
    const v = this.read(HOST);
    if (v === undefined) {
      if (this.read(CONNECTION) !== undefined) throw authError('missing host registration');
      const b = randomBytes(16); b[6] = (b[6]! & 15) | 64; b[8] = (b[8]! & 63) | 128;
      const hex = b.toString('hex');
      const id = `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      this.write(HOST, { schemaVersion: 1, hostId: id });
      return id;
    }
    const data = record(v);
    if (data.schemaVersion !== 1 || !hostId(data.hostId) || Object.keys(data).length !== 2) throw authError('invalid host registration');
    return data.hostId;
  }
  connection(allowExpired = false): ChatGPTConnection | undefined {
    const v = this.read(CONNECTION);
    if (v === undefined) return undefined;
    const c = validateConnection(v, allowExpired);
    const host = record(this.read(HOST));
    if (host.schemaVersion !== 1 || host.hostId !== c.hostId) throw authError('host identity mismatch');
    return c;
  }
  save(connection: ChatGPTConnection): void {
    const c = validateConnection(connection);
    if (c.hostId !== this.getHostId()) throw authError('host identity mismatch');
    const previous = this.connection(true);
    if (previous && (previous.clientId !== c.clientId || previous.subject !== c.subject)) throw authError('account identity mismatch');
    // Reconnecting an intact account retains its review; a disconnected record does not.
    if (!previous) this.forgetBillingReview();
    this.write(CONNECTION, c);
  }
  billingReview(connection: ChatGPTConnection): ChatGPTBillingReview | undefined {
    const value = this.read(BILLING_REVIEW);
    if (value === undefined) return undefined;
    const v = record(value);
    if (Object.keys(v).sort().join(',') !== 'accountSha256,confirmedAt,identitySha256,reviewId,schemaVersion'
      || v.schemaVersion !== 1 || typeof v.accountSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(v.accountSha256)
      || typeof v.identitySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(v.identitySha256)
      || typeof v.reviewId !== 'string' || !/^[a-f0-9]{32}$/.test(v.reviewId)
      || !Number.isSafeInteger(v.confirmedAt) || (v.confirmedAt as number) <= 0)
      throw authError('invalid billing acknowledgement; reset it before confirming again');
    if (v.accountSha256 !== chatGPTAccountFingerprint(connection) || v.identitySha256 !== billingIdentity(connection))
      return undefined;
    return v as unknown as ChatGPTBillingReview;
  }
  /** Trusted owner assertion only. No server setting is inspected or changed. */
  confirmBillingReview(connection: ChatGPTConnection): ChatGPTBillingReview {
    this.checkLock();
    if (JSON.stringify(this.connection(true)) !== JSON.stringify(connection)) throw authError('connection changed during account review');
    const review: ChatGPTBillingReview = { schemaVersion: 1, accountSha256: chatGPTAccountFingerprint(connection),
      identitySha256: billingIdentity(connection), confirmedAt: Date.now(), reviewId: randomBytes(16).toString('hex') };
    this.write(BILLING_REVIEW, review);
    return review;
  }
  forgetBillingReview(): void {
    this.checkLock();
    if (this.read(BILLING_REVIEW, false) === undefined) return;
    this.checkLock();
    unlinkSync(join(this.directory, BILLING_REVIEW));
    fsyncSync(this.fd);
  }
  close(): void {
    try {
      if (this.lockFd !== undefined) {
        this.checkLock();
        unlinkSync(join(this.directory, LOCK));
        fsyncSync(this.fd);
      }
    } catch { throw authError('storage lock or directory changed; reconnect required'); }
    finally {
      if (this.lockFd !== undefined) { closeSync(this.lockFd); this.lockFd = undefined; }
      closeSync(this.fd);
    }
  }
}

/** Offline, validated read. Authentication occurs only at OAuth creation. */
export function loadChatGPTConnection(directory: string): ChatGPTConnection {
  const store = new ChatGPTStore(directory);
  try {
    store.lock();
    const c = store.connection();
    if (!c) throw authError('not connected; reconnect required');
    return c;
  } finally { store.close(); }
}
export function chatGPTStatus(directory: string): { connected: boolean; clientId?: string; expiresAt?: number; planUsageEnabled: boolean } {
  try {
    const c = loadChatGPTConnection(directory);
    return { connected: true, clientId: c.clientId, expiresAt: c.expiresAt, planUsageEnabled: true };
  } catch { return { connected: false, planUsageEnabled: false }; }
}
