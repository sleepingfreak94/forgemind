import { repositoryProcess } from './repository-process.js';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readPublicNpmConfig } from './npm-config.js';

export interface RepositoryInfo {
  root: string; head: string; defaultBranch: string; remoteName: 'origin';
  remoteUrl: string; owner: string; repo: string; dirtyPaths: string[];
}
export interface SourceBinding { root: string; head: string; identity: string }
export interface RepositoryAction {
  executable: 'git' | 'gh'; args: readonly string[]; cwd: string; source: Readonly<SourceBinding>;
}
/** Host must throw to deny. This synchronous decision hook is NOT an OS sandbox. */
export type BeforeRepositoryAction = (action: Readonly<RepositoryAction>) => void;
export interface TaskCheckout { root: string; branch: string; baseHead: string; repository: RepositoryInfo }
export interface TicketDiff extends SourceBinding { baseHead: string; paths: string[]; diff: string }
export interface DraftPullRequestInput {
  root: string; branch: string; expectedBase: string; expectedHead: string;
  expectedRemoteUrl: string; allowedPaths: readonly string[]; title: string; body: string;
}
export interface PreparedDraftPullRequest extends DraftPullRequestInput {
  repository: RepositoryInfo; source: SourceBinding; diff: TicketDiff;
}
export interface PublishedDraftPullRequest { url: string; existing: boolean }
/** Host-selected, reviewed gh binary. No arbitrary helper commands or tokens are accepted. */
export interface PublishOptions { gitCredentialHelper?: { ghPath: string; sha256: string } }

const gitOptions = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.filemode=true'];
function run(executable: 'git' | 'gh', args: readonly string[], cwd: string): Buffer {
  // Prevent ambient GIT_DIR / worktree / injected config from redirecting operations.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GH_HOST: 'github.com' });
  return repositoryProcess(executable, args, cwd, env);
}
function git(root: string, ...args: string[]): Buffer { return run('git', [...gitOptions, ...args], root); }
function text(root: string, ...args: string[]): string { return git(root, ...args).toString('utf8').trim(); }
function optional(root: string, ...args: string[]): string | undefined {
  try { return text(root, ...args); } catch (error) {
    if ((error as { status?: number }).status === 1) return undefined;
    throw error;
  }
}
function rootOf(workspace: string): string {
  const root = realpathSync(text(realpathSync(workspace), 'rev-parse', '--show-toplevel'));
  if (text(root, 'rev-parse', '--is-bare-repository') !== 'false') throw new Error('Bare repositories are unsupported');
  // Even name-only diff can invoke clean filters. Check effective config before any content inspection.
  if (optional(root, 'config', '--get-regexp', '^filter\\..*\\.(clean|smudge|process)$') !== undefined) {
    throw new Error('Git filters are unsupported');
  }
  return root;
}
function oid(value: string): string {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new Error('Expected exact commit identity');
  return value;
}
function pathName(path: string): string {
  if (!path || isAbsolute(path) || /[\\\x00-\x1f\x7f:*?\[\]]/.test(path) ||
      path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
    throw new Error(`Unsafe Git path: ${JSON.stringify(path)}`);
  }
  return path;
}
function safeSourcePath(path: string): string {
  pathName(path);
  if (path.split('/').some(part => (part.startsWith('.env') && part !== '.env.example') ||
      /^(?:\.?credentials(?:\..*)?|\.aws|\.ssh|\.netrc|\.npmrc|\.pypirc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/i.test(part))) {
    throw new Error(`Secret-bearing source path rejected: ${path}`);
  }
  return path;
}
/** Only snapshotting may inspect an exact .npmrc leaf, after checking its parents.
 * Diff/write ownership still uses safeSourcePath and rejects npm config edits. */
function snapshotSourcePath(path: string): string {
  pathName(path);
  const parts = path.split('/');
  if (parts.at(-1) !== '.npmrc') return safeSourcePath(path);
  if (parts.length > 1) safeSourcePath(parts.slice(0, -1).join('/'));
  return path;
}
function names(buffer: Buffer): string[] {
  const decoded = buffer.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(buffer)) throw new Error('Unsafe non-UTF8 Git path');
  return decoded.split('\0').filter(Boolean).map(pathName);
}
function sorted(paths: Iterable<string>): string[] {
  return [...new Set(paths)].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}
