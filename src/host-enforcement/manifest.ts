import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { DriverIntent } from '../agent-drivers/contracts.js';
import { dataSnapshot, object, positive, serialize, string, validateScope } from '../context-engine/validation.js';
import { offlineProfile } from './seatbelt.js';
import { configurationSnapshot } from '../agent-drivers/cursor-wire.js';
const prepared = new WeakSet<object>();

export interface PinnedFile { path: string; digest: string; identity: string }
export interface HostPlan {
  version: 'macos-offline-v2';
  intent: DriverIntent;
  executable: PinnedFile;
  args: readonly string[];
  readFiles: readonly PinnedFile[];
  supervisor: PinnedFile;
  supervisorNode: PinnedFile;
}
export function hashFile(path: string): string { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function inspectFile(path: string): { path: string; identity: string } {
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('absolute file required');
  const canonical = realpathSync(path), stat = lstatSync(canonical);
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o6022) || ![0, process.getuid!()].includes(stat.uid)) throw new Error('untrusted file');
  const exact = lstatSync(canonical, { bigint: true });
  return { path: canonical, identity: [exact.dev, exact.ino, exact.size, exact.mode, exact.uid, exact.nlink, exact.mtimeNs, exact.ctimeNs].join(':') };
}
export function pinFile(path: string): PinnedFile {
  const before = inspectFile(path), digest = hashFile(before.path);
  if (serialize(before) !== serialize(inspectFile(path))) throw new Error('file changed while pinning');
  return Object.freeze({ ...before, digest });
}
export function verifyFile(file: PinnedFile, hash = true): void {
  const current = inspectFile(file.path);
  if (current.path !== file.path || current.identity !== file.identity || (hash && hashFile(file.path) !== file.digest)) throw new Error('file identity changed');
}
export function intentSnapshot(raw: DriverIntent): DriverIntent {
  const value = dataSnapshot(raw);
  const common = ['driver', 'scope', 'expiresAt', 'workspaceRoot', 'model', 'provider', 'cliVersion', 'mode', 'ephemeral', 'viewDigest', 'maxRuntimeMs', 'maxOutputBytes'];
  object(value, [...common, ...(value.driver === 'codex' ? ['effort'] : ['protocolVersion', 'sessionMode', 'persistence', 'configuration'])]);
  validateScope(value.scope); positive(value.expiresAt); positive(value.maxRuntimeMs, 60000); positive(value.maxOutputBytes, 32 * 1024 * 1024);
  for (const key of ['workspaceRoot', 'model', 'viewDigest'] as const) string(value[key], 4096);
  if (!isAbsolute(value.workspaceRoot) || realpathSync(value.workspaceRoot) !== value.workspaceRoot || !statSync(value.workspaceRoot).isDirectory() ||
      value.mode !== 'read-only' || !/^[a-f0-9]{64}$/.test(value.viewDigest)) throw new Error('invalid offline intent');
  if (value.driver === 'codex') {
    string(value.effort, 128);
    if (value.provider !== 'openai' || value.cliVersion !== '0.160.0' || value.ephemeral !== true) throw new Error('invalid Codex intent');
  } else if (value.driver === 'cursor') {
    if (value.provider !== 'cursor' || value.cliVersion !== '2026.07.09-a3815c0' || value.protocolVersion !== 1 || value.sessionMode !== 'ask' ||
        value.ephemeral !== false || value.persistence !== 'private-scratch') throw new Error('invalid Cursor intent');
    configurationSnapshot(value.configuration, value.model);
  } else throw new Error('unsupported driver');
  return value;
}
/** Owner prepares this envelope; workers cannot supply commands or read permissions. */
export function prepareHostPlan(options: { intent: DriverIntent; executable: string; args: string[]; readFiles: string[]; supervisor: string }): Readonly<HostPlan> {
  const copied = dataSnapshot(options);
  object(copied, ['intent', 'executable', 'args', 'readFiles', 'supervisor']);
  if (!Array.isArray(copied.args) || copied.args.length > 64 || !Array.isArray(copied.readFiles) || copied.readFiles.length > 1024) throw new Error('invalid manifest');
  copied.args.forEach(arg => string(arg, 8192, true));
  if (Buffer.byteLength(JSON.stringify(copied.args)) > 65536) throw new Error('argument limit');
  const plan = dataSnapshot({ version: 'macos-offline-v2' as const, intent: intentSnapshot(copied.intent), executable: pinFile(copied.executable),
    args: copied.args, readFiles: [...new Set(copied.readFiles)].sort().map(pinFile), supervisor: pinFile(copied.supervisor), supervisorNode: pinFile(process.execPath) });
  prepared.add(plan); return plan;
}
export function assertPreparedPlan(plan: HostPlan): void { if (!prepared.has(plan)) throw new Error('unsealed host plan'); }
export function hostEnvelope(plan: HostPlan): unknown {
  return dataSnapshot({ plan, profile: offlineProfile(plan, '/FORGEMIND-INVOCATION-SCRATCH'),
    environment: { HOME: '/FORGEMIND-INVOCATION-SCRATCH', ...(plan.intent.driver === 'codex' ? { CODEX_HOME: '/FORGEMIND-INVOCATION-SCRATCH/codex' } : { XDG_CACHE_HOME: '/FORGEMIND-INVOCATION-SCRATCH/cache' }),
      TMPDIR: '/FORGEMIND-INVOCATION-SCRATCH/tmp', LANG: 'C', LC_ALL: 'C', OPENSSL_CONF: '/dev/null' } });
}
export function hostResource(plan: HostPlan): string {
  return `host:${createHash('sha256').update(serialize(hostEnvelope(plan))).digest('hex')}`;
}
export function verifyPlan(plan: HostPlan, hash = true): void {
  intentSnapshot(plan.intent);
  for (const file of [plan.executable, plan.supervisor, plan.supervisorNode, ...plan.readFiles]) verifyFile(file, hash);
}
