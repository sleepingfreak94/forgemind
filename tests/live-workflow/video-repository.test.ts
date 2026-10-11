import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { repositoryProcess } from '../../src/live-workflow/repository-process.js';
import type { EvidenceManifest } from '../../src/live-workflow/evidence.js';
import { sourceIdentity } from '../../src/live-workflow/repository.js';
import { deliverReviewedVideo, prepareVideoDelivery } from '../../src/live-workflow/video-delivery.js';
import { publishVideoRepository, validateVideoHelperHome } from '../../src/live-workflow/video-repository.js';
import type { VideoActionOutcome, VideoDeliveryAction } from '../../src/live-workflow/video-repository.js';
import type { VideoDeliveryInput, VideoDeliveryOptions } from '../../src/live-workflow/video-delivery.js';

const hash = (v: string) => createHash('sha256').update(v).digest('hex');
function git(root: string, ...args: string[]): string {
  return repositoryProcess('git', ['-c', 'core.hooksPath=/dev/null', ...args], root,
    { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }).toString().trim();
}
function manifest(root: string, phase: 'before' | 'after', source: string): EvidenceManifest {
  const data = `${phase} synthetic unit-test bytes`, path = join(root, `${phase}.mp4`); writeFileSync(path, data);
  // Synthetic test data exercises the host trust contract; it is never visual evidence.
  const body = { version: 1 as const, taskId: 'ticket', scenarioId: 'scenario', phase, label: phase === 'before' ? 'Before' as const : 'After' as const,
    baselineIdentity: 'a'.repeat(40), sourceIdentity: phase === 'before' ? 'a'.repeat(40) : source,
    captureTarget: 'private capture', provenance: 'host-recording' as const, delivery: 'local-only' as const,
    artifactPath: path, artifactSha256: hash(data), artifactBytes: Buffer.byteLength(data),
    video: { durationSeconds: 1, width: 320, height: 240, frames: 15 },
    startedAt: '2026-10-08T00:00:00Z', completedAt: '2026-10-08T00:00:01Z', authorizations:
    [{ action: 'record' as const, receiptId: 'fixture-record', envelopeSha256: hash('record') },
      { action: 'probe' as const, receiptId: 'fixture-probe', envelopeSha256: hash('probe') }] };
  return { ...body, manifestSha256: hash(JSON.stringify(body)) };
}
function fixture(t: TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'video-delivery-test-'))), root = join(base, 'source');
  t.after(() => rmSync(base, { recursive: true, force: true })); mkdirSync(root);
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'Test Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(root, 'code.txt'), 'baseline'); git(root, 'add', 'code.txt'); git(root, 'commit', '-m', 'fixture');
  git(root, 'remote', 'add', 'origin', 'https://github.com/fixture/project.git');
  const identity = sourceIdentity(root), before = manifest(base, 'before', identity), after = manifest(base, 'after', identity);
  const input: VideoDeliveryInput = { projectRoot: root, before, after,
    expected: { taskId: 'ticket', scenarioId: 'scenario', baselineIdentity: before.sourceIdentity, sourceIdentity: identity } };
  const actions: VideoDeliveryAction[] = [], outcomes: VideoActionOutcome[] = [];
  mkdirSync(join(base, 'evidence'), { mode: 0o700 });
  const options: VideoDeliveryOptions = { author: { name: 'Test Fixture', email: 'fixture@example.invalid' }, evidenceParent: join(base, 'evidence'),
    budget: { deadline: Date.now() + 120000 },
    verifyReview: async binding => ({ ...binding, codeReviewReceiptId: 'code', visualReviewReceiptId: 'visual',
      independentCodeReview: true, codeVerdict: 'pass', visualPlaybackApproved: true, privacyApproved: true }),
    authorize: async action => { actions.push(action); return { receiptId: `receipt-${actions.length}`, check() {}, finish(outcome) { outcomes.push(outcome); } }; } };
  return { base, root, input, options, actions, outcomes };
}
const realExec = childProcess.execFileSync;
function network(t: TestContext, mode: 'success' | 'throw-push' | 'missing-confirmation' | 'wrong-existing' = 'success',
  onCommand?: (command: { args: string[]; cwd: string }) => void) {
  const calls: { args: string[]; cwd: string; env: NodeJS.ProcessEnv }[] = [];
  let pushed: string | undefined;
  t.mock.method(childProcess, 'execFileSync', (executable: string, args: string[], options: Parameters<typeof realExec>[2]) => {
    if (args[0]?.endsWith('/repository-supervisor.js')) {
      const command = JSON.parse(Buffer.from(args[1]!, 'base64url').toString()) as { executable: string; args: string[]; cwd: string };
      onCommand?.(command);
      if (command.args.includes('push') || command.args.includes('ls-remote')) {
        calls.push({ ...command, env: (options as { env: NodeJS.ProcessEnv }).env });
        if (command.args.includes('push')) {
          pushed = command.args.at(-1)!.split(':')[0];
          if (mode === 'throw-push') throw new Error('indeterminate socket close');
          return Buffer.from('');
        }
        const oid = mode === 'wrong-existing' ? '0'.repeat(40) : mode === 'missing-confirmation' ? undefined : pushed;
        return Buffer.from(oid ? `${oid}\t${command.args.at(-1)!}\n` : '');
      }
    }
    return realExec(executable, args, options);
  });
  return calls;
}
test('delivery uses isolated orphan commit, sanitized export and only commit-bound confirmed links', async t => {
  const f = fixture(t), calls = network(t), baseline = sourceIdentity(f.root), head = git(f.root, 'rev-parse', 'HEAD');
  const bundle = prepareVideoDelivery(f.input), result = await deliverReviewedVideo(bundle, f.options);
  assert.equal(result.status, 'delivered', JSON.stringify(result));
  if (result.status !== 'delivered') return;
  assert.equal(calls.length, 3); assert.equal(f.actions.length, f.outcomes.length);
  assert.deepEqual(f.actions.map(a => a.kind), ['create-isolated-repository', 'git-init', 'write-export', 'git-add', 'git-commit', 'remote-check', 'push', 'remote-check']);
  assert.match(result.beforeUrl, /^https:\/\/github\.com\/fixture\/project\/blob\/[a-f0-9]{40}\/before\.mp4$/);
  assert.ok(result.afterUrl.includes(result.commit)); assert.ok(result.indexUrl.endsWith('/evidence.json'));
  const root = f.actions[0]!.cwd;
  assert.equal(git(root, 'rev-list', '--parents', '-n', '1', result.commit), result.commit);
  assert.deepEqual(git(root, 'ls-tree', '--name-only', result.commit).split('\n'), ['after.mp4', 'before.mp4', 'evidence.json']);
  assert.equal(git(root, 'show', '--format=%an <%ae>', '--no-patch', result.commit), 'Test Fixture <fixture@example.invalid>');
  const exported = readFileSync(join(root, 'evidence.json'), 'utf8');
  for (const secret of [f.base, 'artifactPath', 'captureTarget', 'private capture', 'fixture-record', 'scenario"', 'authorizations']) assert.ok(!exported.includes(secret));
  assert.equal(hash(exported), bundle.exportSha256); assert.equal(sourceIdentity(f.root), baseline); assert.equal(git(f.root, 'rev-parse', 'HEAD'), head);
  assert.equal(git(f.root, 'status', '--porcelain'), '');
  for (const call of calls) {
    assert.ok(call.args.includes(bundle.destination)); assert.ok(!call.args.includes('origin'));
    assert.ok(!call.args.some(a => a.includes('--force') || a.includes('refs/heads/main')));
    assert.equal(call.cwd, root); assert.equal(call.env.GIT_CONFIG_GLOBAL, '/dev/null');
    assert.equal(call.env.GIT_CONFIG_SYSTEM, '/dev/null'); assert.equal(call.env.HOME, root);
    assert.equal(call.env.GH_TOKEN, undefined); assert.equal(call.env.GIT_SSH_COMMAND, undefined);
    assert.ok(call.args.includes('core.hooksPath=/dev/null')); assert.ok(call.args.includes('credential.helper='));
  }
  assert.equal(f.outcomes.find((_, i) => f.actions[i]?.kind === 'push')?.status, 'unknown');
  assert.equal(f.outcomes.at(-1)?.status, 'succeeded');
});
test('denied authorization cannot create files and direct adapter call cannot bypass review', async t => {
  const f = fixture(t), calls = network(t), bundle = prepareVideoDelivery(f.input);
  assert.equal((await publishVideoRepository(bundle, f.options)).status, 'local-only-blocked');
  const result = await deliverReviewedVideo(bundle, { ...f.options, authorize: async () => { throw new Error('denied'); } });
  assert.equal(result.status, 'local-only-blocked'); assert.deepEqual(readdirSync(f.options.evidenceParent), []); assert.equal(calls.length, 0);
});
test('expired or dropped grants finish failed and suppress the protected action', async t => {
  for (const target of ['create-isolated-repository', 'write-export', 'push'] as const) {
    const f = fixture(t), calls = network(t), authorize = f.options.authorize;
    const result = await deliverReviewedVideo(prepareVideoDelivery(f.input), { ...f.options, authorize: async action => {
      const grant = await authorize(action);
      if (action.kind === target) grant.check = () => { throw new Error('grant revoked or lease expired'); };
      return grant;
    } });
    assert.equal(result.status, 'local-only-blocked'); assert.equal(f.outcomes.at(-1)?.status, 'failed');
    assert.ok(!calls.some(c => c.args.includes('push')));
    if (target === 'create-isolated-repository') assert.deepEqual(readdirSync(f.options.evidenceParent), []);
    if (target === 'write-export') assert.equal(existsSync(join(f.actions[0]!.cwd, 'before.mp4')), false);
    t.mock.restoreAll();
  }
});
test('authorization callback origin redirect is caught before the next mutation', async t => {
  const f = fixture(t), calls = network(t), authorize = f.options.authorize;
  const result = await deliverReviewedVideo(prepareVideoDelivery(f.input), { ...f.options, authorize: async action => {
    const grant = await authorize(action); git(f.root, 'remote', 'set-url', 'origin', 'https://github.com/attacker/other.git'); return grant;
  } });
  assert.equal(result.status, 'local-only-blocked'); assert.equal(calls.length, 0); assert.equal(f.outcomes.at(-1)?.status, 'failed');
  assert.deepEqual(readdirSync(f.options.evidenceParent), []);
});
test('isolated repo config tampering and changed export bytes cannot reach publication', async t => {
  for (const target of ['config', 'export'] as const) {
    const f = fixture(t), calls = network(t), authorize = f.options.authorize;
    const result = await deliverReviewedVideo(prepareVideoDelivery(f.input), { ...f.options, authorize: async action => {
      const grant = await authorize(action);
      if (target === 'config' && action.kind === 'write-export') writeFileSync(join(action.cwd, '.git', 'config'), '[url "https://evil.example/"]\n insteadOf = https://github.com/\n');
      if (target === 'export' && action.kind === 'git-add') writeFileSync(join(action.cwd, 'before.mp4'), 'tampered');
      return grant;
    } });
    assert.equal(result.status, 'local-only-blocked'); assert.equal(calls.length, 0); t.mock.restoreAll();
  }
});
test('uncertain push or absent confirmation never reports delivered and never retries the bundle', async t => {
  for (const mode of ['throw-push', 'missing-confirmation'] as const) {
    const f = fixture(t), calls = network(t, mode), bundle = prepareVideoDelivery(f.input);
    const result = await deliverReviewedVideo(bundle, f.options);
    assert.equal(result.status, 'delivery-unknown'); assert.equal(calls.filter(c => c.args.includes('push')).length, 1);
    assert.equal((await deliverReviewedVideo(bundle, f.options)).status, 'local-only-blocked');
    const fresh = prepareVideoDelivery(f.input);
    await deliverReviewedVideo(fresh, f.options);
    assert.equal(calls.filter(c => c.args.includes('push')).length, 1); t.mock.restoreAll();
  }
});
test('existing different remote commit is never overwritten and default branch name rejected', async t => {
  const f = fixture(t), calls = network(t, 'wrong-existing');
  assert.equal((await deliverReviewedVideo(prepareVideoDelivery(f.input), f.options)).status, 'local-only-blocked');
  assert.equal(calls.length, 1);
  const branch = prepareVideoDelivery(f.input).branch;
  git(f.root, 'symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${branch}`);
  assert.throws(() => prepareVideoDelivery(f.input), /default branch/);
});
test('requires explicit author and separate private repository parent', async t => {
  const f = fixture(t), calls = network(t);
  for (const patch of [{ author: { name: '', email: 'fixture@example.invalid' } }, { author: { name: 'Injected\nAuthor', email: 'fixture@example.invalid' } },
    { author: { name: 'Fixture', email: 'malformed' } }, { evidenceParent: f.root }]) {
    assert.equal((await deliverReviewedVideo(prepareVideoDelivery(f.input), { ...f.options, ...patch })).status, 'local-only-blocked');
  }
  assert.equal(calls.length, 0); assert.equal(f.actions.length, 0);
});
test('pinned explicit gh helper is the only credential source; modified helper blocks', async t => {
  const f = fixture(t), calls = network(t), helper = join(f.base, 'gh');
  writeFileSync(helper, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const options = { ...f.options, credentialHelper: { ghPath: helper, sha256: hash(readFileSync(helper, 'utf8')), configDirectory: f.base } };
  const result = await deliverReviewedVideo(prepareVideoDelivery(f.input), options);
  assert.equal(result.status, 'delivered'); assert.ok(calls.every(c => c.args.includes(`credential.https://github.com.helper=${helper} auth git-credential`)));
  assert.ok(calls.every(c => c.env.GH_CONFIG_DIR === f.base));
  assert.ok(calls.every(c => c.env.HOME === c.cwd && c.env.XDG_CONFIG_HOME === c.cwd));
  const authorize = options.authorize;
  assert.equal((await deliverReviewedVideo(prepareVideoDelivery(f.input), { ...options, authorize: async action => {
    const grant = await authorize(action); writeFileSync(helper, '#!/bin/sh\nexit 2\n'); return grant;
  } })).status, 'local-only-blocked');
  assert.equal(calls.filter(c => c.args.includes('push')).length, 1);
});
test('explicit owner home enables helper lookup while user and ambient Git config stay disabled', async t => {
  const f = fixture(t), calls = network(t), helper = join(f.base, 'gh');
  writeFileSync(helper, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  writeFileSync(join(f.base, '.gitconfig'), 'invalid Git configuration that must never be loaded');
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = join(f.base, '.gitconfig');
  try {
    const result = await deliverReviewedVideo(prepareVideoDelivery(f.input), { ...f.options,
      credentialHelper: { ghPath: helper, sha256: hash(readFileSync(helper, 'utf8')), configDirectory: f.base, homeDirectory: f.base } });
    assert.equal(result.status, 'delivered'); assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.equal(call.env.HOME, f.base); assert.equal(call.env.GH_CONFIG_DIR, f.base);
      assert.equal(call.env.GIT_CONFIG_GLOBAL, '/dev/null'); assert.equal(call.env.GIT_CONFIG_SYSTEM, '/dev/null');
      assert.equal(call.env.GIT_CONFIG_NOSYSTEM, '1'); assert.equal(call.env.GIT_CONFIG_COUNT, undefined);
      for (const key of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) assert.equal(call.env[key], call.cwd);
    }
    for (const action of f.actions.filter(a => a.executable === 'git')) assert.equal(action.environment!.HOME, f.base);
  } finally { if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous; }
});
test('unsafe, noncanonical and source credential homes fail before any authorization or network dispatch', async t => {
  const f = fixture(t), calls = network(t), helper = join(f.base, 'gh'), home = join(f.base, 'home');
  writeFileSync(helper, '#!/bin/sh\nexit 1\n', { mode: 0o700 }); mkdirSync(home, { mode: 0o700 });
  const alias = join(f.base, 'home-alias'), parentAlias = join(f.base, 'parent-alias');
  symlinkSync(home, alias); symlinkSync(f.base, parentAlias); mkdirSync(join(f.root, 'nested'));
  const options = { ...f.options, credentialHelper: { ghPath: helper, sha256: hash(readFileSync(helper, 'utf8')), configDirectory: f.base } };
  for (const homeDirectory of ['relative', home + '/../home', alias, join(parentAlias, 'home'), f.root,
    join(f.root, 'nested'), join(f.root, 'code.txt'), join(f.base, 'missing')]) {
    assert.equal((await deliverReviewedVideo(prepareVideoDelivery(f.input), { ...options,
      credentialHelper: { ...options.credentialHelper, homeDirectory } })).status, 'local-only-blocked');
  }
  for (const mode of [0o720, 0o702]) {
    chmodSync(home, mode);
    assert.equal((await deliverReviewedVideo(prepareVideoDelivery(f.input), { ...options,
      credentialHelper: { ...options.credentialHelper, homeDirectory: home } })).status, 'local-only-blocked');
  }
  chmodSync(home, 0o700);
  if (process.getuid) { t.mock.method(process as { getuid: () => number }, 'getuid', () => -1);
    assert.throws(() => validateVideoHelperHome(home, f.root), /Owner/); t.mock.restoreAll(); }
  assert.equal(f.actions.length, 0); assert.equal(calls.length, 0); assert.deepEqual(readdirSync(f.options.evidenceParent), []);
});
test('credential home replacement after authorization suppresses the protected action', async t => {
  const f = fixture(t), calls = network(t), helper = join(f.base, 'gh'), home = join(f.base, 'home'), authorize = f.options.authorize;
  writeFileSync(helper, '#!/bin/sh\nexit 1\n', { mode: 0o700 }); mkdirSync(home, { mode: 0o700 });
  const result = await deliverReviewedVideo(prepareVideoDelivery(f.input), { ...f.options,
    credentialHelper: { ghPath: helper, sha256: hash(readFileSync(helper, 'utf8')), configDirectory: f.base, homeDirectory: home },
    authorize: async action => { const grant = await authorize(action);
      renameSync(home, home + '-old'); mkdirSync(home, { mode: 0o700 }); return grant;
    } });
  assert.equal(result.status, 'local-only-blocked'); assert.equal(calls.length, 0);
  assert.equal(f.actions.length, 1); assert.equal(f.outcomes[0]!.status, 'failed');
  assert.deepEqual(readdirSync(f.options.evidenceParent), []);
});
test('post-push finish failure or revoked confirmation produces unknown completion', async t => {
  for (const mode of ['finish', 'confirmation'] as const) {
    const f = fixture(t), calls = network(t), authorize = f.options.authorize; let checks = 0;
    const result = await deliverReviewedVideo(prepareVideoDelivery(f.input), { ...f.options, authorize: async action => {
      const grant = await authorize(action);
      if (mode === 'finish' && action.kind === 'push') grant.finish = () => { throw new Error('receipt persistence unavailable'); };
      if (mode === 'confirmation' && action.kind === 'remote-check' && ++checks === 2) grant.check = () => { throw new Error('dropped'); };
      return grant;
    } });
    assert.equal(result.status, 'delivery-unknown'); assert.equal(calls.filter(c => c.args.includes('push')).length, 1); t.mock.restoreAll();
  }
});
test('nested source input cannot allow evidence storage elsewhere inside the code checkout', async t => {
  const f = fixture(t), calls = network(t); mkdirSync(join(f.root, 'nested'));
  const result = await deliverReviewedVideo(prepareVideoDelivery({ ...f.input, projectRoot: join(f.root, 'nested') }),
    { ...f.options, evidenceParent: f.root });
  assert.equal(result.status, 'local-only-blocked'); assert.equal(calls.length, 0); assert.equal(f.actions.length, 0);
});
test('git init refuses a callback-planted repository before executing Git', async t => {
  const f = fixture(t), calls = network(t), authorize = f.options.authorize;
  const result = await deliverReviewedVideo(prepareVideoDelivery(f.input), { ...f.options, authorize: async action => {
    const grant = await authorize(action);
    if (action.kind === 'git-init') writeFileSync(join(action.cwd, '.git'), `gitdir: ${join(f.root, '.git')}\n`);
    return grant;
  } });
  assert.equal(result.status, 'local-only-blocked'); assert.equal(calls.length, 0);
  assert.equal(git(f.root, 'branch', '--show-current'), 'main');
});
test('ambient Git redirection, config injection, proxy and token variables cannot enter publication', async t => {
  const f = fixture(t), calls = network(t);
  const poison: Record<string, string> = { GIT_DIR: '/not-the-repo', GIT_WORK_TREE: '/not-the-worktree',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.proxy', GIT_CONFIG_VALUE_0: 'http://evil.invalid',
    GH_TOKEN: 'fixture-not-a-real-token', HTTPS_PROXY: 'http://evil.invalid', GIT_SSH_COMMAND: 'false' };
  const previous = Object.fromEntries(Object.keys(poison).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, poison);
    assert.equal((await deliverReviewedVideo(prepareVideoDelivery(f.input), f.options)).status, 'delivered');
    for (const call of calls) for (const key of Object.keys(poison)) assert.equal(call.env[key], undefined);
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

for (const reason of ['expired', 'revoked', 'fenced'] as const) {
  test(`push grant ${reason} during commit validation is checked again before dispatch`, async t => {
    const f = fixture(t), authorize = f.options.authorize;
    let armed = false, invalidated = false, now = 0, revoked = false, epoch = 1;
    const events: string[] = [];
    const calls = network(t, 'success', command => {
      if (armed && !invalidated && command.args.includes('cat-file') && command.args.at(-1)?.endsWith(':evidence.json')) {
        invalidated = true; now = 2; revoked = true; epoch = 2; events.push('validation-invalidated-grant');
      }
    });
    const result = await deliverReviewedVideo(prepareVideoDelivery(f.input), { ...f.options, authorize: async action => {
      const grant = await authorize(action);
      if (action.kind === 'push') {
        armed = true;
        grant.check = async () => {
          events.push('push-grant-check');
          if (reason === 'expired' ? now >= 1 : reason === 'revoked' ? revoked : epoch !== 1) throw new Error(reason);
        };
      }
      return grant;
    } });
    assert.equal(invalidated, true, 'must invalidate during the final commit/blob inspection');
    assert.equal(calls.filter(c => c.args.includes('push')).length, 0, 'no push may use the stale grant');
    assert.equal(result.status, 'local-only-blocked');
    assert.equal(f.actions.at(-1)?.kind, 'push'); assert.equal(f.outcomes.at(-1)?.status, 'failed');
    assert.equal(f.actions.length, f.outcomes.length, 'every issued grant finishes exactly once');
    assert.ok(events.lastIndexOf('push-grant-check') > events.indexOf('validation-invalidated-grant'));
  });
}
test('remote discovery grant revoked during commit validation blocks ls-remote and finishes failed', async t => {
  const f = fixture(t), authorize = f.options.authorize;
  let armed = false, revoked = false;
  const calls = network(t, 'success', command => {
    if (armed && command.args.includes('cat-file') && command.args.at(-1)?.endsWith(':evidence.json')) revoked = true;
  });
  const result = await deliverReviewedVideo(prepareVideoDelivery(f.input), { ...f.options, authorize: async action => {
    const grant = await authorize(action);
    if (action.kind === 'remote-check') { armed = true; grant.check = () => { if (revoked) throw new Error('revoked'); }; }
    return grant;
  } });
  assert.equal(revoked, true); assert.equal(calls.length, 0); assert.equal(result.status, 'local-only-blocked');
  assert.equal(f.outcomes.at(-1)?.status, 'failed'); assert.equal(f.actions.length, f.outcomes.length);
});

test('push grant invalidated by launcher pinning has zero dispatch and one failed receipt', async t => {
  const fs = await import('node:fs');
  const { syncBuiltinESMExports } = await import('node:module');
  const f = fixture(t), authorize = f.options.authorize;
  let armed = false, inspected = false, runtimeReads = 0, invalid = false;
  const calls = network(t, 'success', command => {
    if (armed && command.args.includes('cat-file') && command.args.at(-1)?.endsWith(':evidence.json')) inspected = true;
  });
  const originalRead = fs.default.readFileSync;
  t.mock.method(fs.default, 'readFileSync', (...args: Parameters<typeof originalRead>) => {
    const result = Reflect.apply(originalRead, fs.default, args);
    if (inspected && String(args[0]) === realpathSync(process.execPath) && ++runtimeReads === 2) invalid = true;
    return result;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = await deliverReviewedVideo(prepareVideoDelivery(f.input), { ...f.options, authorize: async action => {
    const grant = await authorize(action);
    if (action.kind === 'push') {
      armed = true;
      grant.check = async () => { await Promise.resolve(); if (invalid) throw new Error('fencing changed during pinning'); };
    }
    return grant;
  } });
  assert.equal(invalid, true, 'the launcher must pin its runtime after commit inspection');
  assert.equal(calls.filter(c => c.args.includes('push')).length, 0);
  assert.equal(result.status, 'local-only-blocked');
  assert.equal(f.actions.at(-1)?.kind, 'push'); assert.equal(f.outcomes.at(-1)?.status, 'failed');
  assert.equal(f.actions.length, f.outcomes.length);
});
