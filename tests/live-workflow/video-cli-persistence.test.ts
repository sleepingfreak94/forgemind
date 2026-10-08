import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { serialize } from '../../src/context-engine/validation.js';
import { RunAuthority } from '../../src/live-workflow/authority.js';
import type { ActionEnvelope } from '../../src/live-workflow/contracts.js';
import type { ExternalAttempt } from '../../src/policy/contracts.js';
import type { VideoDeliveryAction, VideoActionOutcome } from '../../src/live-workflow/video-repository.js';
import { repositoryProcess } from '../../src/live-workflow/repository-process.js';
import { sourceIdentity } from '../../src/live-workflow/repository.js';
import { runVideoCli } from '../../src/local-runtime/video-cli.js';

const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const json = (path: string) => JSON.parse(fs.readFileSync(path, 'utf8'));
const self = fileURLToPath(import.meta.url);
type Mode = 'success' | 'missing' | 'wrong' | 'marker-failure' | 'terminal-failure' | 'result-failure' | 'export-failure' | 'restart' | 'interrupt';
type Row = { name: string; source: string; data: string };
type Reservation = { receiptId: string; approvalSha256: string; action: VideoDeliveryAction };
interface Ledger {
  run: { status: string; requests: number }; phases: Row[];
}
function ledger(state: string): Ledger {
  const db = new DatabaseSync(join(state, 'authority', 'run.sqlite'), { readOnly: true });
  try { return { run: db.prepare('SELECT status,requests FROM run').get() as unknown as Ledger['run'],
    phases: db.prepare('SELECT name,source,data FROM phases ORDER BY seq').all() as unknown as Row[] }; } finally { db.close(); }
}
function attempts(state: string): ExternalAttempt[] {
  const db = new DatabaseSync(join(state, 'authority', 'policy', 'policy.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT body FROM external_attempts').all().map(row => JSON.parse(row.body as string) as ExternalAttempt); }
  finally { db.close(); }
}
function git(root: string, ...args: string[]): string {
  return repositoryProcess('git', ['-c', 'core.hooksPath=/dev/null', ...args], root,
    { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }).toString().trim();
}
function fixture(t: TestContext) {
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'video-cli-persistence-'))), root = join(base, 'source');
  t.after(() => fs.rmSync(base, { recursive: true, force: true })); fs.mkdirSync(root);
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'Test Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(join(root, 'code.txt'), 'baseline'); git(root, 'add', 'code.txt'); git(root, 'commit', '-m', 'fixture');
  git(root, 'remote', 'add', 'origin', 'https://github.com/fixture/project.git');
  const source = sourceIdentity(root);
  for (const phase of ['before', 'after']) {
    const bytes = Buffer.from(`${phase} synthetic unit-test bytes, not actual visual evidence`), artifactPath = join(base, `${phase}.mp4`);
    fs.writeFileSync(artifactPath, bytes);
    const body = { version: 1, taskId: 'ticket', scenarioId: 'scenario', phase, label: phase === 'before' ? 'Before' : 'After',
      baselineIdentity: 'a'.repeat(40), sourceIdentity: phase === 'before' ? 'a'.repeat(40) : source,
      captureTarget: 'synthetic fixture', provenance: 'host-recording', delivery: 'local-only', artifactPath,
      artifactSha256: hash(bytes), artifactBytes: bytes.length, video: { durationSeconds: 1, width: 320, height: 240, frames: 15 },
      startedAt: '2026-10-08T00:00:00Z', completedAt: '2026-10-08T00:00:01Z', authorizations:
        [{ action: 'record', receiptId: 'fixture-record', envelopeSha256: hash('record') }, { action: 'probe', receiptId: 'fixture-probe', envelopeSha256: hash('probe') }] };
    fs.writeFileSync(join(base, `${phase}.json`), JSON.stringify({ ...body, manifestSha256: hash(JSON.stringify(body)) }));
  }
  fs.writeFileSync(join(base, 'review.json'), JSON.stringify({ verdict: 'pass', source, findings: [], acceptance: ['fixture'] }));
  fs.mkdirSync(join(base, 'evidence'), { mode: 0o700 });
  const argv = ['deliver', '--workspace', root, '--before', join(base, 'before.json'), '--after', join(base, 'after.json'),
    '--code-review', join(base, 'review.json'), '--state-root', join(base, 'state'), '--evidence-parent', join(base, 'evidence'),
    '--author-name', 'Test Fixture', '--author-email', 'fixture@example.invalid'];
  fs.writeFileSync(join(base, 'argv.json'), JSON.stringify(argv));
  return { base, root, source };
}
interface DispatchSnapshot { marker: Reservation; approval: Record<string, unknown>; ledger: Ledger; attempts: ExternalAttempt[] }
interface Report {
  code: number; prompts: number; outputs: Record<string, unknown>[]; network: string[][];
  dispatches: DispatchSnapshot[]; injected: number;
}
/** Each scenario starts a fresh OS process. Only the trusted terminal is synthetic;
 * argument parsing, RunAuthority, SQLite, fsync, Git object creation and finalization
 * are the actual CLI. Network Git commands are intercepted before any launch. */
