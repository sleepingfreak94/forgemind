import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWindowsHost } from '../../src/host-enforcement/windows-host.js';
import { supervised } from '../../src/live-workflow/process.js';
import { openCursorSubscriptionSession, openCursorTunnel, pinCursorCli } from '../../src/live-workflow/cursor-session.js';

// Needs `npm run windows:setup -- <folder> --cursor <cursor-agent version folder>` and FORGEMIND_WINDOWS_CURSOR_PROFILE,
// an owner-only Cursor profile outside the user folder that the owner signed in to. The request test also needs
// FORGEMIND_WINDOWS_CURSOR_REQUEST=1: it makes one real provider request on the owner's plan.
const hostFolder = process.env.FORGEMIND_WINDOWS_HOST, profile = process.env.FORGEMIND_WINDOWS_CURSOR_PROFILE;
const windows = { skip: process.platform !== 'win32' || !hostFolder || !profile, timeout: 300000 };

async function open(t: test.TestContext) {
  const host = await loadWindowsHost(hostFolder!);
  assert.ok(host.cursorDirectory && host.cursorShim, 'setup was run with --cursor');
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'fm-win-cursor-'))); t.after(() => rmSync(base, { recursive: true, force: true }));
  const cli = pinCursorCli(host.cursorDirectory);
  const session = await openCursorSubscriptionSession({ profileDirectory: profile!, cli, scratchRoot: base, workspace: base,
    personalWorkspaces: [base], separateFrom: [base] });
  t.after(() => session.close());
  return { cli, session, base };
}

test('the contained Cursor CLI reports the owner sign-in and plan through the allow-list proxy', windows, async t => {
  const { session } = await open(t);
  assert.match(session.tier, /^[A-Za-z+ ]{1,30}$/);
});

test('a contained Cursor print-mode request answers through the proxy', { ...windows, skip: windows.skip || process.env.FORGEMIND_WINDOWS_CURSOR_REQUEST !== '1' }, async t => {
  const { cli, session, base } = await open(t);
  const scratch = mkdtempSync(join(base, 'call-')), refused: string[] = [];
  const tunnel = await openCursorTunnel(true, () => {}, target => refused.push(target));
  try {
    const request = session.launch(cli, scratch, ['-p', '--mode', 'ask', '--trust', '--model', 'auto', '--output-format', 'text'],
      'Reply with exactly the word ready.', { timeoutMs: 240000, maxOutputBytes: 1 << 20 }, AbortSignal.timeout(240000), () => {}, undefined, tunnel!.port);
    const result = await supervised(request);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /ready/i);
    t.diagnostic(`refused: ${JSON.stringify(refused)}`);
  } finally { await tunnel?.stop(); }
});
