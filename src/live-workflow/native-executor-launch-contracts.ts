import { NATIVE_CATALOG_PATH, pinNativeSolCatalog } from './native-executor-catalog.js';
import { createHash, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pinFile, verifyFile } from '../host-enforcement/manifest.js';
import type { PinnedFile } from '../host-enforcement/manifest.js';
import { nativeInferenceProfile } from './native-executor-profile.js';
import { runtimeFiles } from './process.js';
export interface NativeLifecycleReceipt {
  readonly runtimeBinding: string;
  readonly receiptId: string;
  checkActive(): void;
  finish(status: 'completed' | 'failed' | 'indeterminate'): void;
}
export interface NativeLaunchPlan {
  readonly domain: 'native-runtime-v1';
  readonly runtimeBinding: string;
  readonly taskId: string;
  readonly grantId: string;
  readonly fencingEpoch: number;
  readonly leaseId: string;
  readonly model: string;
  readonly effort: 'low' | 'medium' | 'high' | 'xhigh';
  readonly grantDigest: string;
  readonly authorityBinding: string;
  readonly budgetBinding: string;
  readonly provider: 'openai_chatgpt_plan';
  readonly accountBinding: string;
  readonly reviewBinding: string;
  readonly executable: PinnedFile;
  readonly supervisor: PinnedFile;
  readonly node: PinnedFile;
  readonly dependencies: readonly PinnedFile[];
  readonly config: PinnedFile;
  readonly profile: string;
  readonly privateHome: string;
  readonly privateTmp: string;
  readonly tunnelPort: number;
  readonly deadlineEpochMs: number;
  readonly maxWireBytes: number;
}
export interface NativeLaunchRequest {
  readonly plan: NativeLaunchPlan;
  readonly lifecycle: NativeLifecycleReceipt;
  readonly signal?: AbortSignal;
  readonly accessToken: string;
}
export type NativePlanOptions = Omit<NativeLaunchPlan, 'domain' | 'runtimeBinding' | 'provider' |
  'executable' | 'supervisor' | 'node' | 'dependencies' | 'config' | 'profile'> & {
  executable: string; config: string;
};
const prepared = new WeakSet<object>();
export function nativeConfiguration(model: string, effort: NativeLaunchPlan['effort'] = 'medium'): string {
  if (!/^[a-z0-9][a-z0-9.-]{0,127}$/.test(model)) throw new Error('Invalid native model');
  if (!['low', 'medium', 'high', 'xhigh'].includes(effort)) throw new Error('Invalid native effort');
  return `model = ${JSON.stringify(model)}
model_reasoning_effort = ${JSON.stringify(effort)}
model_catalog_json = ${JSON.stringify(NATIVE_CATALOG_PATH)}
model_provider = "openai_chatgpt_plan"
approval_policy = "never"
sandbox_mode = "read-only"
service_tier = "default"
web_search = "disabled"
project_doc_max_bytes = 0
[model_providers.openai_chatgpt_plan]
name = "ForgeMind ChatGPT plan"
base_url = "https://api.openai.com/v1"
env_key = "ACCESS_TOKEN"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
[features]
shell_tool = false
unified_exec = false
shell_snapshot = false
multi_agent = false
multi_agent_v2 = false
goals = false
view_image = false
sleep_tool = false
apps = false
plugins = false
unbounded_connection_retries = false
hooks = false
tool_search = false
enable_request_compression = false
[agents]
enabled = false
[tools.experimental_request_user_input]
enabled = false
[analytics]
enabled = false
[feedback]
enabled = false
`;
}
export const NATIVE_CA_FILE = '/private/etc/ssl/cert.pem' as const;
/** Validate the bounded PEM before it reaches a native TLS parser. Native trust
 * also includes roots embedded in the pinned binary; this is additive trust. */
