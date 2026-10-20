import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { LocalOrganizationSharing } from '../memory/organization-sharing.js';
import { safeOrganizationJSON } from '../memory/organization-registry-contracts.js';

const usage = 'Trusted local owner registry (offline; principal IDs are asserted labels).\n' +
  'node dist/src/local-runtime/organization-cli.js <bootstrap|member|config|inspect|approve|share|read|revoke|status|promote>\n' +
  'Always: --workspace /canonical/project --state-dir /private/external/org-state ' +
  '--memory-state-dir /private/external/project-memory --org local-org --principal owner-label --project project-id\n' +
  'member: --member label --role editor|reader --status active|suspended|revoked\n' +
  'config: --enabled true|false --grants-file /private/grants.json (array of {principalId,read,share})\n' +
  'inspect: --record-id SHA256\napprove: --record-id SHA256 --record-digest SHA256 --binding SHA256\n' +
  'share: --approval-id SHA256\nread/revoke: --share-id SHA256\n' +
  'Explicit immutable bootstrap. Owner configures membership, grants and exact-record approvals.\n' +
  'No remote authentication or governance promotion. Private local owner data only.\n';
function grantsFile(path: string): unknown {
  if (!isAbsolute(path) || realpathSync(path) !== path) throw new Error('invalid grants path');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16000 || typeof process.getuid !== 'function' ||
      stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('invalid grants file');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > 16000 || !opened.isFile()) throw new Error('grants file changed');
    const bytes = readFileSync(fd), after = fstatSync(fd);
    if (bytes.length > 16000 || opened.size !== after.size || opened.ctimeMs !== after.ctimeMs || opened.mtimeMs !== after.mtimeMs) throw new Error('grants file changed');
    return safeOrganizationJSON(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } finally { closeSync(fd); }
}
async function main(): Promise<void> {
  const [mode, ...raw] = process.argv.slice(2);
  if (mode === '--help') { process.stdout.write(usage); return; }
  const extras: Record<string, string[]> = {
    bootstrap: [], member: ['member', 'role', 'status'], config: ['enabled', 'grants-file'], inspect: ['record-id'],
    approve: ['record-id', 'record-digest', 'binding'], share: ['approval-id'], read: ['share-id'], revoke: ['share-id'], status: [], promote: []
  };
  if (!mode || !Object.hasOwn(extras, mode)) throw new Error('invalid command');
  const common = ['workspace', 'state-dir', 'memory-state-dir', 'org', 'principal', 'project'];
  const args: Record<string, string> = Object.create(null) as Record<string, string>;
  for (let i = 0; i < raw.length; i += 2) {
    const key = raw[i]!.slice(2), value = raw[i + 1];
    if (raw[i] !== '--' + key || ![...common, ...extras[mode]!].includes(key) || Object.hasOwn(args, key) || !value || value.startsWith('--')) throw new Error('invalid arguments');
    args[key] = value;
  }
  if ([...common, ...extras[mode]!].some(key => !args[key])) throw new Error('missing arguments');
  for (const key of ['workspace', 'state-dir', 'memory-state-dir']) if (!isAbsolute(args[key]!)) throw new Error('absolute path required');
  const service = new LocalOrganizationSharing(args['state-dir']!, args.workspace!, args.org!, args['memory-state-dir']!);
  try {
    const input = { organizationId: args.org!, principalId: args.principal!, projectId: args.project! };
    let result;
    switch (mode) {
      case 'bootstrap': result = service.bootstrap(input); break;
      case 'member': result = service.setMember({ ...input, memberId: args.member!, role: args.role!, status: args.status! }); break;
      case 'config':
        if (!['true', 'false'].includes(args.enabled!)) throw new Error('invalid boolean');
        result = service.configure({ ...input, enabled: args.enabled === 'true', grants: grantsFile(args['grants-file']!) }); break;
      case 'inspect': result = service.inspectRecord({ ...input, recordId: args['record-id']! }); break;
      case 'approve': result = service.approve({ ...input, recordId: args['record-id']!, recordDigest: args['record-digest']!, recordBinding: args.binding! }); break;
      case 'share': result = await service.share({ ...input, approvalId: args['approval-id']! }); break;
      case 'read': result = await service.read({ ...input, shareId: args['share-id']! }); break;
      case 'revoke': result = service.revoke({ ...input, shareId: args['share-id']! }); break;
      case 'status': result = service.status(input); break;
      case 'promote': result = service.promote(input); break;
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (result?.receipt.decision !== 'allowed') process.exitCode = 2;
  } finally { service.close(); }
}
main().catch(() => {
  process.stderr.write('Organization command failed: check explicit arguments, owner configuration, current source and private canonical state. Use --help.\n');
  process.exitCode = 2;
});
