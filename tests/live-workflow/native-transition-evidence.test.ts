import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeOwner } from '../../src/live-workflow/native-executor-owner.js';
import { NativeProject } from '../../src/live-workflow/native-executor-project.js';
import { applyEdits } from '../../src/live-workflow/edits.js';
import { sourceIdentity } from '../../src/live-workflow/repository.js';
import { sha256 } from '../../src/live-workflow/validation.js';
import { qualifyNative } from '../../src/live-workflow/qualification-native.js';
import { createQualificationReport, qualificationHash, verifyQualificationReport } from '../../src/live-workflow/qualification.js';
import { transitionBinding } from '../../src/live-workflow/native-transition-evidence.js';
import type { NativeTask } from '../../src/live-workflow/native-executor-contracts.js';
import type { ActionEnvelope } from '../../src/live-workflow/contracts.js';

function fixture() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'fm-transition-')), root = join(dir, 'repo');
  mkdirSync(root); execFileSync('/usr/bin/git', ['init', '-q', root]);
  writeFileSync(join(root, 'value.txt'), 'before');
  const task: NativeTask = { project: 'project', task: 'task', root, source: sourceIdentity(root), model: 'gpt-6.1-sol', effort: 'medium',
    readPaths: ['value.txt'], writePaths: ['value.txt'], checks: [{ id: 'strict', executable: realpathSync(process.execPath), args: [], timeoutMs: 1000 }],
    budget: { runtimeMs: 60000, turns: null, toolCalls: null, retries: 0, inputBytes: 100000, resultBytes: 100000, wireBytes: 100000, outputBytes: 10000 } };
  let owner = new NativeOwner(join(dir, 'owner'), task, Date.now() + 60000, () => {});
  const project = () => new NativeProject(root, owner, (...args) => owner.phase(...args), () => owner.active());
  const edit = (from = 'before', to = 'after') => {
    const p = project(), before = owner.source;
    p.assertCurrent(before);
    return p.commitAppliedSource(before, applyEdits(root, before, task.writePaths, { summary: 'fixture edit',
      edits: [{ path: 'value.txt', beforeSha256: sha256(from), content: to }] }, owner, () => p.assertCurrent(before)));
  };
  return { task, dir, edit, get owner() { return owner; },
    restart: () => { owner.close(); owner = new NativeOwner(join(dir, 'owner'), { ...task, source: owner.source }, Date.now() + 60000, () => {}); },
    close: () => { owner.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function input(f: ReturnType<typeof fixture>) {
  return { schema: 'qualification-input-v1', taskId: f.task.task, projectId: f.task.project, source: f.owner.source,
    fixture: true, requiredChecks: ['strict'], nativeTask: f.task, parentBinding: sha256('parent'),
    result: { taskId: f.task.task, status: 'completed', source: f.owner.source, checks: [], owner: f.owner.export() } };
}
function report(raw: ReturnType<typeof input>) {
  return createQualificationReport({ mode: 'native', input: raw, expectedSource: raw.source, createdAt: 1000, expiresAt: 2000, now: 1000,
    build: { schema: 'qualification-build-v1', source: raw.source, artifacts: [{ id: 'fixture', path: '/fixture/build.js', sha256: sha256('fixture') }] } });
}
function rejected(raw: unknown) { assert.throws(() => qualifyNative(raw), /Invalid historical qualification evidence/); }
function transition(f: ReturnType<typeof fixture>): ActionEnvelope {
  return { kind: 'artifact', source: f.owner.source, detail: { operation: 'native.source-transition', transitionReceiptId: randomUUID(),
    before: f.owner.source, source: sha256('next'), edits: [{ path: 'value.txt', before: sha256('before'), after: sha256('after') }] } };
}
function phase(f: ReturnType<typeof fixture>, envelope: ActionEnvelope) {
  const d = envelope.detail as { transitionReceiptId: string; before: string; source: string };
  f.owner.phase('native.source-transition', d.source, { transitionReceiptId: d.transitionReceiptId, before: d.before, source: d.source });
}

test('guarded NativeProject edits export real receipt associations across restart and source advance; legacy stays partial', () => {
  const f = fixture();
  try {
    const baseline = report(input(f));
    assert.equal(baseline.execution.sourceBound, true);
    f.edit(); const first = f.owner.export();
    f.restart(); assert.deepEqual(f.owner.export().transitionEvidence, first.transitionEvidence);
    f.edit('after', 'third'); f.restart();
    const raw = input(f), exported = raw.result.owner;
    assert.equal(exported.transitionEvidence?.bindings.length, 2);
    assert.ok(exported.transitionEvidence?.bindings.every(b => b.decisionId !== b.transitionReceiptId && b.terminalId !== b.transitionReceiptId));
    const qualified = report(raw);
    assert.equal(qualified.execution.sourceBound, true);
    assert.equal(qualified.outcome, 'partial'); // Missing checks/review/cleanup remain gates.
    assert.equal(qualified.authority, 'none');
    assert.equal(verifyQualificationReport(qualified, raw.source, 1000).authority, 'none');
    const { transitionEvidence: omitted, ...legacy } = exported;
    const old = report({ ...raw, result: { ...raw.result, owner: legacy } });
    assert.equal(old.execution.sourceBound, false); assert.equal(old.executionConsistent, false);
    assert.equal(old.outcome, 'partial');
  } finally { f.close(); }
});

test('phase JSON cannot advance an owner without the exact completed producer action', () => {
  for (const status of ['missing', 'pending', 'failed', 'indeterminate', 'wrong-output', 'recovered'] as const) {
    const f = fixture();
    try {
      const envelope = transition(f), before = f.owner.source;
      if (status !== 'missing') {
        const action = f.owner.reserve(envelope);
        if (status === 'failed' || status === 'indeterminate') action.finish(status, sha256('next'));
        if (status === 'wrong-output') action.finish('completed', sha256('substituted'));
        if (status === 'recovered') f.restart();
      }
      assert.throws(() => phase(f, envelope), /completed producer action/);
      assert.equal(f.owner.source, before); assert.equal(f.owner.export().phases.length, 0);
    } finally { f.close(); }
  }
});

test('completed reservation survives restart before phase; envelope snapshot cannot be replaced by phase claims', () => {
  const f = fixture();
  try {
    const envelope = transition(f), original = structuredClone(envelope), action = f.owner.reserve(envelope);
    (envelope.detail as Record<string, unknown>).source = sha256('substituted');
    action.finish('completed', sha256('next')); f.restart();
    assert.throws(() => phase(f, envelope), /Invalid historical/);
    assert.equal(f.owner.export().phases.length, 0);
    phase(f, original);
    assert.equal(f.owner.source, sha256('next'));
    assert.deepEqual(f.owner.export().transitionEvidence?.bindings[0]?.envelope, original);
    assert.equal(qualifyNative(input(f)).execution.sourceBound, true);
  } finally { f.close(); }
});

test('transition views reject extra fields, duplicate UUIDs, invalid digests and edits outside the exact grant', () => {
  const f = fixture();
  try {
    const envelope = transition(f), detail = envelope.detail as Record<string, unknown>;
    const bad = [ { ...detail, extra: true }, { ...detail, transitionReceiptId: 'not-a-uuid' }, { ...detail, source: '0'.repeat(64) },
      { ...detail, edits: [] }, { ...detail, edits: [{ path: '../escape', before: null, after: sha256('after') }] },
      { ...detail, edits: [{ path: 'other.txt', before: null, after: sha256('after') }] },
      { ...detail, edits: [ ...(detail.edits as unknown[]), ...(detail.edits as unknown[]) ] } ];
    for (const d of bad) assert.throws(() => f.owner.reserve({ ...envelope, detail: d }), /Invalid historical/);
    const action = f.owner.reserve(envelope);
    assert.throws(() => f.owner.reserve(envelope), /Duplicate native transition/);
    assert.throws(() => f.owner.reserve(transition(f)), /requires reconciliation/);
    let calls = 0;
    const arbitrary = Object.defineProperty({}, 'before', { enumerable: true, get() { calls++; return f.owner.source; } });
    assert.throws(() => f.owner.phase('native.source-transition', sha256('next'), arbitrary), /Invalid historical/);
    assert.equal(calls, 0);
    action.finish('failed');
    assert.equal(f.owner.export().phases.length, 0);
  } finally { f.close(); }
});

test('qualifier rejects substituted bindings and rehashed outer evidence, even when pair fields match each other', () => {
  const f = fixture();
  try {
    f.edit(); f.edit('after', 'third');
    const raw = input(f), first = raw.result.owner.transitionEvidence!.bindings[0]!;
    const mutate = (change: (value: any) => void) => {
      const clone = structuredClone(raw); change(clone);
      // Simulate an attacker repairing every additive binding digest and the outer input hash.
      clone.result.owner.transitionEvidence!.bindings = clone.result.owner.transitionEvidence!.bindings.map(b => {
        const { digest: _old, ...body } = b; return transitionBinding(body);
      });
      qualificationHash(clone); rejected(clone);
      assert.throws(() => report(clone), /Invalid historical/);
    };
    const bindingChanges = [
      (b: any) => { b.taskBinding = sha256('another-task'); },
      (b: any) => { b.transitionReceiptId = randomUUID(); },
      (b: any) => { b.envelope.source = sha256('another-source'); },
      (b: any) => { b.envelope.detail.before = sha256('another-source'); },
      (b: any) => { b.envelope.detail.source = sha256('another-source'); },
      (b: any) => { b.envelope.detail.transitionReceiptId = randomUUID(); },
      (b: any) => { b.envelope.detail.edits[0].after = sha256('other-content'); },
      (b: any) => { b.envelope.detail.extra = true; },
      (b: any) => { b.decisionId = b.terminalId; },
      (b: any) => { b.terminalId = randomUUID(); },
    ];
    for (const change of bindingChanges) mutate(c => change(c.result.owner.transitionEvidence.bindings[0]));
    for (const key of ['taskId', 'sourceSnapshot', 'requestId', 'requestDigest', 'grantId', 'invocationId', 'principalId', 'sessionId', 'policyVersion', 'resource', 'action', 'outcome']) {
      mutate(c => {
        const value = ['requestDigest', 'sourceSnapshot'].includes(key) ? sha256('substitution') : key === 'action' ? 'file.read' : key === 'outcome' ? 'failed' : randomUUID();
        for (const r of c.result.owner.receipts) if ([first.decisionId, first.terminalId].includes(r.id)) r[key] = value;
      });
    }
    for (const field of ['viewDigest', 'outputDigest']) mutate(c => {
      c.result.owner.receipts.find((r: any) => r.id === first.terminalId).terminalEvidence[field] = sha256('other');
    });
    mutate(c => { c.result.owner.receipts.find((r: any) => r.id === first.terminalId).timestamp = 0; });
    mutate(c => { c.result.owner.receipts = c.result.owner.receipts.filter((r: any) => r.id !== first.terminalId); });
    mutate(c => { const d = c.result.owner.receipts.find((r: any) => r.id === first.decisionId); c.result.owner.receipts.push({ ...d, id: randomUUID() }); });
    mutate(c => { const t = c.result.owner.receipts.find((r: any) => r.id === first.terminalId); c.result.owner.receipts.push({ ...t, id: randomUUID(), event: 'external.recovered', outcome: 'indeterminate' }); });
    mutate(c => { c.result.owner.transitionEvidence.bindings.reverse(); });
    mutate(c => { c.result.owner.transitionEvidence.bindings.push(c.result.owner.transitionEvidence.bindings[0]); });
    mutate(c => { c.result.owner.transitionEvidence.bindings.pop(); });
    mutate(c => { c.result.owner.transitionEvidence.schema = 'trusted'; });
    mutate(c => { c.result.owner.phases.reverse(); });
    mutate(c => { c.result.owner.phases[0].data = JSON.stringify({ ...JSON.parse(c.result.owner.phases[0].data), source: sha256('other') }); });
    for (const pin of ['decisionDigest', 'terminalDigest']) mutate(c => { c.result.owner.transitionEvidence.bindings[0][pin] = sha256('wrong-pin'); });
    const invalidDigest = structuredClone(raw); invalidDigest.result.owner.transitionEvidence!.bindings[0]!.digest = sha256('wrong'); rejected(invalidDigest);
    const oversized = structuredClone(raw); (oversized.result.owner.transitionEvidence!.bindings[0]!.envelope.detail as any).edits = Array(513).fill({ path: 'value.txt', before: null, after: sha256('x') }); rejected(oversized);
    // Existing read-only archives remain source-bound with no new evidence field.
    const unchanged = fixture();
    try { const u = input(unchanged); delete u.result.owner.transitionEvidence; assert.equal(qualifyNative(u).execution.sourceBound, true); }
    finally { unchanged.close(); }
  } finally { f.close(); }
});


test('verified no-op applications survive owner restart without source phases and preserve later real transitions', () => {
  const f = fixture();
  try {
    const initial = f.owner.source;
    assert.deepEqual(f.edit('before', 'before'), { source: initial, transitionReceiptId: null });
    assert.equal(f.owner.export().phases.length, 0);
    assert.equal(qualifyNative(input(f)).execution.sourceBound, true);
    f.edit(); f.restart();
    const changed = f.owner.source, prior = f.owner.export();
    for (let i = 0; i < 2; i++) {
      assert.deepEqual(f.edit('after', 'after'), { source: changed, transitionReceiptId: null });
      assert.deepEqual(f.owner.export().phases, prior.phases);
      assert.deepEqual(f.owner.export().transitionEvidence, prior.transitionEvidence);
    }
    assert.equal(qualifyNative(input(f)).execution.sourceBound, true);
    f.edit('after', 'third');
    assert.equal(f.owner.export().phases.length, 2);
    assert.equal(qualifyNative(input(f)).execution.sourceBound, true);
  } finally { f.close(); }
});

test('completed source cycles permit later edits while an unphased producer still blocks reconciliation', () => {
  const f = fixture();
  try {
    const initial = f.owner.source;
    f.edit(); f.edit('after', 'before'); f.restart();
    assert.equal(f.owner.source, initial);
    f.edit('before', 'third');
    assert.equal(f.owner.export().phases.length, 3);
    assert.equal(qualifyNative(input(f)).execution.sourceBound, true);
    const pending = transition(f), action = f.owner.reserve(pending);
    action.finish('completed', sha256('next'));
    assert.throws(() => f.owner.reserve(transition(f)), /Native transition requires reconciliation/);
  } finally { f.close(); }
});
