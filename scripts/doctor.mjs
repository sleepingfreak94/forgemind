import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Read-only setup diagnostic: never resolves agent commands, credentials or account files.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const flags = process.argv.slice(2);
if (flags.some(flag => !['--json', '--require-host'].includes(flag)) || new Set(flags).size !== flags.length) {
  process.stderr.write('Usage: node scripts/doctor.mjs [--json] [--require-host]\n'); process.exitCode = 2;
} else {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const minimum = pkg.engines.node.match(/^>=(\d+)\.(\d+)\.(\d+)$/);
  if (!minimum) throw new Error('Unsupported repository Node requirement');
  const required = minimum.slice(1).map(Number), actual = process.versions.node.split('.').map(Number);
  const nodeSupported = actual[0] > required[0] || actual[0] === required[0] &&
    (actual[1] > required[1] || actual[1] === required[1] && actual[2] >= required[2]);
  const dependenciesInstalled = ['typescript', '@types/node'].every(name => existsSync(join(root, 'node_modules', name, 'package.json')));
  let sqliteAvailable = false;
  if (nodeSupported) { try { const sqlite = await import('node:sqlite'); sqliteAvailable = typeof sqlite.DatabaseSync === 'function'; } catch { /* report unavailable */ } }
  const posixIdentity = process.platform !== 'win32' && typeof process.getuid === 'function';
  const hostPrerequisitesPresent = process.platform === 'darwin' && posixIdentity && existsSync('/usr/bin/sandbox-exec');
  const report = { platform: process.platform, architecture: process.arch, nodeVersion: process.versions.node,
    requiredNode: pkg.engines.node, nodeSupported, dependenciesInstalled, sqliteAvailable,
    portableSetupReady: nodeSupported && dependenciesInstalled && sqliteAvailable,
    localPolicyIdentityAvailable: posixIdentity, hostBackend: process.platform === 'darwin' ? 'macos-seatbelt' : 'unimplemented',
    hostPrerequisitesPresent, hostVerified: false, liveCodingEnabled: false,
    liveBlockReason: 'Subscription-only spending cannot currently be enforced for ChatGPT login',
    nextCommand: nodeSupported && dependenciesInstalled ? 'npm run verify:portable' : 'Install the required Node version, then run npm ci.',
    limitations: process.platform === 'win32' ? ['Windows ACL/SID policy and enforced sandbox backend are not implemented.', 'Portable fixture checks do not certify native Cursor/Codex or live coding.'] :
      ['Host prerequisites are diagnostic only; run the native suite to verify enforcement.', 'Live provider, spend and write gates remain closed.'] };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exitCode = !report.portableSetupReady || flags.includes('--require-host') && !hostPrerequisitesPresent ? 2 : 0;
}
