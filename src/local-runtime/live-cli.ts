import { lstatSync, readFileSync, realpathSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { inspectProject, LIVE_BLOCK_REASON } from '../live-workflow/readiness.js';
import { task } from '../live-workflow/validation.js';
import { connectChatGPT, chatGPTStatus } from '../live-workflow/chatgpt-auth.js';
import { openChatGPTPlanSession, forgetChatGPTBillingReview } from '../live-workflow/chatgpt-plan.js';
import { privateDirectory } from '../live-workflow/authority.js';
import { runTask } from '../live-workflow/orchestrator.js';
import { validateCommitAuthor } from '../live-workflow/repository.js';
import { loadBrowserQaConfiguration } from '../live-workflow/browser-qa-command.js';
import { pinFile } from '../host-enforcement/manifest.js';
import { pinClaudeCli, openClaudeSubscriptionSession } from '../live-workflow/claude-session.js';
import { nodeProjectRuntime } from '../live-workflow/check-runtime.js';
import { pinCursorCli, openCursorSubscriptionSession } from '../live-workflow/cursor-session.js';
import { cursorPersonalWorkspaces } from './cursor-route-config.js';
import { defaultBrainDirectory } from '../memory/brain.js';
import { recordHarnessRun } from '../memory/brain-runs.js';
import { defaultMemoryDirectory } from '../memory/location.js';
import type { AutomaticHistoryOptions } from '../live-workflow/automatic-run-history.js';

const memoryDirectory = (): string | undefined => {
  const dir = defaultMemoryDirectory();
  try { return lstatSync(dir).isDirectory() ? dir : undefined; } catch { return undefined; }
};

const usage = `Supervised project coding with your ChatGPT plan (macOS):
  project:connect --connection /private/forgemind-account
  project:auth-status --connection /private/forgemind-account
  node dist/src/local-runtime/live-cli.js billing-reset --connection /private/forgemind-account
  project:inspect --workspace /absolute/project
  project:run --workspace /absolute/project --task /absolute/task.json
    --connection /private/forgemind-account --codex /absolute/codex
    --state-root /private/runs --worktree-root /private/worktrees
    [--browser-qa-config /private/browser-qa.json]
    [--gh /canonical/gh --author-name "Repository owner" --author-email "owner@users.noreply.github.com"]
  project:run --workspace /absolute/project --task /absolute/task.json --provider anthropic
    --claude /canonical/claude-code-binary --claude-profile /private/claude-profile
    --state-root /private/runs --worktree-root /private/worktrees

Claude route (ADR-0014): sign in yourself first with
  CLAUDE_CONFIG_DIR=/private/claude-profile claude auth login
ForgeMind never reads that login. Planning uses Opus 5.5; coding and review use Sonnet 5.5.

Connection prints a browser sign-in link; complete OpenAI authentication and consent yourself.
Run remembers the owner's credits-off acknowledgement for the same account; billing-reset forgets it.
Draft PR tasks require all three explicit publication options before account review.
Browser QA host config requires the connection tuple; both phase reports gate review and publication.
No credentials are read and no worktree is created when run connection options are absent.
No --yes, paid API fallback, endpoint override, or automatic task replay exists.
Checks are read-only and offline. They are single-process unless a check sets "profile": "node-project" and you pass
--node-modules /canonical/project/node_modules (ADR-0015). Docker/Compose checks are unavailable.
`;
export function parseLiveArguments(argv: readonly string[]) {
  const [mode, ...raw] = argv;
  if (mode === '--help' || raw.length === 1 && raw[0] === '--help') return { mode: 'help', values: {} as Record<string, string> };
  if (!['inspect', 'run', 'connect', 'auth-status', 'billing-reset'].includes(mode ?? '')) throw new Error('Expected inspect, run, connect, auth-status or billing-reset');
  const accountMode = ['connect', 'auth-status', 'billing-reset'].includes(mode!);
  const allowed = accountMode ? ['--connection'] :
    ['--workspace', ...(mode === 'run' ? ['--task', '--connection', '--codex', '--state-root', '--worktree-root', '--gh', '--author-name', '--author-email', '--browser-qa-config',
      '--provider', '--claude', '--claude-profile', '--cursor', '--cursor-profile', '--cursor-mode', '--node-modules'] : [])];
  const values: Record<string, string> = Object.create(null);
  for (let i = 0; i < raw.length; i += 2) {
    const key = raw[i]!, value = raw[i + 1];
    const textField = key === '--author-name' || key === '--author-email' || key === '--provider' || key === '--cursor-mode';
    if (!allowed.includes(key) || key in values || !value || value.startsWith('--') || /[\x00-\x1f\x7f]/.test(value) ||
      !textField && (!isAbsolute(value) || resolve(value) !== value)) throw new Error('Exact absolute paths and recognized options required');
    values[key] = value;
  }
  for (const key of accountMode ? ['--connection'] : ['--workspace', ...(mode === 'run' ? ['--task'] : [])]) {
    if (!values[key]) throw new Error(`Required ${key}`);
  }
  const provider = values['--provider'] ?? 'openai';
  if (!['openai', 'anthropic', 'cursor'].includes(provider)) throw new Error('Provider must be openai, anthropic or cursor');
  if (values['--cursor-mode'] !== undefined && values['--cursor-mode'] !== 'test-auto') throw new Error('Cursor mode must be test-auto');
  const routeKeys: Record<string, string[]> = { openai: ['--connection', '--codex'], anthropic: ['--claude', '--claude-profile'],
    cursor: ['--cursor', '--cursor-profile'] };
  const live = [...routeKeys[provider]!, '--state-root', '--worktree-root'];
  const other = [...Object.entries(routeKeys).filter(([name]) => name !== provider).flatMap(([, keys]) => keys),
    ...(provider === 'cursor' ? [] : ['--cursor-mode'])];
  const foreign = other.filter(key => values[key]);
  if (foreign.length) throw new Error(provider === 'anthropic' && foreign.every(key => routeKeys.openai!.includes(key)) ? 'Claude route does not accept connection or codex'
    : provider === 'openai' && foreign.every(key => routeKeys.anthropic!.includes(key)) ? 'Claude options require --provider anthropic'
    : `Options for another provider cannot be combined with --provider ${provider}`);
  if (mode === 'run' && live.some(key => values[key]) && !live.every(key => values[key])) {
    const names = live.map(key => key.slice(2));
    throw new Error(`${names[0]![0]!.toUpperCase()}${names[0]!.slice(1)}, ${names.slice(1, -1).join(', ')} and ${names.at(-1)} must be supplied together`);
  }
  if (values['--browser-qa-config'] && !live.every(key => values[key]))
    throw new Error('Browser QA config requires the complete connection tuple');
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
  if (mode === 'billing-reset') {
    forgetChatGPTBillingReview(args['--connection']!);
    output({ billingReview: 'cleared', providerRequests: 0 }); return;
  }
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
  const browserQa = args['--browser-qa-config'] ? loadBrowserQaConfiguration(args['--browser-qa-config']!, root) : undefined;
  if (manifest.draftPr && !args['--gh'])
    throw new Error('Draft PR requires explicit publication --gh, --author-name and --author-email');
  const provider = args['--provider'] ?? 'openai', claude = provider === 'anthropic', cursor = provider === 'cursor';
  if ((manifest.provider ?? 'openai') !== provider) throw new Error('Task provider does not match the selected route');
  if (!args[claude ? '--claude' : cursor ? '--cursor' : '--connection']) {
    output({ status: 'blocked', taskId: manifest.taskId, workspace: root, liveCodingEnabled: false,
      reason: LIVE_BLOCK_REASON, worktreeCreated: false, providerRequests: 0 });
    process.exitCode = 2; return;
  }
  if (process.platform !== 'darwin') throw new Error('Supervised live coding currently requires macOS');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Supervised execution requires an owner terminal');
  for (const key of [claude ? '--claude-profile' : cursor ? '--cursor-profile' : '--connection', '--state-root', '--worktree-root']) {
    const path = args[key]!;
    if (!outside(root, path) || !outside(path, root)) throw new Error('Account, state and worktree directories must be separate from project source');
  }
  if (provider === 'openai' && realpathSync(args['--codex']!) !== args['--codex']) throw new Error('Canonical Codex executable required');
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
  let routeSession: { close(): void } | undefined;
  const controller = new AbortController(), abort = () => controller.abort();
  process.once('SIGINT', abort);
  try {
    const planSession = provider !== 'openai' ? undefined
      : await openChatGPTPlanSession(args['--connection']!, { isTTY: true, confirm: prompt => terminal.question(prompt, { signal: controller.signal }) });
    const cli = claude ? pinClaudeCli(args['--claude']!) : undefined, cursorCli = cursor ? pinCursorCli(args['--cursor']!) : undefined;
    const states = privateDirectory(args['--state-root']!), worktrees = privateDirectory(args['--worktree-root']!);
    const runDirectory = join(states, manifest.taskId + '-' + randomUUID());
    mkdirSync(runDirectory, { mode: 0o700 });
    const route = cli ? await (async () => {
      const session = await openClaudeSubscriptionSession({ profileDirectory: args['--claude-profile']!, cli,
        scratchRoot: runDirectory, separateFrom: [root, states, worktrees], signal: controller.signal });
      routeSession = session;
      process.stderr.write(`Claude ${cli.version} signed in (${session.subscriptionType}); ForgeMind does not read the login.\n`);
      return { claude: { cli, session } };
    })() : cursorCli ? await (async () => {
      const session = await openCursorSubscriptionSession({ profileDirectory: args['--cursor-profile']!, cli: cursorCli, workspace: root,
        personalWorkspaces: cursorPersonalWorkspaces(), scratchRoot: runDirectory, separateFrom: [states, worktrees], signal: controller.signal });
      routeSession = session;
      const testAuto = args['--cursor-mode'] === 'test-auto';
      process.stderr.write(`Cursor ${cursorCli.version} signed in (${session.tier}${session.company ? ', company seat' : ', personal plan'})` +
        `${testAuto ? '; TEST MODE: Auto picks the model, nothing is published' : ''}; ForgeMind does not read the login.\n`);
      return { cursor: { cli: cursorCli, session, ...(testAuto ? { testAuto } : {}) } };
    })() : { codexExecutable: args['--codex']!, planSession: planSession! };
    const checkRuntime = args['--node-modules'] ? nodeProjectRuntime(args['--node-modules']) : undefined;
    const note = (status: string, prUrl?: string) => {
      try {
        const recorded = recordHarnessRun({ brainDirectory: defaultBrainDirectory(), workspace: root, taskId: manifest.taskId,
          objective: manifest.objective, artifacts: join(runDirectory, 'artifacts'), status, ...(prUrl ? { prUrl } : {}) });
        process.stderr.write(recorded.recorded ? `Brain: run recorded in the ${recorded.space} space.\n`
          : `Brain: run not recorded (${recorded.reason}).\n`);
      } catch { /* recording never changes the run */ }
    };
    const memory = memoryDirectory();
    const history: AutomaticHistoryOptions | undefined = memory ? { stateDirectory: memory,
      // project:run reviews always run in a fresh model session started by this pipeline, so the exact run artifact for this task is independent.
      verifyIndependentReview: evidence => evidence.taskId === manifest.taskId && evidence.path === join(runDirectory, 'artifacts', 'review.json') } : undefined;
    if (!history) process.stderr.write('Run history: not recorded (no memory directory)\n');
    let result: Awaited<ReturnType<typeof runTask>>;
    try {
      result = await runTask({ workspace: root, task: manifest, ...route, ...(checkRuntime ? { checkRuntime } : {}),
      stateDirectory: runDirectory, worktreeDirectory: worktrees, signal: controller.signal,
      ...(publication ? { publication } : {}),
      ...(browserQa ? { browserQa } : {}),
      ...(history ? { history } : {}),
      confirmPlan: async (_plan, digest) => (await terminal.question(`Approve plan ${digest}? Enter approve ${digest}: `, { signal: controller.signal })) === `approve ${digest}`,
      onProgress: message => process.stderr.write(message + '\n') });
    } catch (error) { note('failed'); throw error; }
    output(result);
    try {
      const h = (result as { history?: { status?: unknown; code?: unknown } }).history;
      if (h) process.stderr.write(h.status === 'recorded' ? 'Run history: recorded\n'
        : `Run history: not recorded (${typeof h.code === 'string' ? h.code : 'incomplete'})\n`);
    } catch { /* history reporting never changes the run */ }
    const done = result as { status?: unknown; prUrl?: unknown };
    note(typeof done.status === 'string' ? done.status : 'unknown', typeof done.prUrl === 'string' ? done.prUrl : undefined);
  } finally { routeSession?.close(); terminal.close(); process.removeListener('SIGINT', abort); }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  liveMain().catch(error => {
    process.stderr.write(`Project execution: ${error instanceof Error ? error.message : 'failed'}. Use --help.\n`);
    process.exitCode = 2;
  });
}