function regularFile(root: string, path: string): string | undefined {
  snapshotSourcePath(path);
  let current = root;
  for (const [index, part] of path.split('/').entries()) {
    current = join(current, part);
    let stat;
    try { stat = lstatSync(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Symlink rejected: ${path}`);
    if (index < path.split('/').length - 1 ? !stat.isDirectory() : !stat.isFile()) throw new Error(`Non-regular source: ${path}`);
  }
  if (relative(root, realpathSync(current)).startsWith(`..${sep}`)) throw new Error('Source path escaped repository');
  return current;
}
export function parseGitHubRemote(remoteUrl: string): { owner: string; repo: string } {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(remoteUrl);
  if (!match || !match[2] || ['.', '..'].includes(match[2])) throw new Error('Only GitHub HTTPS or git SSH owner/repo remotes are supported');
  return { owner: match[1]!, repo: match[2] };
}
function dirtyPaths(root: string): string[] {
  return sorted([...names(git(root, 'diff', '--no-ext-diff', '--name-only', '-z', 'HEAD', '--')),
    ...names(git(root, 'diff', '--cached', '--no-ext-diff', '--name-only', '-z', '--')),
    ...names(git(root, 'ls-files', '--others', '--exclude-standard', '-z'))]);
}
export function discoverRepository(workspace: string): RepositoryInfo {
  const root = rootOf(workspace), head = oid(text(root, 'rev-parse', '--verify', 'HEAD^{commit}'));
  const rawUrls = (optional(root, 'config', '--get-all', 'remote.origin.url') ?? '').split('\n');
  if (rawUrls.length !== 1) throw new Error('Exactly one origin URL is required');
  const remoteUrl = rawUrls[0]!, remote = parseGitHubRemote(remoteUrl);
  const fetch = text(root, 'remote', 'get-url', '--all', 'origin');
  const push = text(root, 'remote', 'get-url', '--push', '--all', 'origin');
  if (fetch !== remoteUrl || push !== remoteUrl) throw new Error('Origin URL rewrite or mismatched push remote rejected');
  const symbolic = optional(root, 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD');
  let defaultBranch = symbolic?.replace(/^refs\/remotes\/origin\//, '');
  if (!defaultBranch) {
    const candidates = ['main', 'master'].filter(branch => optional(root, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`) !== undefined);
    if (candidates.length !== 1) throw new Error('Default branch unknown; configure origin/HEAD locally');
    defaultBranch = candidates[0]!;
  }
  git(root, 'check-ref-format', `refs/heads/${defaultBranch}`);
  return { root, head, defaultBranch, remoteName: 'origin', remoteUrl, ...remote, dirtyPaths: dirtyPaths(root) };
}
/** Hashes framed UTF-8 path bytes, executable mode and raw content. Ignored untracked artifacts are omitted. */
export function sourceIdentity(workspace: string): string {
  const root = rootOf(workspace);
  if (text(root, 'ls-files', '-v').split('\n').some(line => /^[a-zS]/.test(line))) throw new Error('Hidden index paths are unsupported');
  const entries = git(root, 'ls-files', '--stage', '-z').toString('utf8').split('\0').filter(Boolean);
  for (const entry of entries) {
    if (!/^(100644|100755) [a-f0-9]+ 0\t/.test(entry)) throw new Error('Symlink, submodule, or unresolved index rejected');
  }
  const paths = sorted([...names(git(root, 'ls-files', '--cached', '-z')),
    ...names(git(root, 'ls-files', '--others', '--exclude-standard', '-z'))]);
  paths.forEach(snapshotSourcePath);
  const hash = createHash('sha256');
  const frame = (bytes: Buffer) => { hash.update(`${bytes.length}:`); hash.update(bytes); };
  for (const path of paths) {
    const file = regularFile(root, path);
    if (!file) continue;
    const bytes = path.split('/').at(-1) === '.npmrc' ? readPublicNpmConfig(file) : readFileSync(file);
    frame(Buffer.from(path)); frame(Buffer.from(lstatSync(file).mode & 0o111 ? '100755' : '100644')); frame(bytes);
  }
  return hash.digest('hex');
}
function binding(root: string): SourceBinding {
  return { root, head: oid(text(root, 'rev-parse', 'HEAD')), identity: sourceIdentity(root) };
}
function unchanged(expected: SourceBinding): void {
  const actual = binding(expected.root);
  if (actual.head !== expected.head || actual.identity !== expected.identity) throw new Error('Source binding changed before action');
}
function act(executable: 'git' | 'gh', args: string[], source: SourceBinding, authorize: BeforeRepositoryAction, recheck: () => void): Buffer {
  if (typeof authorize !== 'function') throw new Error('Host before-action authorizer required');
  const exactArgs = executable === 'git' ? [...gitOptions, ...args] : [...args];
  const decision: unknown = authorize(Object.freeze({ executable, args: Object.freeze(exactArgs), cwd: source.root,
    source: Object.freeze({ ...source }) }));
  if (decision !== undefined && decision !== true) throw new Error('Authorizer must decide synchronously; action denied');
  unchanged(source); recheck();
  return run(executable, exactArgs, source.root);
}
function safeCheckoutSource(info: RepositoryInfo): void {
  const now = discoverRepository(info.root);
  if (now.head !== info.head || now.remoteUrl !== info.remoteUrl || now.defaultBranch !== info.defaultBranch) throw new Error('Repository binding mismatch');
  if (now.dirtyPaths.length) throw new Error(`Dirty source repository: ${now.dirtyPaths.join(', ')}`);
  if (optional(info.root, 'config', '--get-regexp', '^filter\..*\.(smudge|process)$')) throw new Error('Checkout filters are unsupported');
  if (text(info.root, 'ls-files', '-v').split('\n').some(line => /^[a-zS]/.test(line))) throw new Error('Hidden index paths are unsupported');
}
export function createTaskWorktree(info: RepositoryInfo, taskId: string, parentDirectory: string, authorize: BeforeRepositoryAction): TaskCheckout {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(taskId)) throw new Error('Unsafe task ID');
  const parent = realpathSync(parentDirectory), root = join(parent, taskId), branch = `task/${taskId}`;
  if (parent === info.root || !relative(info.root, parent).startsWith(`..${sep}`) && relative(info.root, parent) !== '..') throw new Error('Task checkout must be outside source repository');
  const check = () => {
    safeCheckoutSource(info);
    if (branch === info.defaultBranch) throw new Error('Cannot create task on default branch');
    try { lstatSync(root); throw new Error('Task checkout path already exists'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (optional(info.root, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`) !== undefined) throw new Error('Task branch already exists');
  };
  check(); const source = binding(info.root);
  act('git', ['worktree', 'add', '-b', branch, '--', root, info.head], source, authorize, check);
  return { root: realpathSync(root), branch, baseHead: info.head, repository: discoverRepository(root) };
}
export function captureTicketDiff(workspace: string, baseHead: string, allowedPaths: readonly string[]): TicketDiff {
  const root = rootOf(workspace); oid(baseHead);
  const allowed = new Set(allowedPaths.map(safeSourcePath)), source = binding(root);
  git(root, 'cat-file', '-e', `${baseHead}^{commit}`);
  const untracked = names(git(root, 'ls-files', '--others', '--exclude-standard', '-z'));
  const paths = sorted([...names(git(root, 'diff', '--no-ext-diff', '--no-renames', '--name-only', '-z', baseHead, '--')),
    ...names(git(root, 'diff', '--cached', '--no-ext-diff', '--no-renames', '--name-only', '-z', baseHead, '--')), ...untracked]);
  if (paths.some(path => !allowed.has(path))) throw new Error(`Changes outside allowed exact files: ${paths.filter(path => !allowed.has(path)).join(', ')}`);
  let diff = git(root, 'diff', '--no-ext-diff', '--no-textconv', '--binary', '--no-renames', baseHead, '--', ...[...allowed].map(p => `:(literal)${p}`)).toString('utf8');
  for (const path of untracked) {
    regularFile(root, path);
    try { diff += git(root, 'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--binary', '--', '/dev/null', path).toString('utf8'); }
    catch (error) {
      const failure = error as { status?: number; stdout?: Buffer };
      if (failure.status !== 1 || !failure.stdout) throw error;
      diff += failure.stdout.toString('utf8');
    }
  }
  unchanged(source);
  return { ...source, baseHead, paths, diff };
}
/** Stages only ticket-owned exact files and commits the reviewed content; never pushes. */
export function commitTicketChanges(root: string, expectedSourceIdentity: string, paths: readonly string[], message: string,
  authorize: BeforeRepositoryAction): SourceBinding {
  if (!message.trim() || message.includes('\0')) throw new Error('Invalid commit message');
  const info = discoverRepository(root), source = binding(info.root);
  if (source.identity !== expectedSourceIdentity) throw new Error('Expected source identity mismatch');
  const branch = text(info.root, 'symbolic-ref', '--quiet', '--short', 'HEAD');
  const check = () => {
    const now = discoverRepository(info.root);
    if (now.remoteUrl !== info.remoteUrl || now.defaultBranch !== info.defaultBranch ||
        branch === now.defaultBranch || !/^task\/[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(branch) ||
        text(info.root, 'symbolic-ref', '--quiet', '--short', 'HEAD') !== branch) throw new Error('Commit requires bound non-default task branch');
    captureTicketDiff(info.root, info.head, paths);
  };
  check();
  const changed = captureTicketDiff(info.root, info.head, paths).paths;
  if (!changed.length) throw new Error('No ticket changes to commit');
  act('git', ['add', '--', ...changed.map(path => `:(literal)${path}`)], source, authorize, check);
  act('git', ['-c', 'commit.gpgSign=false', 'commit', '-m', message], source, authorize, check);
  const committed = binding(info.root);
  if (committed.identity !== expectedSourceIdentity || dirtyPaths(info.root).length) throw new Error('Committed source does not match reviewed content');
  return committed;
}
function credentialArgs(options: PublishOptions): string[] {
  const helper = options.gitCredentialHelper;
  if (!helper) return [];
  const { ghPath, sha256 } = helper;
  if (!/^\/[A-Za-z0-9_./-]+$/.test(ghPath) || realpathSync(ghPath) !== ghPath || !lstatSync(ghPath).isFile() ||
      !(lstatSync(ghPath).mode & 0o111) || !/^[a-f0-9]{64}$/.test(sha256) ||
      createHash('sha256').update(readFileSync(ghPath)).digest('hex') !== sha256) throw new Error('Unverified GitHub credential helper');
  // Fixed Git helper syntax, no ! shell helper and no caller-supplied arguments.
  return ['-c', 'credential.helper=', '-c', 'credential.https://github.com.helper=',
    '-c', `credential.https://github.com.helper=${ghPath} auth git-credential`];
}
function verifyCandidate(input: DraftPullRequestInput): RepositoryInfo {
  const info = discoverRepository(input.root);
  oid(input.expectedBase); oid(input.expectedHead);
  if (info.remoteUrl !== input.expectedRemoteUrl) throw new Error('Expected origin mismatch');
  if (info.head !== input.expectedHead) throw new Error('Expected head mismatch');
  if (info.dirtyPaths.length) throw new Error('Candidate must be clean and committed');
  if (!/^task\/[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(input.branch) || input.branch === info.defaultBranch ||
      text(info.root, 'symbolic-ref', '--quiet', '--short', 'HEAD') !== input.branch) throw new Error('Candidate must be on its non-default task branch');
  const baseRef = optional(info.root, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${info.defaultBranch}^{commit}`) ??
    optional(info.root, 'rev-parse', '--verify', '--quiet', `refs/heads/${info.defaultBranch}^{commit}`);
  if (baseRef !== input.expectedBase) throw new Error('Expected base mismatch');
  git(info.root, 'merge-base', '--is-ancestor', input.expectedBase, input.expectedHead);
  if (input.expectedBase === input.expectedHead) throw new Error('Candidate has no committed changes');
  return info;
}
export function prepareDraftPullRequest(input: DraftPullRequestInput): PreparedDraftPullRequest {
  if (!input.title.trim() || /[\x00-\x1f]/.test(input.title) || !input.body.trim() || input.body.includes('\0')) throw new Error('Invalid PR title or body');
  const repository = verifyCandidate(input), diff = captureTicketDiff(repository.root, input.expectedBase, input.allowedPaths);
  return { ...input, root: repository.root, allowedPaths: [...input.allowedPaths], repository, diff,
    source: { root: repository.root, head: diff.head, identity: diff.identity } };
}
function existingPr(prepared: PreparedDraftPullRequest, response: Buffer): string | undefined {
  const { repository: repo } = prepared;
  const rows: unknown = JSON.parse(response.toString('utf8'));
  if (!Array.isArray(rows)) throw new Error('Invalid GitHub PR discovery response');
  if (rows.length === 0) return undefined;
  if (rows.length !== 1) throw new Error('Ambiguous existing PR');
  const row = rows[0] as Record<string, unknown>;
  if (row.state !== 'OPEN' || row.isDraft !== true || row.headRefOid !== prepared.expectedHead || row.baseRefOid !== prepared.expectedBase) throw new Error('Existing PR does not match expected draft/base/head');
  return prUrl(row.url, repo);
}
function prUrl(value: unknown, repo: RepositoryInfo): string {
  const prefix = `https://github.com/${repo.owner}/${repo.repo}/pull/`;
  if (typeof value !== 'string' || !value.startsWith(prefix) || !/^[1-9][0-9]*$/.test(value.slice(prefix.length))) throw new Error('Invalid GitHub PR URL');
  return value;
}
/** Body file is supplied by the host; preparation itself performs no writes. Network calls require host authorization. */
export function publishDraftPullRequest(prepared: PreparedDraftPullRequest, bodyFile: string, authorize: BeforeRepositoryAction, options: PublishOptions = {}): PublishedDraftPullRequest {
  const fresh = prepareDraftPullRequest(prepared);
  if (fresh.source.identity !== prepared.source.identity || fresh.repository.defaultBranch !== prepared.repository.defaultBranch ||
      fresh.repository.owner !== prepared.repository.owner || fresh.repository.repo !== prepared.repository.repo || prepared.source.root !== fresh.root ||
      prepared.source.head !== fresh.expectedHead) throw new Error('Prepared source/repository binding mismatch');
  const file = resolve(bodyFile);
  if (!isAbsolute(bodyFile) || lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile() || realpathSync(file) !== file || readFileSync(file, 'utf8') !== prepared.body) throw new Error('PR body file mismatch or unsafe path');
  const helperArgs = credentialArgs(options);
  const check = () => {
    verifyCandidate(fresh);
    if (JSON.stringify(credentialArgs(options)) !== JSON.stringify(helperArgs)) throw new Error('Credential helper changed');
    if (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile() || realpathSync(file) !== file || readFileSync(file, 'utf8') !== fresh.body) throw new Error('PR body file changed');
  };
  // Discovery is read-only but still authorized because it accesses the remote service.
  const discovery = act('gh', ['pr', 'list', '--repo', `${fresh.repository.owner}/${fresh.repository.repo}`, '--head', fresh.branch,
    '--base', fresh.repository.defaultBranch, '--state', 'all', '--json', 'url,isDraft,headRefOid,baseRefOid,state'], fresh.source,
    authorize, check);
  const existing = existingPr(fresh, discovery);
  if (existing) return { url: existing, existing: true };
  act('git', [...helperArgs, 'push', '--no-verify', 'origin', `${fresh.expectedHead}:refs/heads/${fresh.branch}`], fresh.source, authorize, check);
  const created = act('gh', ['pr', 'create', '--draft', '--repo', `${fresh.repository.owner}/${fresh.repository.repo}`,
    '--base', fresh.repository.defaultBranch, '--head', fresh.branch, '--title', fresh.title, '--body-file', file], fresh.source, authorize, check);
  return { url: prUrl(created.toString('utf8').trim(), fresh.repository), existing: false };
}
