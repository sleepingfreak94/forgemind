import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { captureTicketDiff, commitTicketChanges, createTaskWorktree, discoverRepository, parseGitHubRemote, prepareDraftPullRequest,
  publishDraftPullRequest, sourceIdentity } from '../../src/live-workflow/repository.js';
import type { BeforeRepositoryAction, DraftPullRequestInput, RepositoryAction } from '../../src/live-workflow/repository.js';

const remote = 'https://github.com/forge-fixture/project.git';
const realExec = childProcess.execFileSync;
function git(root: string, ...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return realExec('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, encoding: 'utf8',
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function fixture(t: TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'forgemind-repository-'))), root = join(base, 'source');
  mkdirSync(root); t.after(() => rmSync(base, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
  git(root, 'remote', 'add', 'origin', remote);
  writeFileSync(join(root, 'source.txt'), 'baseline\n'); writeFileSync(join(root, '.gitignore'), 'artifacts/\n.env\n');
  git(root, 'add', '--', 'source.txt', '.gitignore'); git(root, 'commit', '-m', 'fixture baseline');
  const info = discoverRepository(root), actions: RepositoryAction[] = [];
  const authorize: BeforeRepositoryAction = action => { actions.push(action); };
  return { base, root, info, actions, authorize };
}
function candidate(t: TestContext) {
  const f = fixture(t), checkout = createTaskWorktree(f.info, 'ticket-1', f.base, f.authorize);
  writeFileSync(join(checkout.root, 'source.txt'), 'candidate\n'); git(checkout.root, 'add', 'source.txt'); git(checkout.root, 'commit', '-m', 'fixture candidate');
  const input: DraftPullRequestInput = { root: checkout.root, branch: checkout.branch, expectedBase: f.info.head,
    expectedHead: git(checkout.root, 'rev-parse', 'HEAD'), expectedRemoteUrl: remote, allowedPaths: ['source.txt'], title: 'Fixture change', body: 'Before: baseline\nAfter: candidate\n' };
  const prepared = prepareDraftPullRequest(input), bodyFile = join(f.base, 'pr-body.txt'); writeFileSync(bodyFile, input.body);
  return { ...f, checkout, input, prepared, bodyFile };
}
function interceptNetwork(t: TestContext, response: unknown = []) {
  const calls: { executable: string; args: string[] }[] = [];
  t.mock.method(childProcess, 'execFileSync', (executable: string, args: string[], options: unknown) => {
    const command = args[0]?.endsWith('/repository-supervisor.js')
      ? JSON.parse(Buffer.from(args[1]!, 'base64url').toString()) as {executable:string;args:string[]}
      : {executable,args};
    if (command.executable === 'gh' || command.executable === 'git' && command.args.includes('push')) {
      calls.push(command);
      return Buffer.from(command.executable === 'git' ? '' : command.args[1] === 'list' ? JSON.stringify(response) : 'https://github.com/forge-fixture/project/pull/23\n');
    }
    return realExec(executable, args, options as Parameters<typeof realExec>[2]);
  });
  return calls;
}

test('discovery canonicalizes nested workspace and validates GitHub remote forms', t => {
  const f = fixture(t); mkdirSync(join(f.root, 'nested'));
  const info = discoverRepository(join(f.root, 'nested'));
  assert.equal(info.root, f.root); assert.equal(info.defaultBranch, 'main'); assert.deepEqual(info.dirtyPaths, []);
  for (const url of [remote, 'https://github.com/forge-fixture/project', 'git@github.com:forge-fixture/project.git', 'ssh://git@github.com/forge-fixture/project.git']) {
    assert.deepEqual(parseGitHubRemote(url), { owner: 'forge-fixture', repo: 'project' });
  }
  for (const url of ['https://gitlab.com/o/r', 'https://github.com/o/../r', 'https://token@github.com/o/r', 'git@github.com:o/r;evil', 'file:///repo', 'ssh://root@github.com/o/r', 'https://github.com/o/r?x=1']) {
    assert.throws(() => parseGitHubRemote(url), /Only GitHub/);
  }
});

test('default branch detection supports origin/HEAD and refuses ambiguity', t => {
  const f = fixture(t); git(f.root, 'branch', 'master');
  assert.throws(() => discoverRepository(f.root), /Default branch unknown/);
  git(f.root, 'update-ref', 'refs/remotes/origin/trunk', f.info.head);
  git(f.root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
  assert.equal(discoverRepository(f.root).defaultBranch, 'trunk');
});

test('dirty tracked, staged, renamed, and nonignored untracked files block checkout before authorization', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'source.txt'), 'changed\n'); writeFileSync(join(f.root, 'new file.txt'), 'new\n');
  assert.deepEqual(discoverRepository(f.root).dirtyPaths, ['new file.txt', 'source.txt']);
  assert.throws(() => createTaskWorktree(f.info, 'dirty', f.base, f.authorize), /Dirty source/);
  rmSync(join(f.root, 'new file.txt')); git(f.root, 'add', 'source.txt');
  writeFileSync(join(f.root, 'source.txt'), 'baseline\n');
  assert.throws(() => createTaskWorktree(f.info, 'staged', f.base, f.authorize), /Dirty source/);
  git(f.root, 'reset', '--hard', 'HEAD'); git(f.root, 'mv', 'source.txt', 'renamed.txt');
  assert.ok(discoverRepository(f.root).dirtyPaths.includes('renamed.txt')); assert.equal(f.actions.length, 0);
});

