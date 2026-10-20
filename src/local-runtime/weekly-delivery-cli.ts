import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataSnapshot } from '../context-engine/validation.js';
import { WeeklyDelivery } from '../memory/weekly-delivery.js';
import { budget, recipient } from '../memory/weekly-delivery-envelope.js';
import { natural, sha } from '../memory/run-recording.js';

export const deliveryHelp = `Private weekly email outbox (CLI never sends email)
node dist/src/local-runtime/weekly-delivery-cli.js COMMAND FLAGS
Every command requires --workspace /canonical/project --state-dir /external/private/state
  config --enable true|false [--recipient mailbox --consent true] [--max-bytes 1024..98304]
  status
  tick
  outbox [--limit 1..100] [--after ID]
config also enables/disables WeeklySchedule. A missing recipient reports pending-configuration.
tick recovers retained latest summaries and enqueues only; outbox previews exact envelopes.
No service, credentials, daemon or adapter is loaded by this CLI.
Use --help alone.\n`;
type Command = 'config' | 'status' | 'tick' | 'outbox';
export type DeliveryArguments = { readonly command: 'help' } | {
  readonly command: Command; readonly workspace: string; readonly directory: string;
  readonly values: Readonly<Record<string, string>>;
};
const flags: Readonly<Record<Command, readonly string[]>> = {
  config: ['enable', 'recipient', 'consent', 'max-bytes'], status: [], tick: [], outbox: ['limit', 'after']
};
function number(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('invalid decimal');
  const n = Number(value); natural(n); return n;
}
export function parseDeliveryArgs(raw: readonly string[]): DeliveryArguments {
  const args = dataSnapshot(raw);
  if (args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('invalid arguments');
  if (args.length === 1 && (args[0] === '--help' || args[0] === 'help')) return { command: 'help' };
  const name = args[0];
  if (!name || !Object.hasOwn(flags, name)) throw new Error('unknown delivery command');
  const command = name as Command, values: Record<string, string> = Object.create(null) as Record<string, string>;
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1], key = flag?.slice(2);
    if (!key || flag !== '--' + key || !['workspace', 'state-dir', ...flags[command]].includes(key) ||
        Object.hasOwn(values, key) || !value || value.startsWith('--')) throw new Error('invalid flag');
    values[key] = value;
  }
  for (const key of ['workspace', 'state-dir']) {
    const path = values[key];
    if (!path || !isAbsolute(path) || resolve(path) !== path) throw new Error('canonical absolute path required');
  }
  if (command === 'config') {
    if (values.enable !== 'true' && values.enable !== 'false') throw new Error('explicit enable required');
    if (values.recipient !== undefined) {
      recipient(values.recipient); if (values.consent !== 'true') throw new Error('explicit consent required');
    } else if (values.consent !== undefined) throw new Error('consent requires destination');
    if (values['max-bytes'] !== undefined) budget(number(values['max-bytes']));
  }
  if (values.limit !== undefined && (number(values.limit) < 1 || number(values.limit) > 100)) throw new Error('invalid page size');
  if (values.after !== undefined) sha(values.after);
  return dataSnapshot({ command, workspace: values.workspace!, directory: values['state-dir']!, values });
}
export interface DeliveryIO { readonly stdout: (text: string) => void; readonly stderr: (text: string) => void }
export function deliveryMain(args: readonly string[], io: DeliveryIO = {
  stdout: text => { process.stdout.write(text); }, stderr: text => { process.stderr.write(text); }
}, clock: () => number = Date.now): number {
  try {
    const parsed = parseDeliveryArgs(args);
    if (parsed.command === 'help') { io.stdout(deliveryHelp); return 0; }
    const delivery = new WeeklyDelivery(parsed.directory, parsed.workspace, clock);
    let result: unknown;
    try {
      const v = parsed.values;
      switch (parsed.command) {
        case 'config':
          delivery.configure({ enabled: v.enable === 'true', recipient: v.recipient ?? null, consent: v.consent === 'true',
            ...(v['max-bytes'] === undefined ? {} : { maxBytes: number(v['max-bytes']) }) });
          if (v.enable === 'true') delivery.schedule.configure(); else delivery.schedule.disable();
          result = delivery.status(); break;
        case 'status': result = delivery.status(); break;
        case 'tick': result = delivery.tick(); break;
        case 'outbox': result = delivery.outbox({ ...(v.limit === undefined ? {} : { limit: number(v.limit) }),
          ...(v.after === undefined ? {} : { after: v.after }) }); break;
      }
    } finally { delivery.close(); }
    io.stdout(JSON.stringify(result, null, 2) + '\n'); return 0;
  } catch {
    io.stderr('Weekly delivery command failed: invalid owner input. Use --help.\n'); return 2;
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = deliveryMain(process.argv.slice(2));
