import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { pinFile, verifyFile } from '../host-enforcement/manifest.js';
import { RunAuthority } from '../live-workflow/authority.js';
import type { ActionReceipt, LiveTask } from '../live-workflow/contracts.js';
import type { EvidenceManifest } from '../live-workflow/evidence.js';
import { discoverRepository } from '../live-workflow/repository.js';
import { withRepositoryBudget } from '../live-workflow/repository-process.js';
import { deliverReviewedVideo, prepareVideoDelivery, safeVideoPath } from '../live-workflow/video-delivery.js';
import type { VideoDeliveryResult } from '../live-workflow/video-delivery.js';
import type { VideoActionOutcome } from '../live-workflow/video-repository.js';

const usage = `Reviewed video evidence (no providers or live inference):
  evidence:prepare --workspace /repo --before /before.json --after /after.json
  evidence:deliver --workspace /repo --before /before.json --after /after.json
    --code-review /review.json --state-root /private/state --evidence-parent /private/evidence
    --author-name NAME --author-email EMAIL [--gh /pinned/gh --gh-config-dir /private/gh]
Delivery requires an owner TTY and exactly: approve <pairSha256>.
Existing pair state is never reused. Unknown completion requires manual reconciliation.
`;
class VideoCliError extends Error {}
const commonFlags = ['--workspace', '--before', '--after'];
const deliveryFlags = ['--code-review', '--state-root', '--evidence-parent', '--author-name', '--author-email', '--gh', '--gh-config-dir'];
export interface VideoCliArguments { mode: 'prepare' | 'deliver' | 'help'; values: Readonly<Record<string, string>> }
/** Trusted terminal adapter for embedding/tests; no command-line flag can supply one. */
export interface VideoCliTerminal {
  isTTY: boolean; write: (text: string) => void;
  approve: (prompt: string) => Promise<string>;
}
export function parseVideoCliArguments(argv: readonly string[]): VideoCliArguments {
  if (argv.length === 1 && argv[0] === '--help' || argv.length === 2 &&
      ['prepare', 'deliver', 'evidence:prepare', 'evidence:deliver'].includes(argv[0]!) && argv[1] === '--help') return { mode: 'help', values: {} };
  const mode = argv[0]?.replace(/^evidence:/, '');
  if (mode !== 'prepare' && mode !== 'deliver') throw new VideoCliError('Expected prepare or deliver');
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  const allowed = [...commonFlags, ...(mode === 'deliver' ? deliveryFlags : [])];
  for (let i = 1; i < argv.length; i += 2) {
    const key = argv[i]!, value = argv[i + 1];
    if (!allowed.includes(key) || key in values || !value || value.startsWith('--') || /[\x00-\x1f\x7f]/.test(value)) throw new VideoCliError('Invalid CLI arguments');
    values[key] = value;
  }
  for (const key of [...commonFlags, ...(mode === 'deliver' ? deliveryFlags.slice(0, 5) : [])]) {
    if (!values[key]) throw new VideoCliError(`Required ${key}`);
  }
  if (!!values['--gh'] !== !!values['--gh-config-dir']) throw new VideoCliError('Both --gh and --gh-config-dir are required together');
  for (const [key, value] of Object.entries(values)) if (!['--author-name', '--author-email'].includes(key) &&
      (!isAbsolute(value) || resolve(value) !== value)) throw new VideoCliError('Canonical absolute paths required');
  if (mode === 'deliver' && (!values['--author-name']!.trim() || values['--author-name']!.length > 120 ||
      /[<>]/.test(values['--author-name']!) || values['--author-email']!.length > 254 ||
      !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/.test(values['--author-email']!))) throw new VideoCliError('Explicit valid author identity required');
  return { mode, values: Object.freeze(values) };
}
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
function readInput(path: string) {
  safeVideoPath(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.size < 1n || stat.size > 1024n * 1024n) throw new VideoCliError('Invalid or oversized input file');
    const bytes = Buffer.alloc(Number(stat.size)); let count = 0;
    while (count < bytes.length) { const read = readSync(fd, bytes, count, bytes.length - count, null); if (!read) break; count += read; }
    const fingerprint = (s: typeof stat) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.nlink, s.mode].join(':');
    const identity = fingerprint(stat); safeVideoPath(path);
    if (count !== bytes.length || fingerprint(fstatSync(fd, { bigint: true })) !== identity ||
        fingerprint(lstatSync(path, { bigint: true })) !== identity) throw new VideoCliError('Input changed during read');
    return { path, bytes, identity, sha256: digest(bytes) };
  } finally { closeSync(fd); }
}
function verifyInput(input: ReturnType<typeof readInput>): void {
  const current = readInput(input.path);
  if (current.identity !== input.identity || current.sha256 !== input.sha256) throw new VideoCliError('Reviewed input replaced or edited');
}
function privateDir(path: string, privateMode = true): void {
  safeVideoPath(path); const s = lstatSync(path);
  if (!s.isDirectory() || s.uid !== process.getuid?.() || (s.mode & (privateMode ? 0o077 : 0o022))) throw new VideoCliError('Private owner directory required');
}
function outside(root: string, path: string): boolean {
  const rel = relative(root, path); return rel === '..' || rel.startsWith(`..${sep}`);
}
function absent(path: string): boolean {
  try { lstatSync(path); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
}
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY); try { fsyncSync(fd); } finally { closeSync(fd); }
}
function save(path: string, value: unknown): void {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value, null, 2) + '\n');
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(dirname(path));
}
export function videoReceiptStatus(status: VideoActionOutcome['status']): 'completed' | 'failed' | 'indeterminate' {
  return status === 'unknown' ? 'indeterminate' : status === 'succeeded' ? 'completed' : 'failed';
}
function defaultTerminal(): VideoCliTerminal {
  return { isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true && process.stderr.isTTY === true,
    write: text => process.stdout.write(text), approve: async prompt => {
      const terminal = createInterface({ input: process.stdin, output: process.stderr });
      try { return await terminal.question(prompt, { signal: AbortSignal.timeout(300000) }); } finally { terminal.close(); }
    } };
}
/** Host-only delivery entry. The terminal attestation grants publication, never model execution. */
export async function runVideoCli(argv: readonly string[], terminal: VideoCliTerminal = defaultTerminal()): Promise<number> {
  const output = (value: unknown) => terminal.write(JSON.stringify(value, null, 2) + '\n');
  try {
    const { mode, values: v } = parseVideoCliArguments(argv);
    if (mode === 'help') { terminal.write(usage); return 0; }
    if (mode === 'deliver' && !terminal.isTTY) throw new VideoCliError('Delivery requires an interactive owner TTY; no writes or network were performed');
    const beforeFile = readInput(v['--before']!), afterFile = readInput(v['--after']!);
    const before = JSON.parse(beforeFile.bytes.toString()) as EvidenceManifest, after = JSON.parse(afterFile.bytes.toString()) as EvidenceManifest;
    const input = { projectRoot: v['--workspace']!, before, after,
      expected: { taskId: before.taskId, scenarioId: before.scenarioId, baselineIdentity: before.baselineIdentity, sourceIdentity: after.sourceIdentity } };
    const prepared = prepareVideoDelivery(input);
    const preview = { status: 'prepared-local-only', ...prepared, liveCodingEnabled: false, providerRequests: 0,
      files: [{ phase: 'before', manifest: beforeFile.path, artifact: before.artifactPath, sha256: prepared.beforeSha256 },
        { phase: 'after', manifest: afterFile.path, artifact: after.artifactPath, sha256: prepared.afterSha256 }] };
    if (mode === 'prepare') { output(preview); return 0; }
    const reviewFile = readInput(v['--code-review']!), review: unknown = JSON.parse(reviewFile.bytes.toString());
    if (!review || typeof review !== 'object' || Array.isArray(review) ||
        (review as { verdict?: unknown }).verdict !== 'pass' || (review as { source?: unknown }).source !== prepared.sourceIdentity) {
      throw new VideoCliError('Passing code review for the exact candidate source required');
    }
    const repo = withRepositoryBudget({ deadline: Date.now() + 30000 }, () => discoverRepository(input.projectRoot));
    const stateRoot = v['--state-root']!, evidenceParent = v['--evidence-parent']!, state = join(stateRoot, prepared.pairSha256);
    if (!outside(repo.root, stateRoot) || !outside(repo.root, evidenceParent)) throw new VideoCliError('State and evidence directories must be outside the source repository');
    privateDir(evidenceParent, false);
    const rootMissing = absent(stateRoot); privateDir(rootMissing ? dirname(stateRoot) : stateRoot, !rootMissing);
    if (!absent(state)) throw new VideoCliError('Pair state already exists; reconcile it, never retry automatically');
    const helper = v['--gh'] ? (() => {
      safeVideoPath(v['--gh']!); privateDir(v['--gh-config-dir']!);
      const pinned = pinFile(v['--gh']!);
      if (!(lstatSync(pinned.path).mode & 0o111) || !/^\/[A-Za-z0-9_./-]+$/.test(pinned.path)) throw new VideoCliError('Explicit executable gh helper required');
      return { pinned, options: { ghPath: pinned.path, sha256: pinned.digest, configDirectory: v['--gh-config-dir']! } };
    })() : undefined;
    const validateInputs = () => {
      for (const file of [beforeFile, afterFile, reviewFile]) verifyInput(file);
      privateDir(evidenceParent, false); if (helper) { verifyFile(helper.pinned); privateDir(helper.options.configDirectory); }
    };
    output({ ...preview, codeReview: { path: reviewFile.path, sha256: reviewFile.sha256 }, stateDirectory: state });
    const attestation = `I attest that this code received independent review for the exact candidate source; I watched the actual Before and After videos, verified the matching scenario and readable playback, and approved their privacy for everyone with access to this repository. I authorize the listed evidence files to be published to ${prepared.destination} on ${prepared.branch}.`;
    const answer = await terminal.approve(`${attestation}\nType exactly approve ${prepared.pairSha256}: `);
    if (answer !== `approve ${prepared.pairSha256}`) throw new VideoCliError('Owner approval declined; no writes or network were performed');
    validateInputs();
    privateDir(rootMissing ? dirname(stateRoot) : stateRoot, !rootMissing);
    if (rootMissing) { mkdirSync(stateRoot, { mode: 0o700 }); syncDirectory(dirname(stateRoot)); }
    privateDir(stateRoot);
    // Atomic, durable fence survives crashes before the authority or result exists.
    mkdirSync(state, { mode: 0o700 }); syncDirectory(stateRoot);
    const approval = { binding: prepared, attestation, approvedAt: new Date().toISOString(), ownerUid: process.getuid?.(),
      codeReview: { originalPath: reviewFile.path, sha256: reviewFile.sha256 }, author: { name: v['--author-name']!, email: v['--author-email']! } };
    const approvalSha256 = digest(JSON.stringify(approval));
    let authority: RunAuthority | undefined, result: VideoDeliveryResult | undefined, pushReserved = false;
    const pending = new Map<string, ActionReceipt>();
    try {
      save(join(state, 'code-review.json'), reviewFile.bytes); save(join(state, 'approval.json'), approval);
      // Zero provider budget. This facade is held only by this host, never a worker.
      const task: LiveTask = { schemaVersion: 1, taskId: `video-${prepared.pairSha256.slice(0, 32)}`, objective: 'Deliver owner-reviewed video evidence',
        readPaths: [], writePaths: [], checks: [], model: 'disabled', effort: 'low', maxModelRequests: 0,
        maxPromptBytes: 0, maxOutputBytes: 1048576, maxRuntimeMs: 300000, draftPr: false };
      authority = new RunAuthority(join(state, 'authority'), repo.root, `${repo.owner}/${repo.repo}`, task, prepared.sourceIdentity);
      const owner = authority;
      owner.phase('video-approved', prepared.sourceIdentity, { approvalSha256, binding: prepared });
      result = await deliverReviewedVideo(prepared, { evidenceParent, author: approval.author,
        budget: { deadline: Date.now() + task.maxRuntimeMs }, ...(helper ? { credentialHelper: helper.options } : {}),
        verifyReview: async binding => {
          validateInputs();
          return { ...binding, codeReviewReceiptId: reviewFile.sha256, visualReviewReceiptId: approvalSha256,
            independentCodeReview: true, codeVerdict: 'pass', visualPlaybackApproved: true, privacyApproved: true };
        },
        authorize: async action => {
          validateInputs(); const receiptId = randomUUID();
          const receipt = owner.reserve({ kind: action.executable === 'git' ? 'git' : 'artifact', source: prepared.sourceIdentity,
            detail: { receiptId, approvalSha256, action } });
          pending.set(receiptId, receipt);
          try {
            owner.phase('video-action-reserved', prepared.sourceIdentity, { receiptId, approvalSha256, action });
            if (action.kind === 'push') {
              save(join(state, 'push-attempt.json'), { receiptId, approvalSha256, action }); pushReserved = true;
            }
          } catch (error) { receipt.finish('failed'); pending.delete(receiptId); throw error; }
          return { receiptId, check: () => { validateInputs(); receipt.check(); }, finish: outcome => {
            receipt.finish(videoReceiptStatus(outcome.status), digest(JSON.stringify(outcome))); pending.delete(receiptId);
            owner.phase('video-action-finished', prepared.sourceIdentity, { receiptId, outcome });
          } };
        } });
    } catch {
      result = { status: pushReserved ? 'delivery-unknown' : 'local-only-blocked', reason: 'host-delivery-failed-reconcile-private-state', receipts: [] };
    }
    // A terminal-receipt failure must not prevent saving the exact backend result
    // or exporting the remaining ledger. Each durable write can fail independently.
    let persistenceFailed = false;
    const persist = (work: () => void) => { try { work(); } catch { persistenceFailed = true; } };
    try {
      for (const receipt of pending.values()) persist(() => receipt.finish('indeterminate'));
      persist(() => save(join(state, 'delivery-result.json'), result));
      persist(() => authority?.finish(result?.status === 'delivered' && !persistenceFailed ? 'completed' :
        result?.status === 'delivery-unknown' || persistenceFailed ? 'failed' : 'blocked'));
      persist(() => save(join(state, 'authority-receipt.json'), authority?.export() ?? { status: 'authority-unavailable', providerRequests: 0 }));
      if (persistenceFailed) {
        const status = pushReserved || result?.status === 'delivered' ? 'delivery-unknown' as const : 'local-only-blocked' as const;
        // Export itself may have failed after finish(completed). Correct the durable
        // run status; the exclusive pair directory still fences every future process.
        persist(() => authority?.finish(status === 'delivery-unknown' ? 'failed' : 'blocked'));
        const failure = { status, reason: 'delivery-outcome-not-fully-persisted-reconcile-private-state',
          stateDirectory: state, providerRequests: 0, liveCodingEnabled: false };
        persist(() => save(join(state, 'persistence-failure.json'), { ...failure,
          backendResult: result, resultSha256: digest(JSON.stringify(result)), approvalSha256 }));
        output(failure); return 2;
      }
    } finally { authority?.close(); }
    output({ ...result, stateDirectory: state, providerRequests: 0, liveCodingEnabled: false });
    return result?.status === 'delivered' ? 0 : 2;
  } catch (error) {
    // Validation messages contain no file contents or credentials; backend errors remain generic.
    output({ status: 'local-only-blocked', reason: error instanceof SyntaxError ? 'Invalid input JSON' :
      error instanceof VideoCliError ? error.message : 'Video evidence validation failed', providerRequests: 0, liveCodingEnabled: false }); return 2;
  }
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await runVideoCli(process.argv.slice(2));
}