test('task worktree uses exact HEAD, authorizes exact command, and does not import ignored artifacts', t => {
  const f = fixture(t); mkdirSync(join(f.root, 'artifacts')); writeFileSync(join(f.root, 'artifacts', 'recording'), 'ignored');
  writeFileSync(join(f.root, '.env'), 'fixture only');
  const checkout = createTaskWorktree(f.info, 'ticket-10', f.base, f.authorize);
  assert.equal(checkout.baseHead, f.info.head); assert.equal(git(checkout.root, 'rev-parse', 'HEAD'), f.info.head);
  assert.equal(git(checkout.root, 'branch', '--show-current'), 'task/ticket-10');
  assert.equal(existsSync(join(checkout.root, 'artifacts')), false); assert.equal(existsSync(join(checkout.root, '.env')), false);
  assert.equal(sourceIdentity(f.root), sourceIdentity(checkout.root)); assert.equal(f.actions.length, 1);
  assert.equal(f.actions[0]!.executable, 'git'); assert.equal(f.actions[0]!.cwd, f.root);
  assert.deepEqual(f.actions[0]!.args.slice(-7), ['worktree', 'add', '-b', 'task/ticket-10', '--', checkout.root, f.info.head]);
  assert.equal(f.actions[0]!.source.identity, sourceIdentity(f.root));
});

