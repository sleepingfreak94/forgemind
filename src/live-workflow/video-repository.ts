import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pinFile, verifyFile } from '../host-enforcement/manifest.js';
import { parseGitHubRemote } from './repository.js';
import { repositoryProcess, authorizedRepositoryProcess, withRepositoryBudget } from './repository-process.js';
import type { RepositoryBudget } from './repository-process.js';
import { safeVideoPath, takeReviewedVideoInput } from './video-delivery.js';
import type { PreparedVideoDelivery, VideoReviewBinding } from './video-delivery.js';

export interface VideoAuthor { name: string; email: string }
export interface VideoCredentialHelper { ghPath: string; sha256: string; configDirectory: string }
export type VideoActionKind = 'create-isolated-repository' | 'write-export' | 'git-init' | 'git-add' | 'git-commit' | 'remote-check' | 'push';
export interface VideoDeliveryAction {
  kind: VideoActionKind; binding: Readonly<VideoReviewBinding>; cwd: string;
  executable?: 'git'; args?: readonly string[]; environment?: Readonly<Record<string, string>>;
  /** Hashes and exact names of every file authorized for local export. */
  files: readonly { path: string; sha256: string; bytes: number }[];
  actionSha256: string;
}
export interface VideoActionOutcome { status: 'succeeded' | 'failed' | 'unknown'; commit?: string }
/** Host persists receipt/check/terminal outcomes. check must throw if revoked, expired
 * or fencing epoch changed. finish runs once for every returned valid grant, including
 * failed checks. Authorizer rejection owns its own denied terminal receipt.
 * Host MUST durably fence push attempts before granting them and reconcile unknown
 * completion across process restarts; the library never retries a push. */
export interface VideoActionGrant {
  receiptId: string;
  check: () => void | Promise<void>;
  finish: (outcome: Readonly<VideoActionOutcome>) => void | Promise<void>;
}
export interface VideoRepositoryHost {
  evidenceParent: string;
  author: VideoAuthor;
  budget: RepositoryBudget;
  authorize: (action: Readonly<VideoDeliveryAction>) => Promise<VideoActionGrant>;
  credentialHelper?: VideoCredentialHelper;
}
export type VideoRepositoryResult = {
  status: 'delivered'; commit: string; branch: string; beforeUrl: string; afterUrl: string; indexUrl: string;
  receipts: readonly string[];
} | {
  status: 'local-only-blocked' | 'delivery-unknown'; reason: string; receipts: readonly string[];
};
const attemptedPushes = new Set<string>();
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const gitConfig = [
  'core.hooksPath=/dev/null', 'core.fsmonitor=false', 'core.attributesFile=/dev/null',
  'core.excludesFile=/dev/null', 'core.autocrlf=false', 'core.safecrlf=false', 'core.filemode=false',
  'commit.gpgSign=false', 'tag.gpgSign=false', 'gc.auto=0', 'maintenance.auto=false',
  'credential.helper=', 'credential.https://github.com.helper=', 'credential.interactive=false',
  'http.proxy=', 'http.followRedirects=false', 'http.sslVerify=true', 'protocol.allow=never', 'protocol.https.allow=always',
];
function checkBudget(budget: RepositoryBudget): void {
  budget.signal?.throwIfAborted();
  if (!Number.isFinite(budget.deadline) || budget.deadline <= Date.now()) throw new Error('Delivery deadline exhausted');
}
function outside(project: string, path: string): boolean {
  const rel = relative(project, path);
  return rel === '..' || rel.startsWith(`..${sep}`);
}
function authorIdentity(author: VideoAuthor): void {
  if (!author || typeof author.name !== 'string' || !author.name.trim() || author.name.length > 120 ||
      /[<>\x00-\x1f\x7f]/.test(author.name) || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/.test(author.email) ||
      author.email.length > 254) throw new Error('Explicit host author identity required');
}
/** Called through deliverReviewedVideo. The runtime handshake rejects direct calls
 * without verified reviews. Only this isolated, newly created repository is mutated.
 * No cleanup is implicit: failed local directories are retained for host inspection. */