export function validateNativeCaBundle(bytes:Buffer):number {
  if(!bytes.length||bytes.length>4*1024*1024)throw new Error('Invalid native CA bundle size');
  const text=bytes.toString('utf8');
  if(!Buffer.from(text,'utf8').equals(bytes))throw new Error('Invalid native CA bundle encoding');
  const certificates=text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)??[];
  const remainder=text.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,'');
  if(!certificates.length||certificates.length>1024||/-----BEGIN|-----END/.test(remainder))throw new Error('Invalid native CA PEM framing');
  try{for(const certificate of certificates)new X509Certificate(certificate);}
  catch{throw new Error('Invalid native CA certificate');}
  return certificates.length;
}
function pinNativeCaBundle():PinnedFile {
  if(realpathSync(NATIVE_CA_FILE)!==NATIVE_CA_FILE)throw new Error('Canonical native CA bundle required');
  const stat=lstatSync(NATIVE_CA_FILE);
  if(!stat.isFile()||stat.uid!==0||stat.size<1||stat.size>4*1024*1024)throw new Error('Root-owned native CA bundle required');
  const pin=pinFile(NATIVE_CA_FILE);
  if(pin.path!==NATIVE_CA_FILE)throw new Error('Canonical native CA pin required');
  validateNativeCaBundle(readFileSync(NATIVE_CA_FILE));verifyFile(pin);
  return pin;
}
function directory(path: string): string {
  const canonical = realpathSync(path), stat = lstatSync(canonical);
  if (canonical !== path || !stat.isDirectory() || stat.uid !== process.getuid!() || (stat.mode & 0o077))
    throw new Error('Owner-private canonical directory required');
  return canonical;
}
/** Owner-only preparation, never accept a worker supplied serialized plan. */
export function prepareNativeLaunchPlan(options: NativePlanOptions): NativeLaunchPlan {
  if (process.platform !== 'darwin') throw new Error('Native enforcement requires macOS');
  for (const text of [options.taskId, options.grantId, options.leaseId, options.model, options.accountBinding, options.reviewBinding])
    if (typeof text !== 'string' || !text.length || text.length > 4096) throw new Error('Invalid native binding');
  if (!Number.isSafeInteger(options.fencingEpoch) || options.fencingEpoch < 1 ||
      !Number.isSafeInteger(options.deadlineEpochMs) || options.deadlineEpochMs <= Date.now() ||
      !Number.isSafeInteger(options.maxWireBytes) || options.maxWireBytes < 1 || options.maxWireBytes > 33554432)
    throw new Error('Invalid native limits');
  const privateHome = directory(options.privateHome), privateTmp = directory(options.privateTmp);
  if (privateHome === privateTmp || privateHome.startsWith(privateTmp + '/') || privateTmp.startsWith(privateHome + '/'))
    throw new Error('Separate native home and temporary directories required');
  if (!/^[a-f0-9]{64}$/.test(options.grantDigest) || !/^[a-f0-9]{64}$/.test(options.authorityBinding) || !/^[a-f0-9]{64}$/.test(options.budgetBinding))
    throw new Error('Exact grant and accepted budget digests required');
  const executable = pinFile(options.executable);
  const config = pinFile(options.config);
  if (config.path !== privateHome + '/config.toml') throw new Error('Private native configuration required');
  if (readFileSync(config.path, 'utf8') !== nativeConfiguration(options.model, options.effort)) throw new Error('Fixed native configuration required');
  const dependencies = Object.freeze([...runtimeFiles(executable.path).filter(p => p !== executable.path && p !== NATIVE_CA_FILE).map(pinFile),pinNativeCaBundle(),pinNativeSolCatalog(options.model,privateHome,privateTmp)]);
  const supervisor = pinFile(fileURLToPath(new URL('./native-executor-supervisor.js', import.meta.url)));
  const node = pinFile(process.execPath);
  const profile = nativeInferenceProfile(executable.path, privateHome, privateTmp, options.tunnelPort, dependencies.map(p => p.path));
  if (execFileSync('/usr/bin/sandbox-exec', ['-p', profile, executable.path, '--version'],
    { encoding: 'utf8', timeout: 5000, cwd: privateHome, env: { HOME: privateHome, CODEX_HOME: privateHome, TMPDIR: privateTmp, SSL_CERT_FILE:NATIVE_CA_FILE } }).trim() !== 'codex-cli 0.162.1')
    throw new Error('Pinned sandboxed Codex 0.162.1 required');
  const value = { domain: 'native-runtime-v1' as const, taskId: options.taskId, grantId: options.grantId,
    fencingEpoch: options.fencingEpoch, leaseId: options.leaseId, model: options.model, effort: options.effort,
    grantDigest: options.grantDigest, authorityBinding: options.authorityBinding, budgetBinding: options.budgetBinding, provider: 'openai_chatgpt_plan' as const,
    accountBinding: options.accountBinding, reviewBinding: options.reviewBinding, executable, supervisor, node, dependencies,
    config, profile, privateHome, privateTmp, tunnelPort: options.tunnelPort,
    deadlineEpochMs: options.deadlineEpochMs, maxWireBytes: options.maxWireBytes };
  const plan = Object.freeze({ ...value, runtimeBinding: createHash('sha256').update(JSON.stringify(value)).digest('hex') });
  prepared.add(plan); return plan;
}
export function verifyNativeLaunchPlan(plan: NativeLaunchPlan, hash = true): void {
  if (!prepared.has(plan)) throw new Error('Owner-prepared native launch plan required');
  directory(plan.privateHome); directory(plan.privateTmp);
  for (const pin of [plan.executable, plan.supervisor, plan.node, plan.config, ...plan.dependencies]) verifyFile(pin, hash);
  if (Date.now() >= plan.deadlineEpochMs) throw new Error('Native launch deadline expired');
}