test('unsafe IDs, existing paths/branches, nested checkouts and default branch are rejected', t => {
  const f = fixture(t);
  for (const taskId of ['../escape', '-flag', 'a/b', 'a..b', 'a b', 'a;echo', '']) assert.throws(() => createTaskWorktree(f.info, taskId, f.base, f.authorize), /Unsafe task ID/);
  mkdirSync(join(f.base, 'occupied')); writeFileSync(join(f.base, 'occupied', 'keep'), 'keep');
  assert.throws(() => createTaskWorktree(f.info, 'occupied', f.base, f.authorize), /already exists/);
  assert.equal(readFileSync(join(f.base, 'occupied', 'keep'), 'utf8'), 'keep');
  git(f.root, 'branch', 'task/reserved'); assert.throws(() => createTaskWorktree(f.info, 'reserved', f.base, f.authorize), /branch already exists/);
  assert.throws(() => createTaskWorktree(f.info, 'nested', f.root, f.authorize), /outside source/);
  git(f.root, 'update-ref', 'refs/remotes/origin/task/default', f.info.head);
  git(f.root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/task/default');
  assert.throws(() => createTaskWorktree(discoverRepository(f.root), 'default', f.base, f.authorize), /default branch/);
  assert.equal(f.actions.length, 0);
});

test('denial and stale source bindings prevent worktree mutation', t => {
  const f = fixture(t);
  assert.throws(() => createTaskWorktree(f.info, 'denied', f.base, () => { throw new Error('policy denied'); }), /policy denied/);
  assert.equal(existsSync(join(f.base, 'denied')), false);
  assert.throws(() => createTaskWorktree(f.info, 'raced', f.base, () => { writeFileSync(join(f.root, 'source.txt'), 'callback race'); }), /Source binding changed/);
  assert.equal(existsSync(join(f.base, 'raced')), false);
  assert.throws(() => createTaskWorktree({ ...f.info, head: '0'.repeat(40) }, 'stale', f.base, f.authorize), /binding mismatch/);
});

test('source identity binds path bytes, contents and executable mode but ignores ignored artifacts', t => {
  const f = fixture(t), baseline = sourceIdentity(f.root);
  assert.match(baseline, /^[a-f0-9]{64}$/); assert.equal(sourceIdentity(f.root), baseline);
  mkdirSync(join(f.root, 'artifacts')); writeFileSync(join(f.root, 'artifacts', 'out'), 'ignored'); assert.equal(sourceIdentity(f.root), baseline);
  chmodSync(join(f.root, 'source.txt'), 0o755); assert.notEqual(sourceIdentity(f.root), baseline); chmodSync(join(f.root, 'source.txt'), 0o644);
  renameSync(join(f.root, 'source.txt'), join(f.root, 'renamed.txt')); assert.notEqual(sourceIdentity(f.root), baseline);
  renameSync(join(f.root, 'renamed.txt'), join(f.root, 'source.txt')); assert.equal(sourceIdentity(f.root), baseline);
  writeFileSync(join(f.root, 'source.txt'), 'changed'); assert.notEqual(sourceIdentity(f.root), baseline);
});

test('source identity rejects symlinks including parent escapes before reading targets', t => {
  const f = fixture(t); writeFileSync(join(f.base, 'outside'), 'never import');
  symlinkSync(join(f.base, 'outside'), join(f.root, 'link'));
  assert.throws(() => sourceIdentity(f.root), /Symlink/); rmSync(join(f.root, 'link'));
  mkdirSync(join(f.root, 'dir')); writeFileSync(join(f.root, 'dir', 'nested.txt'), 'tracked'); git(f.root, 'add', 'dir'); git(f.root, 'commit', '-m', 'nested');
  rmSync(join(f.root, 'dir'), { recursive: true }); symlinkSync(f.base, join(f.root, 'dir'));
  assert.throws(() => sourceIdentity(f.root), /Symlink/);
});

test('source identity rejects tracked symlinks, secrets and unsafe Git paths', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, '.env.example'), 'EXAMPLE='); assert.doesNotThrow(() => sourceIdentity(f.root)); rmSync(join(f.root, '.env.example'));
  for (const name of ['.env.local', 'credentials.json', 'private.pem', 'bad\\name', 'line\nname']) {
    writeFileSync(join(f.root, name), 'fixture'); assert.throws(() => sourceIdentity(f.root), /Secret-bearing|Unsafe Git/); rmSync(join(f.root, name));
  }
  writeFileSync(join(f.root, '.env'), 'fixture'); git(f.root, 'add', '-f', '.env');
  assert.throws(() => sourceIdentity(f.root), /Secret-bearing/); git(f.root, 'reset', 'HEAD', '.env'); rmSync(join(f.root, '.env'));
  symlinkSync('source.txt', join(f.root, 'tracked-link')); git(f.root, 'add', 'tracked-link'); assert.throws(() => sourceIdentity(f.root), /Symlink/);
});

