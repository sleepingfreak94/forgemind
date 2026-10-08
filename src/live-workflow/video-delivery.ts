import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';
import { validateEvidencePair } from './evidence.js';
import type { EvidenceManifest } from './evidence.js';
import { discoverRepository, sourceIdentity } from './repository.js';
import { withRepositoryBudget } from './repository-process.js';
import type { RepositoryBudget } from './repository-process.js';
import { publishVideoRepository } from './video-repository.js';
import type { VideoRepositoryHost, VideoRepositoryResult } from './video-repository.js';

export const MAX_VIDEO_BYTES = 20 * 1024 * 1024;
export interface VideoPairExpectation {
  taskId: string; scenarioId: string; baselineIdentity: string; sourceIdentity: string;
}
export interface VideoDeliveryInput {
  projectRoot: string; before: EvidenceManifest; after: EvidenceManifest; expected: VideoPairExpectation;
}
export interface VideoReviewBinding {
  pairSha256: string; destination: string; branch: string; sourceIdentity: string;
  beforeSha256: string; afterSha256: string; exportSha256: string;
}
declare const preparedBrand: unique symbol;
export interface PreparedVideoDelivery extends Readonly<VideoReviewBinding> {
  readonly [preparedBrand]: true;
}
/** The trusted host verifies persisted reviews, reviewer independence and the exact
 * bindings, not merely caller-provided booleans. Metadata never proves visual/privacy review. */
export interface VerifiedVideoReview extends VideoReviewBinding {
  codeReviewReceiptId: string; visualReviewReceiptId: string;
  independentCodeReview: true; codeVerdict: 'pass';
  visualPlaybackApproved: true; privacyApproved: true;
}
export interface VideoDeliveryOptions extends VideoRepositoryHost {
  verifyReview: (binding: Readonly<VideoReviewBinding>) => Promise<VerifiedVideoReview>;
}
export type VideoDeliveryResult = VideoRepositoryResult | {
  status: 'local-only-blocked'; reason: string;
};
interface PinnedVideo { bytes: Buffer; fingerprint: string }
interface State {
  input: VideoDeliveryInput; head: string; identity: string; origin: string; defaultBranch: string;
  before: PinnedVideo; after: PinnedVideo; exported: string; used: boolean; reviewReady?: boolean;
}
const bundles = new WeakMap<PreparedVideoDelivery, State>();
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function identity(value: string): void {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new Error('Exact source identity required');
}
/** Validates every path component, including symlinked ancestors. */
export function safeVideoPath(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || path.includes('\0')) throw new Error('Unsafe video path');
  let current = parse(path).root;
  for (const part of relative(current, path).split('/').filter(Boolean)) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error('Symlink video path rejected');
  }
  if (realpathSync(path) !== path) throw new Error('Noncanonical video path');
}
function readVideo(item: EvidenceManifest): PinnedVideo {
  safeVideoPath(item.artifactPath);
  const fd = openSync(item.artifactPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size <= 0 || before.size > MAX_VIDEO_BYTES ||
        Number(before.size) !== item.artifactBytes) throw new Error('Invalid video size, type or hardlink');
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0, count: number;
    while (offset < bytes.length && (count = readSync(fd, bytes, offset, bytes.length - offset, null)) > 0) offset += count;
    const fingerprint = (s: typeof before) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.nlink, s.mode].join(':');
    const key = fingerprint(before);
    safeVideoPath(item.artifactPath);
    const linked = lstatSync(item.artifactPath, { bigint: true });
    if (offset !== bytes.length || !linked.isFile() || fingerprint(fstatSync(fd, { bigint: true })) !== key ||
        fingerprint(linked) !== key || hash(bytes) !== item.artifactSha256) throw new Error('Video bytes or identity changed');
    return { bytes, fingerprint: key };
  } finally { closeSync(fd); }
}
function validateManifest(item: EvidenceManifest): void {
  if (item.version !== 1 || item.label !== (item.phase === 'before' ? 'Before' : 'After') ||
      !/^[a-f0-9]{64}$/.test(item.artifactSha256) || !Number.isSafeInteger(item.artifactBytes) ||
      !Number.isFinite(Date.parse(item.startedAt)) || !Number.isFinite(Date.parse(item.completedAt)) ||
      Date.parse(item.completedAt) < Date.parse(item.startedAt)) throw new Error('Invalid video manifest');
  const v = item.video;
  if (!v || !Number.isFinite(v.durationSeconds) || v.durationSeconds <= 0 || v.durationSeconds > 3600 ||
      ![v.width, v.height, v.frames].every(n => Number.isSafeInteger(n) && n > 0) ||
      v.width > 32768 || v.height > 32768) throw new Error('Invalid video metadata');
  if (!Array.isArray(item.authorizations) || item.authorizations.length !== 2 ||
      item.authorizations[0]?.action !== 'record' || item.authorizations[1]?.action !== 'probe' ||
      item.authorizations.some(a => !a.receiptId?.trim() || !/^[a-f0-9]{64}$/.test(a.envelopeSha256))) {
    throw new Error('Recording provenance receipts required');
  }
}
/** Read-only preparation. Keep this in process; serialization loses its runtime brand.
 * The host must exclude concurrent writers to source/artifact directories throughout delivery. */