async function child(mode: Mode, base: string): Promise<void> {
  const realExec = childProcess.execFileSync, realOpen = fs.openSync;
  const realReserve = RunAuthority.prototype.reserve, realExport = RunAuthority.prototype.export;
  const report: Report = { code: 2, prompts: 0, outputs: [], network: [], dispatches: [], injected: 0 };
  const state = () => join(base, 'state', fs.readdirSync(join(base, 'state'))[0]!);
  let pushed: string | undefined;
  const emit = () => process.stdout.write(`VIDEO_CLI_TEST_REPORT=${JSON.stringify(report)}\n`);
  childProcess.execFileSync = ((executable: string, args: string[], options: Parameters<typeof realExec>[2]) => {
    if (args[0]?.endsWith('/repository-supervisor.js')) {
      const command = JSON.parse(Buffer.from(args[1]!, 'base64url').toString()) as { executable: string; args: string[] };
      if (command.executable === 'gh') throw new Error('No gh execution in fixture');
      if (command.args.includes('push') || command.args.includes('ls-remote')) {
        report.network.push(command.args);
        if (mode === 'restart') throw new Error('Restart may not publish');
        if (command.args.includes('push')) {
          report.dispatches.push({ marker: json(join(state(), 'push-attempt.json')), approval: json(join(state(), 'approval.json')),
            ledger: ledger(state()), attempts: attempts(state()) });
          if (mode === 'interrupt') { report.code = 75; emit(); process.exit(75); }
          pushed = command.args.at(-1)!.split(':')[0]; return Buffer.from('');
        }
        const oid = !pushed || mode === 'missing' ? undefined : mode === 'wrong' ? '0'.repeat(40) : pushed;
        return Buffer.from(oid ? `${oid}\t${command.args.at(-1)!}\n` : '');
      }
    }
    return realExec(executable, args, options);
  }) as typeof childProcess.execFileSync;
  fs.openSync = ((path: fs.PathLike, flags: string | number, permissions?: fs.Mode) => {
    if ((mode === 'marker-failure' && String(path).endsWith('/push-attempt.json')) ||
        (mode === 'result-failure' && pushed && String(path).endsWith('/delivery-result.json'))) {
      report.injected++; throw new Error('fixture durable write failure');
    }
    return realOpen(path, flags, permissions);
  }) as typeof fs.openSync;
  syncBuiltinESMExports();
  RunAuthority.prototype.reserve = function(envelope: ActionEnvelope) {
    const reservation = realReserve.call(this, envelope);
    const detail = envelope.detail as { action?: VideoDeliveryAction };
    if (mode !== 'terminal-failure' || detail.action?.kind !== 'push') return reservation;
    return { check: () => reservation.check(), finish: () => { report.injected++; throw new Error('fixture terminal persistence failure'); } };
  };
  RunAuthority.prototype.export = function() {
    if (mode === 'export-failure' && pushed) { report.injected++; throw new Error('fixture export failure'); }
    return realExport.call(this);
  };
  report.code = await runVideoCli(json(join(base, 'argv.json')) as string[], { isTTY: true,
    write: text => { report.outputs.push(JSON.parse(text) as Record<string, unknown>); },
    approve: async prompt => { report.prompts++; if (mode === 'restart') throw new Error('Restart may not prompt');
      return /Type exactly (approve [a-f0-9]{64}):/.exec(prompt)![1]!; } });
  emit(); process.exitCode = report.code;
}
function invoke(f: ReturnType<typeof fixture>, mode: Mode): Promise<Report> {
  return new Promise((resolveRun, reject) => {
    childProcess.execFile(process.execPath, [self, '--persistence-child', mode, f.base],
      { timeout: 180000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
        try {
          const raw = stdout.split('\n').find(line => line.startsWith('VIDEO_CLI_TEST_REPORT='));
          assert.ok(raw, `child must report, stderr=${stderr}, error=${String(error)}`);
          const report = JSON.parse(raw.slice('VIDEO_CLI_TEST_REPORT='.length)) as Report;
          assert.equal(error ? Number(error.code) : 0, report.code, 'actual process exit matches CLI outcome'); resolveRun(report);
        } catch (failure) { reject(failure); }
      });
  });
}
function location(f: ReturnType<typeof fixture>) { return join(f.base, 'state', fs.readdirSync(join(f.base, 'state'))[0]!); }
function bindingAudit(state: string, report: Report): void {
  const approval = json(join(state, 'approval.json')), stored = ledger(state);
  assert.equal(state.split('/').at(-1), approval.binding.pairSha256);
  assert.equal(approval.codeReview.sha256, hash(fs.readFileSync(join(state, 'code-review.json'))));
  const approved = JSON.parse(stored.phases.find(p => p.name === 'video-approved')!.data);
  assert.equal(approved.approvalSha256, hash(JSON.stringify(approval))); assert.deepEqual(approved.binding, approval.binding);
  const reservations = stored.phases.filter(p => p.name === 'video-action-reserved').map(p => JSON.parse(p.data) as Reservation);
  assert.equal(new Set(reservations.map(r => r.receiptId)).size, reservations.length);
  const external = attempts(state);
  for (const reserved of reservations) {
    assert.match(reserved.receiptId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.deepEqual(reserved.action.binding, approval.binding);
    assert.equal(reserved.approvalSha256, hash(JSON.stringify(approval)));
    const { actionSha256, ...body } = reserved.action; assert.equal(actionSha256, hash(JSON.stringify(body)));
    const envelope = { kind: reserved.action.executable === 'git' ? 'git' : 'artifact', source: approval.binding.sourceIdentity,
      detail: { receiptId: reserved.receiptId, approvalSha256: reserved.approvalSha256, action: reserved.action } };
    const row = external.find(item => JSON.parse(item.envelopeJson!).detail.receiptId === reserved.receiptId)!;
    assert.ok(row, 'each CLI UUID resolves to a durable policy reservation'); assert.equal(row.envelopeJson, serialize(envelope));
    assert.equal(row.intent.resource, `host:${hash(serialize(envelope))}`); assert.equal(row.intent.sourceSnapshot, approval.binding.sourceIdentity);
    const finished = stored.phases.filter(p => p.name === 'video-action-finished').map(p => JSON.parse(p.data) as { receiptId: string; outcome: VideoActionOutcome })
      .find(p => p.receiptId === reserved.receiptId);
    if (finished) {
      assert.equal(row.terminalEvidence?.viewDigest, hash(serialize(envelope)));
      assert.equal(row.terminalEvidence?.outputDigest, hash(JSON.stringify(finished.outcome)));
    }
  }
  for (const atDispatch of report.dispatches) {
    const reserved = reservations.find(r => r.receiptId === atDispatch.marker.receiptId)!;
    assert.deepEqual(atDispatch.marker, reserved); assert.deepEqual(atDispatch.approval, approval);
    assert.ok(atDispatch.ledger.phases.some(p => p.name === 'video-action-reserved' && JSON.parse(p.data).receiptId === reserved.receiptId));
    const attempt = atDispatch.attempts.find(row => JSON.parse(row.envelopeJson!).detail.receiptId === reserved.receiptId)!;
    assert.equal(attempt.status, 'reserved', 'reservation must already be durable when push would dispatch');
    assert.deepEqual(atDispatch.marker.action.args, report.network.find(args => args.includes('push')));
  }
  assert.equal(stored.run.requests, 0);
}
function snapshot(state: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string) => { for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, item.name); if (item.isDirectory()) walk(path); else files[path] = hash(fs.readFileSync(path));
  } }; walk(state); return files;
}
if (process.argv[2] === '--persistence-child') {
  await child(process.argv[3] as Mode, process.argv[4]!);
} else {
  test('CLI confirmed publication persists exact commit links and UUID/action/approval receipt bindings', async t => {
    const f = fixture(t), report = await invoke(f, 'success'), state = location(f), result = json(join(state, 'delivery-result.json'));
    assert.equal(report.code, 0); assert.equal(report.prompts, 1); assert.equal(report.network.filter(c => c.includes('push')).length, 1);
    assert.equal(report.network.filter(c => c.includes('ls-remote')).length, 2); assert.equal(result.status, 'delivered');
    const { stateDirectory, providerRequests, liveCodingEnabled, ...output } = report.outputs.at(-1)!;
    assert.deepEqual(output, result); assert.equal(stateDirectory, state); assert.equal(providerRequests, 0); assert.equal(liveCodingEnabled, false);
    const pushed = report.network.find(c => c.includes('push'))!.at(-1)!.split(':')[0]; assert.equal(result.commit, pushed);
    for (const [key, filename] of [['beforeUrl', 'before.mp4'], ['afterUrl', 'after.mp4'], ['indexUrl', 'evidence.json']]) {
      assert.equal(result[key!], `https://github.com/fixture/project/blob/${pushed}/${filename}`);
    }
    const exported = json(join(state, 'authority-receipt.json'));
    assert.deepEqual(exported.run.status, 'completed'); assert.deepEqual(exported.phases, ledger(state).phases.map((row, seq) => ({ seq: seq + 1, ...row })));
    assert.deepEqual(result.receipts, ledger(state).phases.filter(p => p.name === 'video-action-reserved').map(p => JSON.parse(p.data).receiptId));
    bindingAudit(state, report); assert.equal(sourceIdentity(f.root), f.source);
  });
  for (const mode of ['missing', 'wrong'] as const) test(`CLI ${mode} remote confirmation persists unknown and fresh process refuses replay`, async t => {
    const f = fixture(t), report = await invoke(f, mode), state = location(f);
    assert.equal(report.code, 2); assert.equal(report.outputs.at(-1)!.status, 'delivery-unknown');
    assert.equal(report.network.filter(c => c.includes('push')).length, 1);
    assert.equal(json(join(state, 'delivery-result.json')).status, 'delivery-unknown'); assert.equal(ledger(state).run.status, 'failed');
    bindingAudit(state, report);
    const before = snapshot(state), restarted = await invoke(f, 'restart');
    assert.equal(restarted.code, 2); assert.equal(restarted.prompts, 0); assert.deepEqual(restarted.network, []);
    assert.match(String(restarted.outputs.at(-1)!.reason), /already exists/); assert.deepEqual(snapshot(state), before);
  });
  test('CLI push marker write failure leaves a failed durable reservation and dispatches zero pushes', async t => {
    const f = fixture(t), report = await invoke(f, 'marker-failure'), state = location(f);
    assert.equal(report.injected, 1); assert.equal(report.code, 2); assert.equal(report.network.filter(c => c.includes('push')).length, 0);
    assert.equal(json(join(state, 'delivery-result.json')).status, 'local-only-blocked'); assert.equal(fs.existsSync(join(state, 'push-attempt.json')), false);
    const push = attempts(state).find(row => JSON.parse(row.envelopeJson!).detail.action.kind === 'push')!;
    assert.equal(push.status, 'failed'); bindingAudit(state, report);
  });
  for (const mode of ['terminal-failure', 'result-failure', 'export-failure'] as const) {
    test(`CLI post-push ${mode} preserves uncertainty, exact backend result and durable restart fence`, async t => {
      const f = fixture(t), report = await invoke(f, mode), state = location(f);
      assert.ok(report.injected > 0); assert.equal(report.code, 2); assert.equal(report.outputs.at(-1)!.status, 'delivery-unknown');
      assert.equal(report.network.filter(c => c.includes('push')).length, 1); assert.equal(ledger(state).run.status, 'failed');
      const recovery = json(join(state, 'persistence-failure.json'));
      assert.equal(recovery.status, 'delivery-unknown'); assert.equal(recovery.resultSha256, hash(JSON.stringify(recovery.backendResult)));
      assert.equal(recovery.approvalSha256, hash(JSON.stringify(json(join(state, 'approval.json')))));
      if (mode !== 'result-failure') assert.deepEqual(json(join(state, 'delivery-result.json')), recovery.backendResult);
      if (mode !== 'export-failure') assert.equal(json(join(state, 'authority-receipt.json')).run.status, 'failed');
      bindingAudit(state, report);
      const before = snapshot(state), restarted = await invoke(f, 'restart');
      assert.equal(restarted.prompts, 0); assert.deepEqual(restarted.network, []); assert.equal(restarted.code, 2);
      assert.match(String(restarted.outputs.at(-1)!.reason), /already exists/); assert.deepEqual(snapshot(state), before);
    });
  }
  test('fresh CLI process refuses an interrupted pair with a durable pending push, before prompting or network', async t => {
    const f = fixture(t), interrupted = await invoke(f, 'interrupt'), state = location(f);
    assert.equal(interrupted.code, 75); assert.equal(fs.existsSync(join(state, 'delivery-result.json')), false);
    const push = attempts(state).find(row => JSON.parse(row.envelopeJson!).detail.action.kind === 'push')!; assert.equal(push.status, 'reserved');
    bindingAudit(state, interrupted);
    const before = snapshot(state), restarted = await invoke(f, 'restart');
    assert.equal(restarted.code, 2); assert.equal(restarted.prompts, 0); assert.deepEqual(restarted.network, []);
    assert.match(String(restarted.outputs.at(-1)!.reason), /already exists/); assert.deepEqual(snapshot(state), before);
  });
}