test('diff covers owned edits/new files and blocks pathspec injection or other exact files', t => {
  const f = fixture(t); writeFileSync(join(f.root, 'source.txt'), 'candidate\n'); writeFileSync(join(f.root, 'new.txt'), 'added\n');
  assert.throws(() => captureTicketDiff(f.root, f.info.head, ['source.txt']), /outside allowed exact/);
  const diff = captureTicketDiff(f.root, f.info.head, ['source.txt', 'new.txt']);
  assert.deepEqual(diff.paths, ['new.txt', 'source.txt']); assert.match(diff.diff, /\+candidate/); assert.match(diff.diff, /\+added/);
  for (const allowed of ['../source.txt', '*', ':(glob)**', '/source.txt']) assert.throws(() => captureTicketDiff(f.root, f.info.head, [allowed]), /Unsafe Git/);
  assert.throws(() => captureTicketDiff(f.root, '--all', ['source.txt']), /exact commit/);
});

test('diff detects rename source outside ownership and staged changes hidden by worktree', t => {
  const f = fixture(t); git(f.root, 'mv', 'source.txt', 'other.txt');
  assert.throws(() => captureTicketDiff(f.root, f.info.head, ['other.txt']), /source.txt/);
  git(f.root, 'reset', '--hard', 'HEAD'); writeFileSync(join(f.root, 'source.txt'), 'staged'); git(f.root, 'add', 'source.txt');
  writeFileSync(join(f.root, 'source.txt'), 'baseline\n'); assert.throws(() => captureTicketDiff(f.root, f.info.head, []), /outside allowed exact/);
});

test('origin overrides, URL rewrites and unsupported providers are refused', t => {
  const f = fixture(t); git(f.root, 'config', 'remote.origin.pushurl', 'git@github.com:other/repo.git');
  assert.throws(() => discoverRepository(f.root), /mismatched push remote/);
  git(f.root, 'config', '--unset', 'remote.origin.pushurl'); git(f.root, 'config', 'url.https://github.com/other/.insteadOf', 'https://github.com/forge-fixture/');
  assert.throws(() => discoverRepository(f.root), /URL rewrite/);
  git(f.root, 'config', '--remove-section', 'url.https://github.com/other/'); git(f.root, 'remote', 'set-url', 'origin', 'https://gitlab.com/forge-fixture/project');
  assert.throws(() => discoverRepository(f.root), /Only GitHub/);
});

test('draft preparation requires exact base/head/origin, committed source and non-default task branch', t => {
  const f = candidate(t); assert.equal(f.prepared.source.head, f.input.expectedHead); assert.match(f.prepared.diff.diff, /candidate/);
  assert.throws(() => prepareDraftPullRequest({ ...f.input, expectedHead: f.info.head }), /head mismatch/);
  assert.throws(() => prepareDraftPullRequest({ ...f.input, expectedBase: '0'.repeat(40) }), /base mismatch/);
  assert.throws(() => prepareDraftPullRequest({ ...f.input, expectedRemoteUrl: 'https://github.com/other/repo' }), /origin mismatch/);
  assert.throws(() => prepareDraftPullRequest({ ...f.input, branch: 'main' }), /non-default task branch/);
  assert.throws(() => prepareDraftPullRequest({ ...f.input, allowedPaths: [] }), /outside allowed exact/);
  writeFileSync(join(f.checkout.root, 'source.txt'), 'dirty'); assert.throws(() => prepareDraftPullRequest(f.input), /clean and committed/);
});

