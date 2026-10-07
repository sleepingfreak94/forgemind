import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { ProjectMemory } from '../memory/service.js';
import { defaultMemoryDirectory } from '../memory/location.js';
import type { MemoryInput } from '../memory/contracts.js';

const usage = `Local-owner project memory (no model/provider calls):
  npm run memory -- ingest --workspace /path/to/project
  npm run memory -- list --workspace /path/to/project
  npm run memory -- inspect --workspace /path/to/project --id <record-id>
  npm run memory -- validate --workspace /path/to/project --id <record-id> --digest <reviewed-digest>
  npm run memory -- search --workspace /path/to/project --query "storage decision"
  npm run memory -- add --workspace /path/to/project --file /path/to/candidate.json
  npm run memory -- delete --workspace /path/to/project --id <record-id> --digest <reviewed-digest>
  npm run memory -- rebuild --workspace /path/to/project
  npm run memory -- audit --workspace /path/to/project
Optional: --state-dir /private/path/outside/project (default ~/.forgemind/memory).
Ingestion creates candidates. Inspect then explicitly validate each exact digest for reuse.
Validation qualifies evidence; source Draft/Proposed status is always retained.
This owner command is not an agent authorization endpoint.\n`;
function main(): void {
  const [mode, ...raw] = process.argv.slice(2);
  if (mode === '--help' || raw.includes('--help')) { process.stdout.write(usage); return; }
  const extras: Record<string, string[]> = { ingest: [], list: [], inspect: ['id'], validate: ['id', 'digest'], search: ['query'], add: ['file'], delete: ['id', 'digest'], rebuild: [], audit: [] };
  if (!mode || !Object.hasOwn(extras, mode)) throw new Error('unknown memory command');
  const args: Record<string, string> = {};
  for (let i = 0; i < raw.length; i += 2) {
    const key = raw[i]!.slice(2), value = raw[i + 1];
    if (raw[i] !== `--${key}` || !['workspace', 'state-dir', ...extras[mode]!].includes(key) || key in args || !value || value.startsWith('--')) throw new Error('invalid memory arguments');
    args[key] = value;
  }
  for (const key of ['workspace', ...extras[mode]!]) if (!args[key]) throw new Error(`missing --${key}`);
  let input: MemoryInput | undefined;
  if (mode === 'add') {
    const file = realpathSync(resolve(args.file!)), stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 1048576) throw new Error('invalid candidate file');
    input = JSON.parse(readFileSync(file, 'utf8')) as MemoryInput;
  }
  const memory = new ProjectMemory(resolve(args['state-dir'] ?? defaultMemoryDirectory()), realpathSync(resolve(args.workspace!)));
  try {
    let result: unknown;
    switch (mode) {
      case 'ingest': result = memory.ingest(); break;
      case 'list': result = memory.list(); break;
      case 'inspect': result = memory.inspect(args.id!); if (!result) throw new Error('record unavailable'); break;
      case 'validate': memory.validate(args.id!, args.digest!); result = { validated: args.id }; break;
      case 'search': result = memory.packet(args.query!); break;
      case 'add': result = { candidateId: memory.add(input!) }; break;
      case 'delete': memory.remove(args.id!, args.digest!); result = { deleted: args.id }; break;
      case 'rebuild': memory.rebuildIndex(); result = { rebuilt: true }; break;
      case 'audit': result = memory.audit(); break;
    }
    process.stdout.write(JSON.stringify({ projectId: memory.projectId, result }, null, 2) + '\n');
  } finally { memory.close(); }
}
try { main(); } catch {
  process.stderr.write('Memory command failed: check arguments, registered project, current source/digest and private state directory. Use --help.\n'); process.exitCode = 2;
}
