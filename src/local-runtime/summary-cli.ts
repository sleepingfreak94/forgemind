import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OwnerRunRecorder, natural, sha, slug } from '../memory/run-recording.js';
import { WeeklyService } from '../memory/weekly-service.js';
import { WeeklySchedule } from '../memory/weekly-schedule.js';
import type { WeeklyOptions } from '../memory/weekly-summary.js';

export const summaryHelp = `Local owner weekly flow (no providers, accounts, delivery or OS jobs)
Run: node dist/src/local-runtime/summary-cli.js COMMAND [FLAGS]
Every command requires --workspace /canonical/registered/root --state-dir /external/private/state
  prepare --reservation ID --task ID --provenance fixture|authenticated
  record --reservation ID --manifest /private/artifacts/manifest.json --manifest-sha256 SHA256
  generate --due MS --lower SEQUENCE [--upper SEQUENCE] [--page-size 1..100]
           [--selection authenticated|all] [--max-bytes BYTES]
  config --enable true [--selection authenticated|all] [--max-bytes BYTES]
  status
  disable
  tick
  result [--due MS]
prepare durably reserves the run ID BEFORE supervised execution.
record imports exact digest-pinned orchestrator artifacts; native completion JSON is rejected.
config is explicit opt-in. tick is one-shot; result repairs interrupted output from committed state.
JSON labels/hashes are structural evidence, never provider authentication or new authority.
Use --help alone for this text.\n`;
type Command = 'prepare' | 'record' | 'generate' | 'config' | 'status' | 'disable' | 'tick' | 'result';
export type SummaryArguments = { readonly command: 'help' } | {
  readonly command: Command; readonly workspace: string; readonly stateDirectory: string; readonly values: Readonly<Record<string, string>>;
};
const flags: Readonly<Record<Command, readonly string[]>> = {
  prepare: ['reservation', 'task', 'provenance'], record: ['reservation', 'manifest', 'manifest-sha256'],
  generate: ['due', 'lower', 'upper', 'page-size', 'selection', 'max-bytes'],
  config: ['enable', 'selection', 'max-bytes'], status: [], disable: [], tick: [], result: ['due']
};
const required: Readonly<Record<Command, readonly string[]>> = {
  prepare: ['reservation', 'task', 'provenance'], record: ['reservation', 'manifest', 'manifest-sha256'],
  generate: ['due', 'lower'], config: ['enable'], status: [], disable: [], tick: [], result: []
};
function number(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('numeric flags require decimal safe integers');
  const n = Number(value); natural(n); return n;
}
export function parseSummaryArgs(args: readonly string[]): SummaryArguments {
  if (args.length === 1 && (args[0] === '--help' || args[0] === 'help')) return { command: 'help' };
  const name = args[0];
  if (!name || !Object.hasOwn(flags, name)) throw new Error('unknown weekly command; use --help');
  const command = name as Command, values: Record<string, string> = Object.create(null) as Record<string, string>;
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1], key = flag?.slice(2);
    if (!key || flag !== `--${key}` || !['workspace', 'state-dir', ...flags[command]].includes(key) ||
        Object.hasOwn(values, key) || !value || value.startsWith('--') || value.includes('\0')) throw new Error('invalid or duplicate weekly flag');
    values[key] = value;
  }
  for (const key of ['workspace', 'state-dir', ...required[command]]) if (!values[key]) throw new Error(`missing --${key}`);
  for (const key of ['workspace', 'state-dir', 'manifest']) {
    if (values[key] !== undefined && (!isAbsolute(values[key]) || resolve(values[key]) !== values[key])) throw new Error('canonical absolute paths required');
  }
  for (const key of ['reservation', 'task']) if (values[key] !== undefined) slug(values[key]);
  if (values['manifest-sha256'] !== undefined) sha(values['manifest-sha256']);
  if (values.provenance !== undefined && values.provenance !== 'fixture' && values.provenance !== 'authenticated') throw new Error('explicit owner provenance required');
  if (values.selection !== undefined && values.selection !== 'authenticated' && values.selection !== 'all') throw new Error('invalid execution selection');
  if (command === 'config' && values.enable !== 'true') throw new Error('config requires --enable true');
  for (const key of ['due', 'lower', 'upper', 'page-size', 'max-bytes']) if (values[key] !== undefined) number(values[key]);
  if (values['page-size'] !== undefined && (number(values['page-size']) < 1 || number(values['page-size']) > 100)) throw new Error('page size must be 1..100');
  if (values['max-bytes'] !== undefined && number(values['max-bytes']) > 65536) throw new Error('summary too large');
  if (values.upper !== undefined && number(values.upper) < number(values.lower!)) throw new Error('upper precedes lower');
  return { command, workspace: values.workspace!, stateDirectory: values['state-dir']!, values: Object.freeze(values) };
}
export interface SummaryIO { readonly stdout: (text: string) => void; readonly stderr: (text: string) => void }
export function summaryMain(args: readonly string[], io: SummaryIO = {
  stdout: text => { process.stdout.write(text); }, stderr: text => { process.stderr.write(text); }
}, clock: () => number = Date.now): number {
  try {
    const parsed = parseSummaryArgs(args);
    if (parsed.command === 'help') { io.stdout(summaryHelp); return 0; }
    const { command, workspace, stateDirectory, values: v } = parsed;
    const options: WeeklyOptions = { ...(v.selection === undefined ? {} : { executionSelection: v.selection as 'authenticated' | 'all' }),
      ...(v['max-bytes'] === undefined ? {} : { maxBytes: number(v['max-bytes']) }) };
    let result: unknown;
    if (command === 'prepare' || command === 'record') {
      const recorder = new OwnerRunRecorder(stateDirectory, workspace, clock);
      try {
        result = command === 'prepare'
          ? recorder.prepare({ reservationId: v.reservation!, taskId: v.task!, execution: v.provenance as 'fixture' | 'authenticated' })
          : recorder.record(v.reservation!, v.manifest!, v['manifest-sha256']!);
      } finally { recorder.close(); }
    } else if (command === 'generate') {
      const service = new WeeklyService(stateDirectory, workspace);
      try {
        result = service.generate({ ...options, dueAt: number(v.due!), lowerExclusive: number(v.lower!),
          ...(v.upper === undefined ? {} : { upperInclusive: number(v.upper) }),
          ...(v['page-size'] === undefined ? {} : { pageSize: number(v['page-size']) }) });
      } finally { service.close(); }
    } else {
      const schedule = new WeeklySchedule(stateDirectory, workspace, clock);
      try {
        switch (command) {
          case 'config': result = schedule.configure(options); break;
          case 'status': result = schedule.status(); break;
          case 'disable': result = schedule.disable(); break;
          case 'tick': result = schedule.tick(); break;
          case 'result': result = v.due === undefined ? schedule.result() : schedule.result(number(v.due)); break;
        }
      } finally { schedule.close(); }
    }
    io.stdout(JSON.stringify(result, null, 2) + '\n'); return 0;
  } catch {
    io.stderr('Weekly command failed: invalid owner input. Use --help.\n'); return 2;
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = summaryMain(process.argv.slice(2));
