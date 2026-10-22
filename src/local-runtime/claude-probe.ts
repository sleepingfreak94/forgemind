import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pinClaudeCli, openClaudeSubscriptionSession, REVIEWED_CLAUDE_CLI } from '../live-workflow/claude-session.js';

// Pin check plus sandboxed `claude auth status`. Never starts inference; never reads the login.
const [binary, profileDirectory] = process.argv.slice(2);
if (!binary || !profileDirectory) throw new Error('usage: probe:claude /canonical/claude-binary /private/claude-profile');
const scratchRoot = realpathSync(mkdtempSync(join(tmpdir(), 'forgemind-claude-probe-')));
try {
  const cli = pinClaudeCli(binary);
  const session = await openClaudeSubscriptionSession({ profileDirectory, cli, scratchRoot });
  console.log(JSON.stringify({ scenario: 'pinned Claude Code sign-in status inside the Claude Seatbelt profile', status: 'completed',
    cliVersion: cli.version, executableSha256: cli.sha256, reviewedSha256: REVIEWED_CLAUDE_CLI.sha256, signedIn: true,
    subscriptionType: session.subscriptionType, credentialRead: false, inferenceRequests: 0 }, null, 2));
  session.close();
} finally { rmSync(scratchRoot, { recursive: true, force: true }); }
