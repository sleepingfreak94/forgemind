import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { repositoryProcess } from '../../src/live-workflow/repository-process.js';
import { sourceIdentity } from '../../src/live-workflow/repository.js';
import { prepareVideoDelivery } from '../../src/live-workflow/video-delivery.js';
import type { EvidenceManifest } from '../../src/live-workflow/evidence.js';
import { parseVideoCliArguments, runVideoCli, videoReceiptStatus } from '../../src/local-runtime/video-cli.js';
import type { VideoCliTerminal } from '../../src/local-runtime/video-cli.js';

const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const realExec = childProcess.execFileSync;
function git(root: string, ...args: string[]): string {
  return repositoryProcess('git', ['-c', 'core.hooksPath=/dev/null', ...args], root,
    { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }).toString().trim();
}
function networkGuard(t: TestContext, failInitUnder?: string) {
  let network = 0;
  t.mock.method(childProcess, 'execFileSync', (executable: string, args: string[], options: Parameters<typeof realExec>[2]) => {
    if (args[0]?.endsWith('/repository-supervisor.js')) {
      const command = JSON.parse(Buffer.from(args[1]!, 'base64url').toString()) as { executable: string; args: string[]; cwd: string };
      if (command.executable === 'gh' || command.args.includes('push') || command.args.includes('ls-remote')) {
        network++; throw new Error('Unexpected network command forbidden by CLI tests');
      }
      if (failInitUnder && command.cwd.startsWith(failInitUnder + '/') && command.args.includes('init')) throw new Error('fixture local init failure');
    }
    return realExec(executable, args, options);
  });
  t.after(() => assert.equal(network, 0, 'CLI tests must never attempt network publication'));
}
function terminal(isTTY = true, reply?: (prompt: string) => string | Promise<string>) {
  const output: string[] = [], prompts: string[] = [];
  const io: VideoCliTerminal = { isTTY, write: text => { output.push(text); }, approve: async prompt => {
    prompts.push(prompt); return reply ? reply(prompt) : 'decline';
  } };
  return { io, output, prompts, last: () => JSON.parse(output.at(-1)!) as Record<string, unknown> };
}
function fixture(t: TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'video-cli-test-'))), root = join(base, 'source');
  t.after(() => rmSync(base, { recursive: true, force: true })); mkdirSync(root);
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'Test Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(root, 'code.txt'), 'baseline'); git(root, 'add', 'code.txt'); git(root, 'commit', '-m', 'fixture');
  git(root, 'remote', 'add', 'origin', 'https://github.com/fixture/project.git');
  const candidate = sourceIdentity(root);
  const make = (phase: 'before' | 'after'): EvidenceManifest => {
    const bytes = Buffer.from(`${phase} synthetic fixture, never real video evidence`), artifactPath = join(base, `${phase}.mp4`);
    writeFileSync(artifactPath, bytes);
    const body = { version: 1 as const, taskId: 'ticket', scenarioId: 'private-scenario-content', phase,
      label: phase === 'before' ? 'Before' as const : 'After' as const, baselineIdentity: 'a'.repeat(40),
      sourceIdentity: phase === 'before' ? 'a'.repeat(40) : candidate, captureTarget: 'private-capture-content',
      provenance: 'host-recording' as const, delivery: 'local-only' as const, artifactPath, artifactSha256: hash(bytes), artifactBytes: bytes.length,
      video: { durationSeconds: 1, width: 320, height: 240, frames: 15 }, startedAt: '2026-10-08T00:00:00Z', completedAt: '2026-10-08T00:00:01Z',
      authorizations: [{ action: 'record' as const, receiptId: 'private-receipt-content', envelopeSha256: hash('record') },
        { action: 'probe' as const, receiptId: 'private-probe-content', envelopeSha256: hash('probe') }] };
    return { ...body, manifestSha256: hash(JSON.stringify(body)) };
  };
  const before = make('before'), after = make('after'), beforePath = join(base, 'before.json'), afterPath = join(base, 'after.json');
  writeFileSync(beforePath, JSON.stringify(before)); writeFileSync(afterPath, JSON.stringify(after));
  const reviewPath = join(base, 'review.json'); writeFileSync(reviewPath, JSON.stringify({ verdict: 'pass', source: candidate, findings: [], secretFixture: 'private-review-content' }));
  const state = join(base, 'state'), evidence = join(base, 'evidence'); mkdirSync(evidence, { mode: 0o700 });
  const common = ['--workspace', root, '--before', beforePath, '--after', afterPath];
  const deliver = ['deliver', ...common, '--code-review', reviewPath, '--state-root', state, '--evidence-parent', evidence,
    '--author-name', 'Test Fixture', '--author-email', 'fixture@example.invalid'];
  return { base, root, before, after, beforePath, afterPath, reviewPath, candidate, state, evidence, common, deliver };
}
test('strict argument grammar rejects skip-approval, live flags, unknown/duplicate flags and incomplete helper options', () => {
  const common = ['--workspace', '/repo', '--before', '/before.json', '--after', '/after.json'];
  assert.equal(parseVideoCliArguments(['evidence:prepare', ...common]).mode, 'prepare');
  assert.equal(parseVideoCliArguments(['deliver', '--help']).mode, 'help');
  for (const argv of [['run'], ['prepare', ...common, '--yes', 'true'], ['prepare', ...common, '--live', 'true'],
    ['prepare', ...common, '--workspace', '/other'], ['prepare', '--workspace', 'relative'], ['prepare', ...common, '--skip-approval'],
    ['deliver', ...common], ['prepare', ...common, '--gh', '/gh']]) assert.throws(() => parseVideoCliArguments(argv));
});
test('preview derives exact binding, displays local files, and does not expose manifest content or write', async t => {
  networkGuard(t); const f = fixture(t), term = terminal(false), beforeFiles = readdirSync(f.base), head = git(f.root, 'rev-parse', 'HEAD');
  const expected = prepareVideoDelivery({ projectRoot: f.root, before: f.before, after: f.after,
    expected: { taskId: f.before.taskId, scenarioId: f.before.scenarioId, baselineIdentity: f.before.baselineIdentity, sourceIdentity: f.after.sourceIdentity } });
  assert.equal(await runVideoCli(['evidence:prepare', ...f.common], term.io), 0);
  assert.equal(term.last().pairSha256, expected.pairSha256); assert.equal(term.last().destination, expected.destination);
  assert.ok(term.output.join('').includes(f.before.artifactPath)); assert.ok(term.output.join('').includes(f.afterPath));
  for (const secret of ['private-scenario-content', 'private-capture-content', 'private-receipt-content', 'private-probe-content']) assert.ok(!term.output.join('').includes(secret));
  assert.equal(term.last().providerRequests, 0); assert.equal(term.prompts.length, 0);
  assert.deepEqual(readdirSync(f.base), beforeFiles); assert.equal(git(f.root, 'rev-parse', 'HEAD'), head); assert.equal(sourceIdentity(f.root), f.candidate);
});
test('non-TTY delivery refuses before input reads, writes, prompts or any Git command', async t => {
  const f = fixture(t), term = terminal(false); let commands = 0;
  t.mock.method(childProcess, 'execFileSync', () => { commands++; throw new Error('No subprocess permitted'); });
  rmSync(f.beforePath);
  assert.equal(await runVideoCli(f.deliver, term.io), 2); assert.match(String(term.last().reason), /interactive owner TTY/);
  assert.equal(commands, 0); assert.equal(term.prompts.length, 0); assert.equal(existsSync(f.state), false); assert.deepEqual(readdirSync(f.evidence), []);
});
test('actual CLI process refuses piped approval; no environment or --yes bypass', t => {
  const f = fixture(t), cli = fileURLToPath(new URL('../../src/local-runtime/video-cli.js', import.meta.url));
  const result = childProcess.spawnSync(process.execPath, [cli, ...f.deliver], { input: 'approve anything\n', encoding: 'utf8',
    timeout: 10000, maxBuffer: 1024 * 1024, env: { ...process.env, FORGEMIND_APPROVE: 'yes', FORGEMIND_LIVE: '1' } });
  assert.equal(result.status, 2); assert.match(result.stdout, /interactive owner TTY/); assert.equal(existsSync(f.state), false);
});
test('review verdict and exact source are checked before the owner is prompted', async t => {
  networkGuard(t); const f = fixture(t);
  for (const review of [{ verdict: 'revise', source: f.candidate }, { verdict: 'pass', source: 'b'.repeat(64) }, { verdict: 'pass' }]) {
    writeFileSync(f.reviewPath, JSON.stringify(review)); const term = terminal();
    assert.equal(await runVideoCli(f.deliver, term.io), 2); assert.match(String(term.last().reason), /exact candidate source/);
    assert.equal(term.prompts.length, 0); assert.equal(existsSync(f.state), false);
  }
});
test('only the exact approval phrase is accepted; decline keeps state and evidence untouched', async t => {
  networkGuard(t); const f = fixture(t);
  for (const answer of ['yes', 'approve wrong', 'approve ' + 'a'.repeat(64), '']) {
    const term = terminal(true, () => answer);
    assert.equal(await runVideoCli(f.deliver, term.io), 2); assert.match(String(term.last().reason), /approval declined/);
    assert.match(term.prompts[0]!, /independent review/); assert.match(term.prompts[0]!, /watched the actual Before and After/);
    assert.match(term.prompts[0]!, /privacy for everyone with access/); assert.ok(!term.output.join('').includes('private-review-content'));
    assert.equal(existsSync(f.state), false); assert.deepEqual(readdirSync(f.evidence), []);
  }
});
test('review changed while awaiting approval is rejected before state creation', async t => {
  networkGuard(t); const f = fixture(t), term = terminal(true, prompt => {
    writeFileSync(f.reviewPath, JSON.stringify({ verdict: 'pass', source: f.candidate, modified: true }));
    return /Type exactly (approve [a-f0-9]{64}):/.exec(prompt)![1]!;
  });
  assert.equal(await runVideoCli(f.deliver, term.io), 2); assert.match(String(term.last().reason), /replaced or edited/);
  assert.equal(existsSync(f.state), false); assert.deepEqual(readdirSync(f.evidence), []);
});
test('unsafe input links, fixture-only evidence and secret-bearing malformed JSON never preview as prepared', async t => {
  networkGuard(t); const f = fixture(t), term = terminal(false);
  linkSync(f.beforePath, join(f.base, 'linked.json')); assert.equal(await runVideoCli(['prepare', ...f.common], term.io), 2);
  rmSync(join(f.base, 'linked.json')); renameToLink();
  assert.equal(await runVideoCli(['prepare', ...f.common], term.io), 2);
  rmSync(f.beforePath); writeFileSync(f.beforePath, '{"private-json-secret": invalid');
  assert.equal(await runVideoCli(['prepare', ...f.common], term.io), 2); assert.ok(!term.output.join('').includes('private-json-secret'));
  const { manifestSha256: _, ...body } = { ...f.before, provenance: 'fixture-only' as const };
  writeFileSync(f.beforePath, JSON.stringify({ ...body, manifestSha256: hash(JSON.stringify(body)) }));
  assert.equal(await runVideoCli(['prepare', ...f.common], term.io), 2);
  function renameToLink() { writeFileSync(join(f.base, 'copy.json'), readFileSync(f.beforePath)); rmSync(f.beforePath); symlinkSync(join(f.base, 'copy.json'), f.beforePath); }
});
test('state must be private and outside the actual repository; helper must be paired and explicit', async t => {
  networkGuard(t); const f = fixture(t);
  const change = (key: string, value: string) => { const args = [...f.deliver]; args[args.indexOf(key) + 1] = value; return args; };
  mkdirSync(f.state, { mode: 0o755 }); chmodSync(f.state, 0o755);
  const term = terminal(); assert.equal(await runVideoCli(f.deliver, term.io), 2); assert.equal(term.prompts.length, 0);
  assert.equal(await runVideoCli(change('--state-root', f.root), term.io), 2);
  assert.throws(() => parseVideoCliArguments([...f.deliver, '--gh', '/gh']));
  assert.throws(() => parseVideoCliArguments(change('--author-email', 'invalid')));
  assert.equal(await runVideoCli([...f.deliver, '--gh', join(f.base, 'missing-gh'), '--gh-config-dir', f.base], term.io), 2);
  assert.deepEqual(readdirSync(f.evidence), []);
});
test('approved local failure persists exact result and authority receipts; same pair can never replay', async t => {
  const f = fixture(t); networkGuard(t, f.evidence);
  const term = terminal(true, prompt => /Type exactly (approve [a-f0-9]{64}):/.exec(prompt)![1]!);
  assert.equal(await runVideoCli(f.deliver, term.io), 2);
  const state = String(term.last().stateDirectory); assert.ok(state.startsWith(f.state + '/'));
  const result = JSON.parse(readFileSync(join(state, 'delivery-result.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(result.status, 'local-only-blocked'); assert.equal(result.reason, term.last().reason);
  assert.deepEqual(result.receipts, term.last().receipts); assert.deepEqual(readFileSync(join(state, 'code-review.json')), readFileSync(f.reviewPath));
  const receipt = JSON.parse(readFileSync(join(state, 'authority-receipt.json'), 'utf8')) as {
    run: { status: string; requests: number }; phases: { name: string; data: string }[]; receipts: { outcome: string }[];
  };
  assert.equal(receipt.run.status, 'blocked'); assert.equal(receipt.run.requests, 0);
  const actions = receipt.phases.filter(p => p.name === 'video-action-reserved').map(p => JSON.parse(p.data));
  assert.deepEqual(actions.map(a => a.action.kind), ['create-isolated-repository', 'git-init']);
  assert.ok(receipt.receipts.some(r => r.outcome === 'failed'));
  for (const path of [state, join(state, 'code-review.json'), join(state, 'approval.json'), join(state, 'delivery-result.json'), join(state, 'authority-receipt.json')]) assert.equal(lstatSync(path).mode & 0o077, 0);
  const snapshot = readFileSync(join(state, 'authority-receipt.json'));
  const again = terminal(true, () => { throw new Error('Reused pair must not prompt'); });
  assert.equal(await runVideoCli(f.deliver, again.io), 2); assert.match(String(again.last().reason), /already exists/);
  assert.deepEqual(readFileSync(join(state, 'authority-receipt.json')), snapshot);
});
test('outcome mapping preserves uncertainty and never upgrades it to completed', () => {
  assert.equal(videoReceiptStatus('unknown'), 'indeterminate'); assert.equal(videoReceiptStatus('failed'), 'failed');
  assert.equal(videoReceiptStatus('succeeded'), 'completed');
});
