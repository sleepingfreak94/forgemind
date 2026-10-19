import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { testSuite, validateTestPrerequisites } from '../dist/src/local-runtime/test-suites.js';

const defaultRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// Options belong to the trusted caller; the CLI accepts only a suite selector.
export function runTests(args, { root = defaultRoot, platform = process.platform,
  posixIdentity = typeof process.getuid === 'function', env = process.env,
  spawn = spawnSync, stderr = message => process.stderr.write(message) } = {}) {
  try {
    if (args.length !== 1) throw new Error('Specify exactly one test suite.');
    const suite = testSuite(args[0], platform, posixIdentity);
    validateTestPrerequisites(suite, env);
    const files = [...suite.files];
    for (const directory of suite.directories) {
      const entries = readdirSync(join(root, directory), { withFileTypes: true });
      const discovered = entries.filter(entry => entry.isFile() && entry.name.endsWith('.test.js')).map(entry => join(directory, entry.name)).sort();
      if (!discovered.length) throw new Error(`No compiled tests found in ${directory}. Run npm run build.`);
      files.push(...discovered);
    }
    if (!files.length) throw new Error('Empty test suite.');
    const result = spawn(process.execPath, ['--test', ...(suite.timeoutMs ? [`--test-timeout=${suite.timeoutMs}`] : []), ...files],
      { cwd: root, env, stdio: 'inherit', shell: false });
    if (result.error) throw new Error('Test process could not start.');
    return result.status ?? 1;
  } catch (error) {
    stderr(`ForgeMind verification: ${error.message}\n`); return 2;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = runTests(process.argv.slice(2));