test('publish authorizes exact commands before each call, pushes without force and creates only draft', t => {
  const f = candidate(t), calls = interceptNetwork(t), decisions: RepositoryAction[] = [];
  const result = publishDraftPullRequest(f.prepared, f.bodyFile, action => {
    assert.equal(calls.length, decisions.length); decisions.push(action);
  });
  assert.deepEqual(result, { url: 'https://github.com/forge-fixture/project/pull/23', existing: false });
  assert.equal(calls.length, 3); assert.equal(decisions.length, 3);
  calls.forEach((call, index) => assert.deepEqual(call.args, decisions[index]!.args));
  assert.deepEqual(calls[1]!.args.slice(-4), ['push', '--no-verify', 'origin', `${f.input.expectedHead}:refs/heads/task/ticket-1`]);
  assert.ok(calls[2]!.args.includes('--draft')); assert.ok(calls[2]!.args.includes('--body-file'));
  assert.ok(calls.every(call => !call.args.includes('--force') && !call.args.includes('merge')));
});

test('existing matching draft is reused without push/upload and closed or mismatched PRs block', t => {
  const f = candidate(t), rows = [{ url: 'https://github.com/forge-fixture/project/pull/23', isDraft: true,
    headRefOid: f.input.expectedHead, baseRefOid: f.input.expectedBase, state: 'OPEN' }];
  const calls = interceptNetwork(t, rows);
  assert.equal(publishDraftPullRequest(f.prepared, f.bodyFile, f.authorize).existing, true); assert.equal(calls.length, 1);
  rows[0]!.headRefOid = '0'.repeat(40); assert.throws(() => publishDraftPullRequest(f.prepared, f.bodyFile, f.authorize), /does not match/);
  rows[0]!.headRefOid = f.input.expectedHead; rows[0]!.state = 'CLOSED'; assert.throws(() => publishDraftPullRequest(f.prepared, f.bodyFile, f.authorize), /does not match/);
  assert.ok(calls.every(call => call.executable === 'gh' && call.args[1] === 'list'));
});

test('publication stops on policy denial, stale source, tampered prepared repository and body mismatch', t => {
  const f = candidate(t), calls = interceptNetwork(t);
  assert.throws(() => publishDraftPullRequest(f.prepared, f.bodyFile, () => { throw new Error('denied'); }), /denied/); assert.equal(calls.length, 0);
  assert.throws(() => publishDraftPullRequest({ ...f.prepared, repository: { ...f.prepared.repository, owner: 'other' } }, f.bodyFile, f.authorize), /binding mismatch/);
  writeFileSync(f.bodyFile, 'tampered'); assert.throws(() => publishDraftPullRequest(f.prepared, f.bodyFile, f.authorize), /body file mismatch/);
  writeFileSync(f.bodyFile, f.input.body); writeFileSync(join(f.checkout.root, 'new'), 'untracked');
  assert.throws(() => publishDraftPullRequest(f.prepared, f.bodyFile, f.authorize), /clean and committed/); assert.equal(calls.length, 0);
});

test('authorization cannot redirect origin or modify source before push', t => {
  const f = candidate(t), calls = interceptNetwork(t);
  assert.throws(() => publishDraftPullRequest(f.prepared, f.bodyFile, action => {
    if (action.executable === 'git') git(f.checkout.root, 'remote', 'set-url', 'origin', 'https://github.com/other/repo');
  }), /origin mismatch/);
  assert.equal(calls.length, 1);
});


test('ticket commit authorizes staging and commit separately and preserves reviewed content identity', t => {
  const f = fixture(t), checkout = createTaskWorktree(f.info, 'commit', f.base, f.authorize);
  writeFileSync(join(checkout.root, 'source.txt'), 'reviewed\n'); const identity = sourceIdentity(checkout.root);
  const decisions: RepositoryAction[] = [];
  const result = commitTicketChanges(checkout.root, identity, ['source.txt'], 'feat(fixture): reviewed change', action => { decisions.push(action); });
  assert.equal(result.identity, identity); assert.notEqual(result.head, f.info.head); assert.deepEqual(discoverRepository(checkout.root).dirtyPaths, []);
  assert.equal(decisions.length, 2); assert.ok(decisions[0]!.args.includes('add')); assert.ok(decisions[1]!.args.includes('commit'));
});

