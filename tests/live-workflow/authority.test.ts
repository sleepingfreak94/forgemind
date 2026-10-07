import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunAuthority } from '../../src/live-workflow/authority.js';
import type { LiveTask } from '../../src/live-workflow/contracts.js';

test('durable authority fences stale sources, caps requests, prevents receipt reuse and refuses run replay', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fm-authority-'))),
    workspace = join(root, 'repo'),
    state = join(root, 'state');
  mkdirSync(workspace);
  const task: LiveTask = {
    schemaVersion: 1,
    taskId: 'fixture',
    objective: 'Fixture',
    readPaths: ['a'],
    writePaths: ['a'],
    checks: [],
    model: 'fixture',
    effort: 'low',
    maxModelRequests: 1,
    maxPromptBytes: 100,
    maxOutputBytes: 100,
    maxRuntimeMs: 10000,
    draftPr: false,
  };
  const source = 'a'.repeat(64),
    authority = new RunAuthority(state, workspace, 'fixture', task, source);
  try {
    assert.throws(() => authority.reserve({ kind: 'git', source: 'b'.repeat(64), detail: {} }), /stale/);
    assert.throws(() => authority.reserveRequest(101), /limit/);
    assert.equal(authority.reserveRequest(100), 1);
    assert.throws(() => authority.reserveRequest(1), /exhausted/);
    const receipt = authority.reserve({ kind: 'command', source, detail: { fixture: true } });
    receipt.check();
    receipt.finish('completed');
    assert.throws(() => receipt.check(), /Finished/);
    assert.throws(() => receipt.finish('completed'), /Duplicate/);
    authority.finish('completed');
    assert.throws(() => authority.reserve({ kind: 'git', source, detail: {} }), /Inactive/);
    assert.throws(() => authority.reserveRequest(1));
    authority.close();
    assert.throws(() => new RunAuthority(state, workspace, 'fixture', task, source), /never replay/);
  } finally {
    authority.close();
    rmSync(root, { recursive: true, force: true });
  }
});
