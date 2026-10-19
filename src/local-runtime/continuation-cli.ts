import { randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalPolicyRuntime } from '../policy/runtime.js';
import { inside } from '../policy/validation.js';
import { sourceIdentity } from '../live-workflow/repository.js';
import { maxCheckpointBytes } from '../live-workflow/continuation-contracts.js';
import { ContinuationStore, privateFile, safeAncestors } from '../live-workflow/continuation-store.js';
import { handoffEnvelope, handoffResource, prepareResume } from '../live-workflow/continuation.js';
import { digestText, hash, serialize, validateOwnerPolicy } from '../live-workflow/continuation-validation.js';

export const continuationHelp = `Usage:
  node dist/src/local-runtime/continuation-cli.js save --workspace /repo --project-id ID --state /private/state --input /private/checkpoint.json
  node dist/src/local-runtime/continuation-cli.js inspect --workspace /repo --project-id ID --state /private/state --digest SHA256 [--policy /private/policy.json]
  node dist/src/local-runtime/continuation-cli.js prepare --workspace /repo --project-id ID --state /private/state --digest SHA256 --policy /private/policy.json
  node dist/src/local-runtime/continuation-cli.js --help
All inputs are evidence except a fresh owner-private policy descriptor. Prepare consumes once and emits a role packet; it launches no inference. Its grants are revoked before process exit.`;
export interface ContinuationArguments {
  command: 'save' | 'inspect' | 'prepare';
  workspace: string;
  projectId: string;
  state: string;
  input?: string;
  digest?: string;
  policy?: string;
}
export function parseContinuationArgs(argv: readonly string[]): ContinuationArguments | 'help' {
  if (argv.length === 1 && argv[0] === '--help') return 'help';
  if (argv.length > 15 || argv.some(arg => typeof arg !== 'string' || arg.length > 4096 || /[\x00-\x1f]/.test(arg))) throw new Error('invalid arguments');
  const command = argv[0];
  if (command !== 'save' && command !== 'inspect' && command !== 'prepare') throw new Error('expected save, inspect or prepare');
  const allowed = ['--workspace', '--project-id', '--state', ...(command === 'save' ? ['--input'] : ['--digest', '--policy'])];
  const flags: Record<string, string> = {};
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    if (!key || !allowed.includes(key) || flags[key] !== undefined || !value || value.startsWith('--')) throw new Error('unknown, duplicate or missing argument');
    flags[key] = value;
  }
  for (const required of ['--workspace', '--project-id', '--state', command === 'save' ? '--input' : '--digest', ...(command === 'prepare' ? ['--policy'] : [])]) {
    if (!flags[required]) throw new Error(`missing ${required}`);
  }
  if (flags['--digest']) digestText(flags['--digest']);
  return { command, workspace: flags['--workspace']!, projectId: flags['--project-id']!, state: flags['--state']!,
    ...(flags['--input'] ? { input: flags['--input'] } : {}),
    ...(flags['--digest'] ? { digest: flags['--digest'] } : {}),
    ...(flags['--policy'] ? { policy: flags['--policy'] } : {}) };
}
/** Reads at most max+1 bytes, without following links, from an owner-private JSON file. */
function ownerJson(path: string, root: string, max: number): unknown {
  privateFile(path);
  if (inside(root, path) || (lstatSync(dirname(path)).mode & 0o777) !== 0o700) throw new Error('input must be outside workspace in a private directory');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o600 || st.size > max) throw new Error('unsafe or oversized input');
    const buffer = Buffer.alloc(max + 1);
    let used = 0;
    while (used <= max) {
      const count = readSync(fd, buffer, used, buffer.length - used, null);
      if (!count) break;
      used += count;
    }
    if (used > max) throw new Error('oversized input');
    const current = lstatSync(path);
    if (current.ino !== st.ino || current.dev !== st.dev || current.size !== used) throw new Error('input changed while reading');
    privateFile(path);
    const bytes = buffer.subarray(0, used); const decoded = bytes.toString('utf8');
    if (!Buffer.from(decoded).equals(bytes)) throw new Error('input must be UTF-8');
    return JSON.parse(decoded) as unknown;
  } finally { closeSync(fd); }
}
export interface ContinuationCliPorts {
  /** Host-only injection for no-fork tests; production reads actual repository source. */
  source?: (root: string) => string;
  clock?: () => number;
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
}
function run(args: ContinuationArguments, ports: ContinuationCliPorts): unknown {
  const root = realpathSync(args.workspace);
  if (resolve(args.workspace) !== root || resolve(args.state) !== args.state) throw new Error('canonical absolute workspace and state required');
  const source = () => (ports.source ?? sourceIdentity)(root);
  const clock = ports.clock ?? Date.now;
  const store = new ContinuationStore({ workspaceRoot: root, projectId: args.projectId, stateDirectory: args.state, source, clock });
  let runtime: LocalPolicyRuntime | undefined;
  const granted: string[] = [];
  try {
    if (args.command === 'save') return { status: 'saved', evidenceOnly: true, ...store.save(ownerJson(args.input!, root, maxCheckpointBytes)) };
    const stored = store.inspect(args.digest!);
    if (args.command === 'inspect' && !args.policy) return { status: 'historical', evidenceOnly: true, ...stored };
    const policyPath = args.policy!;
    const readPolicy = () => validateOwnerPolicy(root, ownerJson(policyPath, root, 65536), clock());
    const descriptor = readPolicy();
    if (descriptor.policyVersion !== stored.checkpoint.policyVersion) throw new Error('policy drift requires a new reconciled checkpoint');
    const envelope = handoffEnvelope(stored.digest, stored.checkpoint, descriptor.target);
    const resource = handoffResource(stored.digest, stored.checkpoint, descriptor.target);
    if (args.command === 'inspect') return { status: 'historical', evidenceOnly: true, ...stored, handoff: { envelope, resource } };
    const policyDirectory = join(args.state, 'policy');
    try { mkdirSync(policyDirectory, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    safeAncestors(policyDirectory);
    if ((lstatSync(policyDirectory).mode & 0o777) !== 0o700) throw new Error('private policy directory required');
    runtime = LocalPolicyRuntime.open({ stateDirectory: policyDirectory, workspaceRoot: root,
      repositoryId: args.projectId, sourceSnapshot: source, clock });
    // The descriptor cannot roll the durable policy backwards or silently set a new policy version.
    if (runtime.receipts().at(-1)?.policyVersion !== descriptor.policyVersion) throw new Error('descriptor does not match current runtime policy');
    const parent = runtime.issueGrant({ ...descriptor.parent, taskId: stored.checkpoint.taskId, invocationId: randomUUID() });
    granted.unshift(parent.id);
    const instanceId = randomUUID(); const invocationId = randomUUID();
    const lease = prepareResume({ store, runtime, binding: { digest: stored.digest, projectId: args.projectId, root,
      taskId: stored.checkpoint.taskId, parentGrantId: parent.id, instanceId, invocationId, target: descriptor.target },
      currentPolicy: () => {
        const fresh = readPolicy();
        if (hash(fresh) !== hash(descriptor)) throw new Error('owner policy descriptor changed');
        return fresh.policyVersion;
      } });
    granted.unshift(lease.grant.id);
    lease.check();
    return { status: 'prepared', evidenceOnly: true, processLocalAuthorityClosed: true,
      grantId: lease.grant.id, packet: lease.packet };
  } finally {
    const failures: unknown[] = [];
    if (runtime) {
      for (const id of granted) {
        try { runtime.revoke(id); } catch (error) { failures.push(error); }
      }
      try { runtime.close(); } catch (error) { failures.push(error); }
    }
    try { store.close(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'owner authority cleanup failed');
  }
}
/** No subprocesses, process.exit, or automatic import execution. Returns a conventional exit code. */
export function continuationMain(argv: readonly string[], ports: ContinuationCliPorts = {}): number {
  const stdout = ports.stdout ?? (value => { process.stdout.write(value); });
  const stderr = ports.stderr ?? (value => { process.stderr.write(value); });
  try {
    const args = parseContinuationArgs(argv);
    if (args === 'help') { stdout(`${continuationHelp}\n`); return 0; }
    const result = serialize(run(args, ports));
    if (Buffer.byteLength(result) > 524288) throw new Error('result too large');
    stdout(`${result}\n`); return 0;
  } catch {
    stderr('{"status":"denied","error":"invalid-owner-request"}\n'); return 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = continuationMain(process.argv.slice(2));
