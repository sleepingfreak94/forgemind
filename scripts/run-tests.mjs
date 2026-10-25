import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { missingCodexFixtures, testSuite, validateTestPrerequisites } from '../dist/src/local-runtime/test-suites.js';

const defaultRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// The child leads its own process group so a timeout can kill the runner and every worker.
export function defaultRun(command, args, { cwd, env, maxRunMs } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit', shell: false, detached: true });
    let timedOut = false, settled = false;
    const forwarders = new Map();
    const settle = action => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      for (const [signal, handler] of forwarders) process.removeListener(signal, handler);
      action();
    };
    const killGroup = signal => {
      try { process.kill(-child.pid, signal); }
      catch { try { child.kill(signal); } catch { /* already gone */ } }
    };
    const timer = setTimeout(() => { timedOut = true; killGroup('SIGKILL'); }, maxRunMs);
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const handler = () => killGroup(signal);
      forwarders.set(signal, handler); process.on(signal, handler);
    }
    child.on('error', () => settle(() => reject(new Error('Test process could not start.'))));
    child.on('exit', code => settle(() => resolvePromise({ status: timedOut ? null : code, timedOut })));
  });
}

// Options belong to the trusted caller; the CLI accepts only a suite selector.
export async function runTests(args, { root = defaultRoot, platform = process.platform,
  posixIdentity = typeof process.getuid === 'function', env = process.env,
  run = defaultRun, stderr = message => process.stderr.write(message), maxRunMs } = {}) {
  try {
    if (args.length !== 1) throw new Error('Specify exactly one test suite.');
    const suite = testSuite(args[0], platform, posixIdentity);
    validateTestPrerequisites(suite, env);
    if (args[0] === 'local') {
      const missing = missingCodexFixtures(env);
      if (missing.length) stderr(`ForgeMind verification: reviewed Codex ${missing.join(' and ')} not available; tests that need them will be skipped.\n`);
    }
    const files = [...suite.files];
    for (const directory of suite.directories) {
      const entries = readdirSync(join(root, directory), { withFileTypes: true });
      const discovered = entries.filter(entry => entry.isFile() && entry.name.endsWith('.test.js')).map(entry => join(directory, entry.name)).sort();
      if (!discovered.length) throw new Error(`No compiled tests found in ${directory}. Run npm run build.`);
      files.push(...discovered);
    }
    if (!files.length) throw new Error('Empty test suite.');
    const limit = maxRunMs ?? suite.maxRunMs;
    const result = await run(process.execPath, ['--test', ...(suite.timeoutMs ? [`--test-timeout=${suite.timeoutMs}`] : []), ...files],
      { cwd: root, env, maxRunMs: limit });
    if (result.timedOut) {
      const minutes = Math.round(limit / 60000 * 100) / 100;
      stderr(`ForgeMind verification: test run exceeded ${minutes} minutes and was stopped. Run a narrower suite or the single slow test file.\n`);
      return 2;
    }
    return result.status ?? 1;
  } catch (error) {
    stderr(`ForgeMind verification: ${error.message}\n`); return 2;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await runTests(process.argv.slice(2));
