import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataSnapshot } from '../context-engine/validation.js';
import { SlackDelivery } from '../memory/slack-delivery.js';
import { slackBudget } from '../memory/slack-envelope.js';
import { natural, sha, slug } from '../memory/run-recording.js';

export const slackHelp = `Private Slack incoming webhook outbox (CLI never sends)
node dist/src/local-runtime/slack-delivery-cli.js COMMAND FLAGS
Every command needs --workspace /canonical/project --state-dir /external/private/state
  config --enable true|false [--destination-id ID --endpoint-binding SHA256 --consent true]
         [--max-bytes 4096..24576]
  status
  preview
  tick
  outbox [--limit 1..100] [--after ID]
Slack config only; configure the existing WeeklySchedule separately in trusted owner code.
No URL, credential, adapter, email recipient or send command is accepted.
tick enqueues only. status/preview/outbox do not update application state.
Use --help alone.\n`;
type Command = 'config' | 'status' | 'preview' | 'tick' | 'outbox';
export type SlackArguments = { readonly command: 'help' } | {
  readonly command: Command; readonly workspace: string; readonly directory: string;
  readonly values: Readonly<Record<string, string>>;
};
const flags: Readonly<Record<Command, readonly string[]>> = {
  config: ['enable', 'destination-id', 'endpoint-binding', 'consent', 'max-bytes'],
  status: [], preview: [], tick: [], outbox: ['limit', 'after']
};
function number(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('invalid decimal');
  const n = Number(value); natural(n); return n;
}
export function parseSlackArgs(raw: readonly string[]): SlackArguments {
  const args = dataSnapshot(raw);
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('invalid arguments');
  if (args.length === 1 && (args[0] === '--help' || args[0] === 'help')) return { command: 'help' };
  const name = args[0];
  if (!name || !Object.hasOwn(flags, name)) throw new Error('unknown Slack command');
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
    const destination = values['destination-id'], binding = values['endpoint-binding'];
    if (destination !== undefined || binding !== undefined || values.consent !== undefined) {
      slug(destination); sha(binding);
      if (values.consent !== 'true') throw new Error('explicit Slack consent required');
    }
    if (values['max-bytes'] !== undefined) slackBudget(number(values['max-bytes']));
  }
  if (values.limit !== undefined && (number(values.limit) < 1 || number(values.limit) > 100)) throw new Error('invalid page size');
  if (values.after !== undefined) sha(values.after);
  return dataSnapshot({ command, workspace: values.workspace!, directory: values['state-dir']!, values });
}
export interface SlackIO { readonly stdout: (text: string) => void; readonly stderr: (text: string) => void }
export function slackMain(args: readonly string[], io: SlackIO = {
  stdout: text => { process.stdout.write(text); }, stderr: text => { process.stderr.write(text); }
}, clock: () => number = Date.now): number {
  try {
    const parsed = parseSlackArgs(args);
    if (parsed.command === 'help') { io.stdout(slackHelp); return 0; }
    const delivery = new SlackDelivery(parsed.directory, parsed.workspace, clock);
    let result: unknown;
    try {
      const v = parsed.values;
      switch (parsed.command) {
        case 'config':
          result = delivery.configure({ enabled: v.enable === 'true', destinationId: v['destination-id'] ?? null,
            endpointBinding: v['endpoint-binding'] ?? null, consent: v.consent === 'true',
            ...(v['max-bytes'] === undefined ? {} : { maxBytes: number(v['max-bytes']) }) }); break;
        case 'status': result = delivery.status(); break;
        case 'preview': result = delivery.preview(); break;
        case 'tick': result = delivery.tick(); break;
        case 'outbox': result = delivery.outbox({ ...(v.limit === undefined ? {} : { limit: number(v.limit) }),
          ...(v.after === undefined ? {} : { after: v.after }) }); break;
      }
    } finally { delivery.close(); }
    io.stdout(JSON.stringify(result, null, 2) + '\n'); return 0;
  } catch {
    io.stderr('Slack command failed: invalid owner input or unavailable private state. Use --help.\n'); return 2;
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = slackMain(process.argv.slice(2));