test('ticket commit rejects stale content, default branch, foreign files and denied commits', t => {
  const f = fixture(t); writeFileSync(join(f.root, 'source.txt'), 'dirty');
  assert.throws(() => commitTicketChanges(f.root, sourceIdentity(f.root), ['source.txt'], 'message', f.authorize), /non-default task branch/);
  git(f.root, 'reset', '--hard', 'HEAD'); const checkout = createTaskWorktree(f.info, 'commit', f.base, f.authorize);
  writeFileSync(join(checkout.root, 'source.txt'), 'reviewed');
  assert.throws(() => commitTicketChanges(checkout.root, '0'.repeat(64), ['source.txt'], 'message', f.authorize), /identity mismatch/);
  assert.throws(() => commitTicketChanges(checkout.root, sourceIdentity(checkout.root), [], 'message', f.authorize), /outside allowed/);
  assert.throws(() => commitTicketChanges(checkout.root, sourceIdentity(checkout.root), ['source.txt'], 'message', action => {
    if (action.args.includes('commit')) throw new Error('commit denied');
  }), /commit denied/);
  assert.equal(git(checkout.root, 'rev-parse', 'HEAD'), f.info.head);
});
test('explicit commit author overrides role config and ambient identity without persisting config', t => {
  const f = fixture(t), checkout = createTaskWorktree(f.info, 'author', f.base, f.authorize);
  git(checkout.root, 'config', '--unset', 'user.name'); git(checkout.root, 'config', '--unset', 'user.email');
  for (const role of ['author', 'committer']) {
    git(checkout.root, 'config', `${role}.name`, 'Configured Override');
    git(checkout.root, 'config', `${role}.email`, 'configured@example.invalid');
  }
  const configFile = join(f.root, '.git/config'), config = readFileSync(configFile);
  const author = { name: 'Repository Owner', email: '123+owner@users.noreply.github.com' };
  const decisions: RepositoryAction[] = [];
  for (const [key, value] of Object.entries({ GIT_AUTHOR_NAME: 'Ambient Impostor', GIT_COMMITTER_NAME: 'Ambient Impostor',
    GIT_AUTHOR_EMAIL: 'impostor@example.invalid', GIT_COMMITTER_EMAIL: 'impostor@example.invalid' })) {
    const previous = process.env[key]; process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  writeFileSync(join(checkout.root, 'source.txt'), 'explicit author\n');
  const identity = sourceIdentity(checkout.root);
  const result = commitTicketChanges(checkout.root, identity, ['source.txt'], 'feat(fixture): explicit author', action => {
    decisions.push(action);
    // An authorization callback cannot swap the already validated identity.
    author.name = 'Changed'; author.email = 'changed@example.invalid';
  }, author);
  assert.equal(result.identity, identity);
  assert.equal(git(checkout.root, 'log', '-1', '--format=%an <%ae>|%cn <%ce>'),
    'Repository Owner <123+owner@users.noreply.github.com>|Repository Owner <123+owner@users.noreply.github.com>');
  assert.deepEqual(readFileSync(configFile), config);
  assert.ok(decisions[1]!.args.includes('user.name=Repository Owner'));
  assert.ok(decisions[1]!.args.includes('user.email=123+owner@users.noreply.github.com'));
  for (const role of ['author', 'committer']) {
    assert.ok(decisions[1]!.args.includes(`${role}.name=Repository Owner`));
    assert.ok(decisions[1]!.args.includes(`${role}.email=123+owner@users.noreply.github.com`));
  }
  assert.ok(!decisions[0]!.args.some(arg => /^(user|author|committer)\./.test(arg)));
});
test('invalid explicit authors fail before repository access, staging or authorization', () => {
  for (const author of [null, {}, { name: '', email: 'owner@example.com' },
    { name: 'Owner\nOther', email: 'owner@example.com' }, { name: 'Owner <Other>', email: 'owner@example.com' },
    { name: 'A'.repeat(121), email: 'owner@example.com' }, { name: 'Owner', email: 'bad' },
    { name: 'Owner', email: 'owner@example.com\n' },
    { name: 'Owner', email: 'owner@example.com\nuser.name=Other' }])
    assert.throws(() => commitTicketChanges('/missing', '', [], 'message', () => { throw Error('must not authorize'); },
      author as { name: string; email: string }), /valid bounded commit author/);
});

test('publishing permits only explicitly hash-pinned fixed gh credential helper arguments', t => {
  const f = candidate(t), calls = interceptNetwork(t), ghPath = join(f.base, 'gh-helper');
  writeFileSync(ghPath, 'fixture executable not actually run'); chmodSync(ghPath, 0o755);
  const sha256 = createHash('sha256').update(readFileSync(ghPath)).digest('hex');
  assert.throws(() => publishDraftPullRequest(f.prepared, f.bodyFile, f.authorize,
    { gitCredentialHelper: { ghPath, sha256: '0'.repeat(64) } }), /Unverified/);
  assert.equal(calls.length, 0);
  assert.throws(() => publishDraftPullRequest(f.prepared, f.bodyFile, f.authorize,
    { gitCredentialHelper: { ghPath: ghPath + ' auth git-credential;evil', sha256 } }), /Unverified/);
  assert.equal(calls.length, 0);
  publishDraftPullRequest(f.prepared, f.bodyFile, f.authorize, { gitCredentialHelper: { ghPath, sha256 } });
  assert.ok(calls[1]!.args.includes(`credential.https://github.com.helper=${ghPath} auth git-credential`));
  assert.ok(calls[1]!.args.includes('credential.helper='));
  assert.throws(() => publishDraftPullRequest(f.prepared, f.bodyFile, () => {
    writeFileSync(ghPath, 'changed after authorization');
  }, { gitCredentialHelper: { ghPath, sha256 } }), /Unverified/);
  assert.equal(calls.length, 3, 'changed helper must stop dispatch before discovery or push');
});

test('hidden index flags, checkout filters and authorizer body-file substitution fail closed', t => {
  const f = fixture(t); git(f.root, 'update-index', '--assume-unchanged', 'source.txt');
  assert.throws(() => sourceIdentity(f.root), /Hidden index/); git(f.root, 'update-index', '--no-assume-unchanged', 'source.txt');
  git(f.root, 'config', 'filter.bad.smudge', 'arbitrary-command');
  assert.throws(() => createTaskWorktree(f.info, 'filtered', f.base, f.authorize), /filters are unsupported/);
  const c = candidate(t), calls = interceptNetwork(t); writeFileSync(join(c.base, 'other-body'), c.input.body);
  assert.throws(() => publishDraftPullRequest(c.prepared, c.bodyFile, () => {
    rmSync(c.bodyFile); symlinkSync(join(c.base, 'other-body'), c.bodyFile);
  }), /body file changed/); assert.equal(calls.length, 0);
});

test('readiness and source discovery reject clean filters before executing any repository command', t => {
  const f = fixture(t), marker = join(f.root, 'filter-ran');
  writeFileSync(join(f.root, '.git/info/attributes'), 'source.txt filter=trap\n');
  git(f.root, 'config', 'filter.trap.clean', 'printf ran > filter-ran; cat');
  writeFileSync(join(f.root, 'source.txt'), 'modified source requiring Git content inspection\n');
  for (const inspect of [() => discoverRepository(f.root), () => sourceIdentity(f.root),
    () => captureTicketDiff(f.root, f.info.head, ['source.txt']),
    () => createTaskWorktree(f.info, 'filter-denied', f.base, f.authorize)]) {
    assert.throws(inspect, /filters are unsupported/);
    assert.equal(existsSync(marker), false, 'clean filter must never run');
  }
  assert.equal(f.actions.length, 0);
});
