import { lstatSync, readFileSync, realpathSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { inspectProject, LIVE_BLOCK_REASON } from '../live-workflow/readiness.js';
import { task } from '../live-workflow/validation.js';
import { connectChatGPT, chatGPTStatus } from '../live-workflow/chatgpt-auth.js';
import { openChatGPTPlanSession } from '../live-workflow/chatgpt-plan.js';
import { privateDirectory } from '../live-workflow/authority.js';
import { runTask } from '../live-workflow/orchestrator.js';
import { validateCommitAuthor } from '../live-workflow/repository.js';
import { pinFile } from '../host-enforcement/manifest.js';

const usage = `Supervised project coding with your ChatGPT plan (macOS):
  project:connect --connection /private/forgemind-account
  project:auth-status --connection /private/forgemind-account
  project:inspect --workspace /absolute/project
  project:run --workspace /absolute/project --task /absolute/task.json
    --connection /private/forgemind-account --codex /absolute/codex
    --state-root /private/runs --worktree-root /private/worktrees
    [--gh /canonical/gh --author-name "Repository owner" --author-email "owner@users.noreply.github.com"]

Connection prints a browser sign-in link; complete OpenAI authentication and consent yourself.
Run requires a fresh owner TTY review of the connected-app credits-off setting.
Draft PR tasks require all three explicit publication options before account review.
No credentials are read and no worktree is created when run connection options are absent.
No --yes, paid API fallback, endpoint override, or automatic task replay exists.
Checks remain single-process, read-only and offline. Docker/Compose checks are unavailable.
`;
export function parseLiveArguments(argv: readonly string[]) {
  const [mode, ...raw] = argv;
  if (mode === '--help' || raw.length === 1 && raw[0] === '--help') return { mode: 'help', values: {} as Record<string, string> };
  if (!['inspect', 'run', 'connect', 'auth-status'].includes(mode ?? '')) throw new Error('Expected inspect, run, connect or auth-status');
  const allowed = mode === 'connect' || mode === 'auth-status' ? ['--connection'] :
    ['--workspace', ...(mode === 'run' ? ['--task', '--connection', '--codex', '--state-root', '--worktree-root', '--gh', '--author-name', '--author-email'] : [])];
  const values: Record<string, string> = Object.create(null);
  for (let i = 0; i < raw.length; i += 2) {
    const key = raw[i]!, value = raw[i + 1];
    const authorField = key === '--author-name' || key === '--author-email';
    if (!allowed.includes(key) || key in values || !value || value.startsWith('--') || /[\x00-\x1f\x7f]/.test(value) ||
      !authorField && (!isAbsolute(value) || resolve(value) !== value)) throw new Error('Exact absolute paths and recognized options required');
    values[key] = value;
  }
  for (const key of mode === 'connect' || mode === 'auth-status' ? ['--connection'] : ['--workspace', ...(mode === 'run' ? ['--task'] : [])]) {
    if (!values[key]) throw new Error(`Required ${key}`);
  }
  const live = ['--connection', '--codex', '--state-root', '--worktree-root'];
  if (mode === 'run' && live.some(key => values[key]) && !live.every(key => values[key]))
    throw new Error('Connection, codex, state-root and worktree-root must be supplied together');
  const publication = ['--gh', '--author-name', '--author-email'];
  if (mode === 'run' && publication.some(key => values[key]) && !publication.every(key => values[key]))
    throw new Error('Publication gh, author-name and author-email must be supplied together');
  if (values['--gh']) validateCommitAuthor({ name: values['--author-name']!, email: values['--author-email']! });
  return { mode: mode!, values };
}
const outside = (root: string, path: string) => { const rel = relative(root, path); return rel === '..' || rel.startsWith('..' + sep); };
const output = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
export async function liveMain(argv = process.argv.slice(2)): Promise<void> {
  const { mode, values: args } = parseLiveArguments(argv);
  if (mode === 'help') { process.stdout.write(usage); return; }
  if (mode === 'auth-status') { output(chatGPTStatus(args['--connection']!)); return; }
  if (mode === 'connect') {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Browser sign-in requires an owner terminal');
    const controller = new AbortController();
    const abort = () => controller.abort(); process.once('SIGINT', abort);
    try {
      output(await connectChatGPT({ directory: args['--connection']!, signal: controller.signal,
        onAuthorize: url => { process.stderr.write(`Continue with ChatGPT in your browser:\n${url}\n`); } }));
    } finally { process.removeListener('SIGINT', abort); }
    return;
  }
  const root = realpathSync(args['--workspace']!);
  if (root !== args['--workspace']) throw new Error('Canonical workspace required');
  if (mode === 'inspect') { output(inspectProject(root)); return; }
  const input = realpathSync(args['--task']!), stat = lstatSync(input);
  if (input !== args['--task'] || !stat.isFile() || stat.nlink !== 1 || stat.size > 65536) throw new Error('Invalid task manifest');
  const manifest = task(JSON.parse(readFileSync(input, 'utf8')));
  if (manifest.draftPr && !args['--gh'])
    throw new Error('Draft PR requires explicit publication --gh, --author-name and --author-email');
  if (!args['--connection']) {
    output({ status: 'blocked', taskId: manifest.taskId, workspace: root, liveCodingEnabled: false,
      reason: LIVE_BLOCK_REASON, worktreeCreated: false, providerRequests: 0 });
    process.exitCode = 2; return;
  }
  if (process.platform !== 'darwin') throw new Error('Supervised live coding currently requires macOS');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Supervised execution requires an owner terminal');
  for (const key of ['--connection', '--state-root', '--worktree-root']) {
    const path = args[key]!;
    if (!outside(root, path) || !outside(path, root)) throw new Error('Account, state and worktree directories must be separate from project source');
  }
  if (realpathSync(args['--codex']!) !== args['--codex']) throw new Error('Canonical Codex executable required');
  const publication = args['--gh'] ? (() => {
    const gh = pinFile(args['--gh']!);
    if (gh.path !== args['--gh'] || !(lstatSync(gh.path).mode & 0o111) || !/^\/[A-Za-z0-9_./-]+$/.test(gh.path))
      throw new Error('Canonical executable gh helper required');
    return { author: validateCommitAuthor({ name: args['--author-name']!, email: args['--author-email']! }),
      gitCredentialHelper: { ghPath: gh.path, sha256: gh.digest } };
  })() : undefined;
  const inspected = inspectProject(root);
  if (inspected.repository.dirtyPaths.length) throw new Error('Source must be clean before task execution');
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  const controller = new AbortController(), abort = () => controller.abort();
  process.once('SIGINT', abort);
  try {
    const session = await openChatGPTPlanSession(args['--connection']!, { isTTY: true, confirm: prompt => terminal.question(prompt, { signal: controller.signal }) });
    const states = privateDirectory(args['--state-root']!), worktrees = privateDirectory(args['--worktree-root']!);
    const runDirectory = join(states, manifest.taskId + '-' + randomUUID());
    mkdirSync(runDirectory, { mode: 0o700 });
    output(await runTask({ workspace: root, task: manifest, codexExecutable: args['--codex']!,
      stateDirectory: runDirectory, worktreeDirectory: worktrees, planSession: session, signal: controller.signal,
      ...(publication ? { publication } : {}),
      confirmPlan: async (_plan, digest) => (await terminal.question(`Approve plan ${digest}? Enter approve ${digest}: `, { signal: controller.signal })) === `approve ${digest}`,
      onProgress: message => process.stderr.write(message + '\n') }));
  } finally { terminal.close(); process.removeListener('SIGINT', abort); }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  liveMain().catch(error => {
    process.stderr.write(`Project execution: ${error instanceof Error ? error.message : 'failed'}. Use --help.\n`);
    process.exitCode = 2;
  });
}
