import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { testSuite } from '../dist/src/local-runtime/test-suites.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
try {
  if (process.argv.length !== 3) throw new Error('Specify exactly one test suite.');
  const suite = testSuite(process.argv[2], process.platform, typeof process.getuid === 'function');
  const files = [...suite.files];
  for (const directory of suite.directories) {
    const entries = readdirSync(join(root, directory), { withFileTypes: true });
    const discovered = entries.filter(entry => entry.isFile() && entry.name.endsWith('.test.js')).map(entry => join(directory, entry.name)).sort();
    if (!discovered.length) throw new Error(`No compiled tests found in ${directory}. Run npm run build.`);
    files.push(...discovered);
  }
  if (!files.length) throw new Error('Empty test suite.');
  const result = spawnSync(process.execPath, ['--test', ...(suite.timeoutMs ? [`--test-timeout=${suite.timeoutMs}`] : []), ...files],
    { cwd: root, stdio: 'inherit', shell: false });
  if (result.error) throw new Error('Test process could not start.');
  process.exitCode = result.status ?? 1;
} catch (error) {
  process.stderr.write(`ForgeMind verification: ${error.message}\n`); process.exitCode = 2;
}
