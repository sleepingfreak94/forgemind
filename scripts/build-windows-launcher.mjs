// Owner step: build the Windows sandbox launcher with the in-box C# compiler into a private folder outside every checkout.
// Prints the source and binary SHA-256; pass the binary digest to pinWindowsLauncher (FORGEMIND_WINDOWS_LAUNCHER_SHA256 in tests).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(repository, 'src', 'host-enforcement', 'windows', 'sandbox-launcher.cs');
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const fail = message => { process.stderr.write(`build-windows-launcher: ${message}\n`); process.exit(2); };

if (process.platform !== 'win32') fail('run this on Windows');
const target = process.argv[2];
if (!target || !isAbsolute(target) || !existsSync(target)) fail('pass an existing absolute output folder');
const folder = realpathSync.native(target), rest = relative(repository, folder);
if (rest === '' || (!rest.startsWith('..') && !isAbsolute(rest))) fail('the output folder must be outside the repository');
const framework = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', process.arch === 'arm64' ? 'FrameworkArm64' : 'Framework64', 'v4.0.30319');
const compiler = join(framework, 'csc.exe');
if (!existsSync(compiler)) fail(`no C# compiler at ${compiler}`);
const output = join(folder, 'forgemind-sandbox.exe');
const result = spawnSync(compiler, ['/nologo', '/optimize', '/target:exe', '/r:System.Web.Extensions.dll', `/out:${output}`, source],
  { stdio: 'inherit', shell: false });
if (result.status !== 0) fail('compilation failed');
process.stdout.write(`${JSON.stringify({ launcher: output, sha256: sha256(output), sourceSha256: sha256(source) }, null, 2)}\n`);