export function prepareVideoDelivery(input: VideoDeliveryInput, budget: RepositoryBudget = { deadline: Date.now() + 30000 }): PreparedVideoDelivery {
  return withRepositoryBudget(budget, () => {
    const snapshot = freeze(structuredClone(input)), { before, after, expected } = snapshot;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(expected.taskId) || !expected.scenarioId?.trim()) throw new Error('Invalid task/scenario');
    identity(expected.baselineIdentity); identity(expected.sourceIdentity);
    validateEvidencePair(before, after, expected); [before, after].forEach(validateManifest);
    const a = readVideo(before), b = readVideo(after), repo = discoverRepository(snapshot.projectRoot);
    const currentIdentity = sourceIdentity(repo.root);
    if (expected.sourceIdentity !== currentIdentity && !(expected.sourceIdentity === repo.head && repo.dirtyPaths.length === 0)) {
      throw new Error('Candidate source identity mismatch');
    }
    const destination = `https://github.com/${repo.owner}/${repo.repo}.git`;
    const pairSha256 = hash(JSON.stringify({ before: before.manifestSha256, after: after.manifestSha256, expected, destination }));
    const branch = `evidence/${expected.taskId}/${pairSha256}`;
    if (branch === repo.defaultBranch) throw new Error('Evidence branch is default branch');
    // Explicit allowlist: never export captureTarget, artifactPath, receipt text, dates,
    // scenario text, command details or arbitrary extra fields from local manifests.
    const exported = JSON.stringify({ version: 1, pairSha256, scenarioSha256: hash(expected.scenarioId),
      baselineIdentity: expected.baselineIdentity, sourceIdentity: expected.sourceIdentity,
      artifacts: [before, after].map(item => ({ phase: item.phase, label: item.label,
        path: `${item.phase}.mp4`, sha256: item.artifactSha256, bytes: item.artifactBytes,
        video: { durationSeconds: item.video.durationSeconds, width: item.video.width, height: item.video.height, frames: item.video.frames } })) }, null, 2) + '\n';
    const prepared = freeze({ pairSha256, destination, branch, sourceIdentity: expected.sourceIdentity,
      beforeSha256: before.artifactSha256, afterSha256: after.artifactSha256, exportSha256: hash(exported) }) as PreparedVideoDelivery;
    bundles.set(prepared, { input: freeze({ ...snapshot, projectRoot: repo.root }), head: repo.head, identity: currentIdentity, origin: repo.remoteUrl,
      defaultBranch: repo.defaultBranch, before: a, after: b, exported, used: false });
    return prepared;
  });
}
function revalidate(prepared: PreparedVideoDelivery, state: State): void {
  const { input } = state;
  validateEvidencePair(input.before, input.after, input.expected);
  for (const phase of ['before', 'after'] as const) {
    const fresh = readVideo(input[phase]);
    if (fresh.fingerprint !== state[phase].fingerprint || !fresh.bytes.equals(state[phase].bytes)) throw new Error('Prepared video replaced or edited');
  }
  const repo = discoverRepository(input.projectRoot);
  if (repo.head !== state.head || repo.remoteUrl !== state.origin || repo.defaultBranch !== state.defaultBranch ||
      sourceIdentity(repo.root) !== state.identity || `https://github.com/${repo.owner}/${repo.repo}.git` !== prepared.destination) {
    throw new Error('Prepared source or destination changed');
  }
}
/** No options means local-only. Caller must keep durable attempt/receipt state across
 * process restarts; unknown completion MUST be reconciled, never automatically retried. */
export async function deliverReviewedVideo(prepared: PreparedVideoDelivery, options?: VideoDeliveryOptions): Promise<VideoDeliveryResult> {
  const state = bundles.get(prepared);
  if (!state) return { status: 'local-only-blocked', reason: 'unrecognized-prepared-bundle' };
  if (!options || typeof options.authorize !== 'function' || typeof options.verifyReview !== 'function' ||
      !options.author || !options.evidenceParent || !options.budget) return { status: 'local-only-blocked', reason: 'host-options-required' };
  if (state.used) return { status: 'local-only-blocked', reason: 'bundle-already-attempted-host-reconciliation-required' };
  state.used = true;
  try {
    return await withRepositoryBudget(options.budget, async () => {
      revalidate(prepared, state);
      const review = await options.verifyReview(prepared);
      if (!review || Object.entries(prepared).some(([key, value]) => review[key as keyof VideoReviewBinding] !== value) ||
          review.independentCodeReview !== true || review.codeVerdict !== 'pass' || review.visualPlaybackApproved !== true ||
          review.privacyApproved !== true || !review.codeReviewReceiptId?.trim() || !review.visualReviewReceiptId?.trim()) {
        return { status: 'local-only-blocked', reason: 'verified-code-and-visual-review-required' };
      }
      revalidate(prepared, state);
      state.reviewReady = true;
      return publishVideoRepository(prepared, options);
    });
  } catch {
    return { status: 'local-only-blocked', reason: 'validation-or-host-review-failed' };
  }
}

/** Internal adapter handshake: a copied/forged bundle or direct publication call
 * cannot bypass the verified review stage. Consumed once by the repository adapter. */
export function takeReviewedVideoInput(prepared: PreparedVideoDelivery) {
  const state = bundles.get(prepared);
  if (!state?.reviewReady) throw new Error('Verified prepared video review required');
  state.reviewReady = false;
  return { binding: prepared, projectRoot: state.input.projectRoot,
    files: [{ path: 'before.mp4', bytes: Buffer.from(state.before.bytes), sha256: prepared.beforeSha256 },
      { path: 'after.mp4', bytes: Buffer.from(state.after.bytes), sha256: prepared.afterSha256 },
      { path: 'evidence.json', bytes: Buffer.from(state.exported), sha256: prepared.exportSha256 }],
    revalidate: () => revalidate(prepared, state) };
}