export async function publishVideoRepository(prepared: PreparedVideoDelivery, rawHost: VideoRepositoryHost): Promise<VideoRepositoryResult> {
  const receipts: string[] = [];
  let pushStarted = false, commit: string | undefined;
  try {
    const input = takeReviewedVideoInput(prepared);
    // Copy host-selected values before awaiting callbacks; callbacks cannot redirect them.
    const host = { ...rawHost, author: { ...rawHost.author }, budget: { ...rawHost.budget },
      ...(rawHost.credentialHelper ? { credentialHelper: { ...rawHost.credentialHelper } } : {}) };
    return await withRepositoryBudget(host.budget, async () => {
      checkBudget(host.budget); authorIdentity(host.author);
      const remote = parseGitHubRemote(prepared.destination);
      if (prepared.destination !== `https://github.com/${remote.owner}/${remote.repo}.git` ||
          !/^evidence\/[A-Za-z0-9][A-Za-z0-9_-]{0,79}\/[a-f0-9]{64}$/.test(prepared.branch)) throw new Error('Unsafe delivery destination');
      safeVideoPath(host.evidenceParent);
      const parent = lstatSync(host.evidenceParent);
      if (!parent.isDirectory() || (parent.mode & 0o022) || !outside(realpathSync(input.projectRoot), host.evidenceParent)) {
        throw new Error('Private evidence parent outside source required');
      }
      const root = join(host.evidenceParent, `video-${randomBytes(16).toString('hex')}`);
      const helper = host.credentialHelper;
      if (helper && (!/^\/[A-Za-z0-9_./-]+$/.test(helper.ghPath) || !/^[a-f0-9]{64}$/.test(helper.sha256))) {
        throw new Error('Invalid credential helper');
      }
      if (helper) { safeVideoPath(helper.ghPath); safeVideoPath(helper.configDirectory); }
      const helperPin = helper ? pinFile(helper.ghPath) : undefined;
      if (helperPin && (helperPin.digest !== helper!.sha256 || !(lstatSync(helperPin.path).mode & 0o111) ||
          !lstatSync(helper!.configDirectory).isDirectory())) throw new Error('Unverified credential helper');
      const env: Record<string, string> = {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: root, XDG_CONFIG_HOME: root, LANG: 'C', LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/usr/bin/false', SSH_ASKPASS: '/usr/bin/false',
        GIT_OPTIONAL_LOCKS: '0', GIT_ATTR_NOSYSTEM: '1', GIT_LFS_SKIP_SMUDGE: '1', GIT_NO_REPLACE_OBJECTS: '1',
        GH_PROMPT_DISABLED: '1', GH_HOST: 'github.com',
        GIT_AUTHOR_NAME: host.author.name, GIT_AUTHOR_EMAIL: host.author.email,
        GIT_COMMITTER_NAME: host.author.name, GIT_COMMITTER_EMAIL: host.author.email,
        ...(helper ? { GH_CONFIG_DIR: helper.configDirectory } : {}),
      };
      const options = gitConfig.flatMap(c => ['-c', c]);
      const networkOptions = helper ? ['-c', `credential.https://github.com.helper=${helper.ghPath} auth git-credential`] : [];
      const git = (args: readonly string[]) => repositoryProcess('git', [...options, ...args], root, env);
      const files = Object.freeze(input.files.map(f => Object.freeze({ path: f.path, sha256: f.sha256, bytes: f.bytes.length })));
      const parentPin = `${parent.dev}:${parent.ino}`;
      let rootPin: string | undefined, configPin: ReturnType<typeof pinFile> | undefined;
      let wroteFiles = false;
      const exportPins = new Map<string, ReturnType<typeof pinFile>>();
      const validate = () => {
        checkBudget(host.budget); input.revalidate(); safeVideoPath(host.evidenceParent);
        const now = lstatSync(host.evidenceParent);
        if (`${now.dev}:${now.ino}` !== parentPin || (now.mode & 0o022)) throw new Error('Evidence parent replaced');
        if (rootPin) {
          safeVideoPath(root); const s = lstatSync(root);
          if (`${s.dev}:${s.ino}` !== rootPin || !s.isDirectory() || (s.mode & 0o077)) throw new Error('Evidence repository replaced');
        }
        if (rootPin && !configPin && readdirSync(root).length) throw new Error('Evidence init requires an empty directory');
        if (configPin) { safeVideoPath(configPin.path); verifyFile(configPin); }
        if (helperPin) { safeVideoPath(helperPin.path); verifyFile(helperPin); safeVideoPath(helper!.configDirectory); }
        if (wroteFiles) for (const f of input.files) {
          const path = join(root, f.path); safeVideoPath(path); verifyFile(exportPins.get(f.path)!); const s = lstatSync(path);
          if (!s.isFile() || s.nlink !== 1 || s.size !== f.bytes.length || sha256(readFileSync(path)) !== f.sha256) throw new Error('Export changed');
        }
      };
      const action = async (kind: VideoActionKind, args?: string[], localOperation?: () => void,
        preDispatch = validate): Promise<Buffer | undefined> => {
        validate();
        const body = { kind, binding: prepared, cwd: root, files,
          ...(args ? { executable: 'git' as const, args: Object.freeze([...options, ...args]), environment: Object.freeze({ ...env }) } : {}) };
        const envelope = Object.freeze({ ...body, actionSha256: sha256(JSON.stringify(body)) });
        const grant = await host.authorize(envelope);
        if (!grant || !grant.receiptId?.trim() || typeof grant.check !== 'function' || typeof grant.finish !== 'function') {
          throw new Error('Invalid host grant; host owns terminal responsibility');
        }
        receipts.push(grant.receiptId);
        let outcome: VideoActionOutcome = { status: 'failed' };
        try {
          // Inspect the evidence first. The protected runner then pins its executable
          // and awaits the final grant check immediately before launch.
          preDispatch();
          const dispatch = () => {
            checkBudget(host.budget);
            if (kind === 'push') {
              const key = `${prepared.destination}:${prepared.branch}`;
              if (attemptedPushes.has(key)) throw new Error('Push reconciliation required');
              attemptedPushes.add(key); pushStarted = true;
            }
          };
          let result: Buffer | undefined;
          if (args) result = await authorizedRepositoryProcess('git', [...options, ...args], root, env,
            () => grant.check(), dispatch);
          else { await grant.check(); dispatch(); localOperation?.(); }
          if (kind === 'git-init') configPin = pinFile(join(root, '.git', 'config'));
          // A successful push still has unknown remote completion until ls-remote.
          outcome = { status: kind === 'push' ? 'unknown' : 'succeeded', ...(commit ? { commit } : {}) };
          return result;
        } catch (error) {
          outcome = { status: kind === 'push' && pushStarted ? 'unknown' : 'failed', ...(commit ? { commit } : {}) };
          throw error;
        } finally { await grant.finish(Object.freeze(outcome)); }
      };
      await action('create-isolated-repository', undefined, () => {
        mkdirSync(root, { mode: 0o700 }); const s = lstatSync(root); rootPin = `${s.dev}:${s.ino}`;
      });
      const init = ['init', '--template=', `--initial-branch=${prepared.branch}`, '--', root];
      await action('git-init', init);
      await action('write-export', undefined, () => {
        for (const file of input.files) {
          const path = join(root, file.path); writeFileSync(path, file.bytes, { flag: 'wx', mode: 0o600 });
          exportPins.set(file.path, pinFile(path));
        }
        wroteFiles = true;
      });
      const add = ['add', '--', 'before.mp4', 'after.mp4', 'evidence.json'];
      await action('git-add', add);
      const commitArgs = ['commit', '--no-verify', '-m', `Reviewed video evidence ${prepared.pairSha256}`];
      await action('git-commit', commitArgs);
      commit = git(['rev-parse', '--verify', 'HEAD^{commit}']).toString().trim();
      if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid evidence commit');
      const checkCommit = () => {
        validate();
        const tree = git(['ls-tree', '-r', '--full-tree', commit!]).toString().trim().split('\n');
        if (tree.length !== 3 || tree.some(line => !/^100644 blob [a-f0-9]{40}\t(before\.mp4|after\.mp4|evidence\.json)$/.test(line))) throw new Error('Unexpected evidence tree');
        const parents = git(['rev-list', '--parents', '-n', '1', commit!]).toString().trim();
        if (parents !== commit) throw new Error('Evidence commit must have no code history');
        for (const file of files) if (sha256(git(['cat-file', 'blob', `${commit}:${file.path}`])) !== file.sha256) throw new Error('Evidence commit bytes mismatch');
      };
      checkCommit();
      const remoteArgs = [...networkOptions, 'ls-remote', '--refs', prepared.destination, `refs/heads/${prepared.branch}`];
      const remoteCommit = async () => {
        const raw = (await action('remote-check', remoteArgs, undefined, checkCommit))!.toString().trim();
        if (!raw) return undefined;
        const match = /^([a-f0-9]{40})\t([^\r\n]+)$/.exec(raw);
        if (!match || match[2] !== `refs/heads/${prepared.branch}`) throw new Error('Unexpected remote ref');
        return match[1];
      };
      const existing = await remoteCommit();
      if (existing !== undefined && existing !== commit) throw new Error('Evidence branch already exists');
      if (!existing) {
        const push = [...networkOptions, 'push', '--porcelain', '--no-verify', prepared.destination, `${commit}:refs/heads/${prepared.branch}`];
        await action('push', push, undefined, checkCommit);
        if (await remoteCommit() !== commit) throw new Error('Remote completion unknown');
      }
      validate();
      const base = `https://github.com/${remote.owner}/${remote.repo}/blob/${commit}`;
      return { status: 'delivered', commit, branch: prepared.branch, beforeUrl: `${base}/before.mp4`,
        afterUrl: `${base}/after.mp4`, indexUrl: `${base}/evidence.json`, receipts: Object.freeze([...receipts]) };
    });
  } catch {
    return { status: pushStarted ? 'delivery-unknown' : 'local-only-blocked',
      reason: pushStarted ? 'host-reconciliation-required-no-automatic-retry' : 'delivery-validation-or-authorization-failed', receipts: Object.freeze([...receipts]) };
  }
}
