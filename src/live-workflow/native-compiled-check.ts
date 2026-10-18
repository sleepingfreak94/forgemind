import { lstatSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { privateDirectory } from './authority.js';
import { runtimeFiles, supervised } from './process.js';
import { sourceIdentity } from './repository.js';
import { sha256 } from './validation.js';
import { pinFile, verifyFile } from '../host-enforcement/manifest.js';
import type { PinnedFile } from '../host-enforcement/manifest.js';
import type { ActionAuthority } from './contracts.js';
import type { CheckResult } from './checks.js';
import type { CompiledTestCheck } from './native-checks-contracts.js';

interface StageDetail {
  operation: 'native.compiled-check.stage';
  id: string;
  stage: 'compile' | 'execute';
  command: CompiledTestCheck;
  cwd: string;
  executable: string;
  args: string[];
  dependencies: PinnedFile[];
  artifactManifest: PinnedFile[];
  profileSha256: string;
  timeoutMs: number;
}
export interface CompiledCheckResult extends CheckResult {
  stages: (CheckResult & { command: StageDetail })[];
  artifactManifest: PinnedFile[];
}
const prepared = new WeakMap<object, string>();
function freeze<T extends object>(value: T): T {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return Object.freeze(value);
}
/** Only in-process host preparation can authorize a stage; JSON cannot mint it. */
export function assertCompiledStage(raw: unknown, check: CompiledTestCheck, root: string, copy: unknown): void {
  if (!raw || typeof raw !== 'object' || prepared.get(raw) !== JSON.stringify(raw))
    throw new Error('Unsealed compiled check stage');
  const detail = raw as StageDetail;
  if (JSON.stringify(copy) !== prepared.get(raw) || detail.cwd !== root || JSON.stringify(detail.command) !== JSON.stringify(check))
    throw new Error('Changed compiled check stage');
}
function tree(directory: string, commandShims = false): PinnedFile[] {
  const files: PinnedFile[] = [];
  const visit = (path: string) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error('Linked compiler input or artifact');
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        // npm command shims are not inputs to the directly launched native compiler.
        if (!commandShims || name !== '.bin') visit(join(path, name));
      }
    } else if (stat.isFile()) files.push(pinFile(path));
    else throw new Error('Non-regular compiler input or artifact');
  };
  visit(directory); return files;
}
const literal = (path: string) => '(literal ' + JSON.stringify(path) + ')';
function profile(root: string, scratch: string, writable: string, executable: string, files: PinnedFile[]): string {
  return `(version 1)
(deny default)
(allow process-exec ${literal(executable)})
(allow process-info* (target same-sandbox))
(allow sysctl-read)
(allow file-read-metadata)
(allow file-read* (literal "/") (subpath "/usr/lib") (subpath "/System/Library") (literal "/dev/null") (subpath ${JSON.stringify(root)}) (subpath ${JSON.stringify(scratch)}) ${files.map(f => literal(f.path)).join(' ')})
(deny file-read* (subpath ${JSON.stringify(join(root, '.git'))}) (subpath ${JSON.stringify(join(root, '.codex'))}) (regex #"(^|/)\\.env($|\\.)"))
(allow file-write* (subpath ${JSON.stringify(writable)}))`;
}
export async function runCompiledCheck(root: string, source: string, check: CompiledTestCheck,
  scratchParent: string, authority: ActionAuthority, signal: AbortSignal): Promise<CompiledCheckResult> {
  const started = performance.now(), deadline = started + check.timeoutMs;
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(check.timeoutMs)]);
  const current = () => {
    bounded.throwIfAborted();
    if (sourceIdentity(root) !== source) throw new Error('Stale compiled check source');
  };
  current();
  const parent = privateDirectory(scratchParent), rel = relative(root, parent);
  if (!(rel === '..' || rel.startsWith('..' + sep))) throw new Error('Check scratch must be outside source');
  const scratch = privateDirectory(mkdtempSync(join(parent, 'compiled-check-')));
  const compiled = join(scratch, 'compiled'), runtime = join(scratch, 'runtime');
  mkdirSync(compiled, { mode: 0o700 }); mkdirSync(runtime, { mode: 0o700 });
  mkdirSync(join(runtime, 'tmp'), { mode: 0o700 });
  // Bind ignored installed dependencies as well as repository-owned compiler inputs.
  const inputs = [...tree(join(root, 'node_modules'), true), ...tree(join(root, 'src')),
    ...tree(join(root, 'tests')), ...tree(join(root, 'config')),
    pinFile(join(root, 'package.json')), pinFile(join(root, 'package-lock.json'))];
  const inputDigest = sha256(JSON.stringify(inputs));
  const verifyInputs = () => { for (const file of inputs) verifyFile(file, false); };
  const verifyTrees = () => {
    current(); verifyInputs();
    const now = [...tree(join(root, 'node_modules'), true), ...tree(join(root, 'src')),
      ...tree(join(root, 'tests')), ...tree(join(root, 'config')),
      pinFile(join(root, 'package.json')), pinFile(join(root, 'package-lock.json'))];
    if (sha256(JSON.stringify(now)) !== inputDigest) throw new Error('Compiler inputs changed');
  };
  const verifyArtifacts = () => { for (const file of artifactManifest) verifyFile(file, false); };
  const stages: CompiledCheckResult['stages'] = [];
  let artifactManifest: PinnedFile[] = [], remainingOutput = 1048576;
  const stage = async (name: 'compile' | 'execute', executable: string, args: string[], writable: string) => {
    verifyTrees(); verifyArtifacts();
    const libraries = runtimeFiles(executable).map(pinFile);
    const dependencies = [...inputs, ...libraries, ...artifactManifest];
    const verifyLibraries = (hash = false) => { for (const file of libraries) verifyFile(file, hash); };
    const sandbox = profile(root, scratch, writable, executable, libraries);
    const timeoutMs = Math.floor(deadline - performance.now());
    if (timeoutMs < 1) throw new Error('Compiled check deadline');
    const detail: StageDetail = freeze({ operation: 'native.compiled-check.stage', id: check.id, stage: name,
      command: structuredClone(check), cwd: root, executable, args, dependencies, artifactManifest,
      profileSha256: sha256(sandbox), timeoutMs });
    prepared.set(detail, JSON.stringify(detail));
    const receipt = authority.reserve({ kind: 'command', source, detail });
    try {
      verifyLibraries(true); verifyArtifacts();
      const result = await supervised({ executable, args, cwd: root,
        dependencies: dependencies.map(f => f.path), env: { PATH: '/usr/bin:/bin', HOME: runtime,
          TMPDIR: join(runtime, 'tmp'), LANG: 'C', LC_ALL: 'C', OPENSSL_CONF: '/dev/null' },
        profile: sandbox, timeoutMs, maxOutputBytes: remainingOutput, signal: bounded,
        check: () => { receipt.check(); verifyInputs(); verifyArtifacts(); verifyLibraries(); } });
      remainingOutput -= Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
      verifyTrees(); verifyLibraries(true);
      for (const file of artifactManifest) verifyFile(file);
      if (name === 'execute' && JSON.stringify(tree(compiled)) !== JSON.stringify(artifactManifest))
        throw new Error('Compiled artifact inventory changed');
      const item = { id: check.id + ':' + name, passed: result.code === 0, exitCode: result.code,
        stdout: result.stdout, stderr: result.stderr, command: detail };
      receipt.finish(item.passed ? 'completed' : 'failed', sha256(JSON.stringify(item)));
      stages.push(item); return item.passed;
    } catch (error) {
      try { receipt.finish('indeterminate'); } catch {}
      throw error;
    } finally { prepared.delete(detail); }
  };
  const compiledOK = await stage('compile', check.compilerExecutable, ['-p', check.project,
    '--strict', '--noUncheckedIndexedAccess', '--exactOptionalPropertyTypes',
    '--noCheck', 'false', '--noEmit', 'false', '--noEmitOnError', '--incremental', 'false', '--rootDir', root, '--outDir', compiled], scratch);
  if (compiledOK) {
    current();
    // NodeNext output is outside the source package boundary.
    writeFileSync(join(compiled, 'package.json'), '{"type":"module"}\n', { flag: 'wx', mode: 0o600 });
    artifactManifest = tree(compiled);
    const tests = check.testPaths.map(path => join(compiled, path.slice(0, -3) + '.js'));
    for (const path of tests) {
      if (!artifactManifest.some(file => file.path === path)) throw new Error('Missing compiled test');
    }
    await stage('execute', check.nodeExecutable, ['--test', '--test-isolation=none', ...tests], runtime);
  }
  current();
  const last = stages.at(-1)!;
  const result = { id: check.id, passed: compiledOK && last.passed, exitCode: last.exitCode,
    stdout: stages.map(s => s.stdout).join(''), stderr: stages.map(s => s.stderr).join(''),
    stages, artifactManifest };
  writeFileSync(join(scratch, 'result.json'), JSON.stringify(result) + '\n', {flag:'wx',mode:0o600});
  return result;
}
