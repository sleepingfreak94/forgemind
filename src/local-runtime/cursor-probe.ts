import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pinCursorCli, openCursorSubscriptionSession, REVIEWED_CURSOR_CLI } from '../live-workflow/cursor-session.js';
import { cursorPersonalWorkspaces } from './cursor-route-config.js';

// Pin check plus sandboxed `status` and `about`. Never starts inference; never reads the login.
const [directory, profileDirectory, workspace] = process.argv.slice(2);
if (!directory || !profileDirectory || !workspace) throw new Error('usage: probe:cursor /canonical/cursor-agent/versions/<build> /private/cursor-profile /canonical/workspace');
const scratchRoot = realpathSync(mkdtempSync(join(tmpdir(), 'forgemind-cursor-probe-')));
try {
  const cli = pinCursorCli(directory);
  const session = await openCursorSubscriptionSession({ profileDirectory, cli, scratchRoot, workspace: realpathSync(workspace),
    personalWorkspaces: cursorPersonalWorkspaces() });
  console.log(JSON.stringify({ scenario: 'pinned Cursor CLI sign-in status inside the Cursor Seatbelt profile', status: 'completed',
    cliVersion: cli.version, manifestSha256: cli.manifestSha256, reviewedManifestSha256: REVIEWED_CURSOR_CLI.manifestSha256, signedIn: true,
    planTier: session.tier, companySeat: session.company, workspaceAllowed: true, credentialRead: false, inferenceRequests: 0 }, null, 2));
  session.close();
} finally { rmSync(scratchRoot, { recursive: true, force: true }); }
