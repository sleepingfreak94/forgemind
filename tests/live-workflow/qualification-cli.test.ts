import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { qualificationMain, parseQualificationArgs, maxQualificationArtifactBytes, maxQualificationArtifactTotalBytes } from '../../src/local-runtime/qualification-cli.js';
import type { QualificationCliPorts } from '../../src/local-runtime/qualification-cli.js';
import type { QualificationReport } from '../../src/live-workflow/qualification-contracts.js';
import { maxQualificationBytes } from '../../src/live-workflow/qualification-contracts.js';
import { textHash } from '../../src/live-workflow/qualification-validation.js';

const source = textHash('CLI candidate'), historical = textHash('older candidate'), now = 2000;
const secret = 'PRIVATE_ACCOUNT_TRANSCRIPT_DO_NOT_PRINT';
function supervised() {
  return { schema: 'qualification-input-v1', taskId: 'task', projectId: 'project', source, fixture: true, requiredChecks: ['strict'],
    receipt: { taskId: 'task', run: { id: 'task', status: 'failed', requests: 0, input_bytes: 0 },
      phases: [{ seq: 1, name: 'session.started', source, data: '{}' }], receipts: [] }, artifacts: [] };
}
function native(root: string) {
  return { schema: 'qualification-input-v1', taskId: 'task', projectId: 'project', source, fixture: true, requiredChecks: ['strict'],
    nativeTask: { project: 'project', task: 'task', source, root, model: 'gpt-6.1-sol', effort: 'medium',
      readPaths: ['source.ts'], writePaths: [], checks: [{ id: 'strict', executable: '/node', args: [], timeoutMs: 100 }],
      budget: { runtimeMs: 5000, turns: null, toolCalls: null, inputBytes: 10000, resultBytes: 10000, wireBytes: 10000, outputBytes: 10000, retries: 0 } },
    parentBinding: textHash('parent'), result: { phase: 'native-turn', code: 'native-provider-quota',
      receipts: { nativeDiagnostic: { kind: 'usageLimitExceeded', httpStatusCode: null, willRetry: false } } } };
}
function fixture() {
  const base = mkdtempSync(join(realpathSync(tmpdir()), 'qualification-cli-'));
  chmodSync(base, 0o700);
  const root = join(base, 'repo'), privateDir = join(base, 'private');
  mkdirSync(root, { mode: 0o700 }); mkdirSync(privateDir, { mode: 0o700 });
  const input = join(privateDir, 'input.json'), buildPath = join(privateDir, 'build.json'), output = join(privateDir, 'report.json');
  const artifact = join(root, 'library.js'), rawArtifact = 'export const actual = 1;\n';
  writeFileSync(artifact, rawArtifact, { mode: 0o644 }); chmodSync(artifact, 0o644);
  const build = { schema: 'qualification-build-v1', source, artifacts: [{ id: 'library', path: artifact, sha256: textHash(rawArtifact) }] };
  const put = (path: string, value: unknown): void => { writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); chmodSync(path, 0o600); };
  put(input, supervised()); put(buildPath, build);
  const args = (mode = 'supervised'): string[] => [mode, '--workspace', root, '--input', input, '--build', buildPath,
    '--created-at', '1900', '--expires-at', '3000', '--output', output];
  const verify = (): string[] => ['verify', '--workspace', root, '--input', output];
  const invoke = (argv: readonly string[] = args(), overrides: QualificationCliPorts = {}) => {
    let stdout = '', stderr = '';
    const code = qualificationMain(argv, { source: candidate => { assert.equal(candidate, root); return source; }, clock: () => now,
      stdout: value => { stdout += value; }, stderr: value => { stderr += value; }, ...overrides });
    return { code, stdout, stderr };
  };
  return { base, root, privateDir, input, buildPath, output, artifact, build, put, args, verify, invoke,
    report: () => JSON.parse(readFileSync(output, 'utf8')) as QualificationReport,
    close: () => { rmSync(base, { recursive: true, force: true }); } };
}
function denied(result: { code: number; stdout: string; stderr: string }): void {
  assert.equal(result.code, 1); assert.equal(result.stdout, '');
  assert.equal(result.stderr, '{"status":"denied","error":"qualification-request-denied","authority":"none"}\n');
  assert.equal(result.stderr.includes(secret), false);
}

test('help and both strict command parsers need no repository or source reader', () => {
  let stdout = '';
  assert.equal(qualificationMain(['--help'], { source: () => { throw new Error('source must not run'); }, stdout: s => { stdout += s; } }), 0);
  assert.match(stdout, /native\|supervised/); assert.match(stdout, /verify/);
  for (const command of ['native', 'supervised']) {
    const parsed = parseQualificationArgs([command, '--workspace', '/repo', '--input', '/private/input.json', '--build', '/private/build.json',
      '--created-at', '1', '--expires-at', '3', '--output', '/private/report.json', '--review', '/private/review.json']);
    assert.notEqual(parsed, 'help');
    if (parsed !== 'help') assert.equal(parsed.command, command);
  }
  assert.deepEqual(parseQualificationArgs(['verify', '--workspace', '/repo', '--input', '/private/report.json', '--expected-source', source]),
    { command: 'verify', workspace: '/repo', input: '/private/report.json', expectedSource: source });
});
test('real build bytes create an honest partial report with exact original input digest and bounded verification', () => {
  const f = fixture();
  try {
    const original = readFileSync(f.input, 'utf8');
    const result = f.invoke(); assert.equal(result.code, 0); assert.equal(result.stderr, '');
    const report = f.report(); assert.equal(report.outcome, 'partial'); assert.equal(report.authority, 'none');
    assert.equal(report.review.classification, 'unavailable'); assert.equal(report.fixture, true);
    assert.equal(report.input.digest, textHash(original)); assert.equal(report.input.encoding, 'utf8-json');
    assert.equal(report.build.artifacts[0]?.sha256, textHash(readFileSync(f.artifact)));
    assert.equal(lstatSync(f.output).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(result.stdout), { status: 'created', digest: report.digest, source, outcome: 'partial', authority: 'none', scope: 'historical-evidence-consistency' });
    const verified = f.invoke(f.verify()); assert.equal(verified.code, 0); assert.equal(verified.stderr, '');
    assert.equal(JSON.parse(verified.stdout).status, 'historical-evidence-only');
    assert.equal(JSON.parse(verified.stdout).integrity, 'consistent');
    assert.equal(JSON.parse(verified.stdout).authority, 'none');
    assert.ok(verified.stdout.length < 4096);
    denied(f.invoke()); assert.equal(readFileSync(f.input, 'utf8'), original);
  } finally { f.close(); }
});
test('native command imports the actual minimal NativeRunError shape without invoking a provider', () => {
  const f = fixture();
  try {
    f.put(f.input, native(f.root)); assert.equal(f.invoke(f.args('native')).code, 0);
    const report = f.report(); assert.equal(report.outcome, 'partial'); assert.equal(report.execution.status, 'failed');
    if (report.native.classification === 'unavailable') assert.fail('expected imported native projection');
    else assert.equal(report.native.failure?.code, 'native-provider-quota');
    assert.equal(f.invoke(f.verify()).code, 0);
  } finally { f.close(); }
});
test('unknown duplicate missing extra control and oversized arguments are denied safely', () => {
  const f = fixture();
  try {
    for (const argv of [[], ['--help', 'extra'], ['unknown'], [...f.args(), '--unknown', secret], [...f.args(), '--input', secret],
      [...f.args(), '--review'], [...f.args(), 'extra'], [...f.args(), '--review', '/private/\u007f.json'],
      [...f.args(), '--review', 'x'.repeat(4097)], [...f.verify(), '--build', f.buildPath],
      [...f.args(), '--expected-source', source], f.args().slice(0, -2), ['verify', '--workspace', f.root]]) denied(f.invoke(argv));
    assert.equal(existsSync(f.output), false);
  } finally { f.close(); }
});
test('unsafe reversed future and expired timestamps fail before output', () => {
  const f = fixture();
  try {
    for (const [created, expires] of [['1900.5', '3000'], ['0', '3000'], ['-1', '3000'], ['01900', '3000'],
      ['9007199254740992', '9007199254740993'], ['1900', '1800'], ['2001', '3000'], ['1000', '2000'], ['1e3', '3000']]) {
      const args = f.args(); args[8] = created!; args[10] = expires!; denied(f.invoke(args));
    }
    assert.equal(existsSync(f.output), false);
  } finally { f.close(); }
});
test('malformed evidence, build/source mismatch and incorrect actual artifact hashes deny without leakage', () => {
  const f = fixture();
  try {
    writeFileSync(f.input, '{' + secret); denied(f.invoke());
    f.put(f.input, { ...supervised(), source: historical }); denied(f.invoke());
    f.put(f.input, supervised()); f.put(f.buildPath, { ...f.build, source: historical }); denied(f.invoke());
    for (const sha256 of [historical, '0'.repeat(64)]) {
      f.put(f.buildPath, { ...f.build, artifacts: [{ id: 'library', path: f.artifact, sha256 }] }); denied(f.invoke());
    }
    f.put(f.buildPath, f.build); writeFileSync(f.artifact, 'changed bytes'); denied(f.invoke());
    assert.equal(existsSync(f.output), false);
  } finally { f.close(); }
});
test('symlink hardlink directory noncanonical and credential build pins are rejected', () => {
  const f = fixture();
  try {
    const sym = join(f.root, 'linked.js'), hard = join(f.root, 'hard.js');
    symlinkSync(f.artifact, sym);
    for (const path of [sym, f.root, f.root + '/./library.js', join(f.root, '.env')]) {
      f.put(f.buildPath, { ...f.build, artifacts: [{ id: 'library', path, sha256: f.build.artifacts[0]!.sha256 }] }); denied(f.invoke());
    }
    linkSync(f.artifact, hard); f.put(f.buildPath, f.build); denied(f.invoke());
    assert.equal(existsSync(f.output), false);
  } finally { f.close(); }
});
test('private JSON requires outside canonical owner 0600 file and immediate 0700 parent', () => {
  const f = fixture();
  try {
    const args = f.args(), inside = join(f.root, 'input.json'); f.put(inside, supervised());
    args[4] = inside; denied(f.invoke(args));
    args[4] = f.privateDir + '/./input.json'; denied(f.invoke(args));
    const sym = join(f.privateDir, 'sym.json'); symlinkSync(f.input, sym); args[4] = sym; denied(f.invoke(args));
    const hard = join(f.privateDir, 'hard.json'); linkSync(f.input, hard); denied(f.invoke()); unlinkSync(hard);
    chmodSync(f.input, 0o644); denied(f.invoke()); chmodSync(f.input, 0o600);
    chmodSync(f.privateDir, 0o755); denied(f.invoke()); chmodSync(f.privateDir, 0o700);
    chmodSync(f.base, 0o777); denied(f.invoke()); chmodSync(f.base, 0o700);
    writeFileSync(f.input, Buffer.from([0xff, 0xfe])); denied(f.invoke());
    assert.equal(existsSync(f.output), false);
  } finally { f.close(); }
});
test('JSON and artifact byte limits reject sparse oversized files without unbounded reads', () => {
  const f = fixture();
  try {
    truncateSync(f.input, maxQualificationBytes + 1); denied(f.invoke()); f.put(f.input, supervised());
    truncateSync(f.artifact, maxQualificationArtifactBytes + 1); denied(f.invoke());
    assert.equal(existsSync(f.output), false);
  } finally { f.close(); }
});
test('aggregate artifact bytes are bounded even when each file and actual digest is valid', () => {
  const f = fixture();
  try {
    const size = maxQualificationArtifactBytes, sha256 = textHash(Buffer.alloc(size));
    const count = Math.floor(maxQualificationArtifactTotalBytes / size) + 1;
    const artifacts = Array.from({ length: count }, (_, index) => {
      const path = join(f.root, `sparse-${index}.bin`);
      writeFileSync(path, '', { mode: 0o600 }); truncateSync(path, size);
      return { id: `pin-${index}`, path, sha256 };
    });
    f.put(f.buildPath, { ...f.build, artifacts }); denied(f.invoke());
    assert.equal(existsSync(f.output), false);
  } finally { f.close(); }
});
test('source drift during reads denies; drift after writing leaves only unaccepted evidence', () => {
  const f = fixture();
  try {
    let first = true;
    denied(f.invoke(f.args(), { source: () => { if (first) { first = false; return source; } return historical; } }));
    assert.equal(existsSync(f.output), false);
    denied(f.invoke(f.args(), { source: () => existsSync(f.output) && lstatSync(f.output).size > 0 ? historical : source }));
    assert.ok(lstatSync(f.output).size > 0);
  } finally { f.close(); }
});
test('build mutation after report writing is caught before output acceptance', () => {
  const f = fixture();
  try {
    denied(f.invoke(f.args(), { source: () => {
      if (existsSync(f.output) && lstatSync(f.output).size > 0) writeFileSync(f.artifact, 'mutated after report written');
      return source;
    } }));
    assert.ok(lstatSync(f.output).size > 0);
  } finally { f.close(); }
});
test('verify defaults to current source; historical override still requires current source stability and no scratch pins', () => {
  const f = fixture();
  try {
    assert.equal(f.invoke().code, 0); rmSync(f.artifact);
    denied(f.invoke(f.verify(), { source: () => historical }));
    const args = [...f.verify(), '--expected-source', source];
    assert.equal(f.invoke(args, { source: () => historical }).code, 0);
    let initial = true;
    denied(f.invoke(args, { source: () => { if (initial) { initial = false; return historical; } return source; } }));
    denied(f.invoke(args, { clock: () => 3000 }));
  } finally { f.close(); }
});
test('tampered malformed oversized or public reports and malformed optional reviews deny safely', () => {
  const f = fixture();
  try {
    const review = join(f.privateDir, 'review.json'); f.put(review, { secret });
    denied(f.invoke([...f.args(), '--review', review])); assert.equal(existsSync(f.output), false);
    assert.equal(f.invoke().code, 0); const report = f.report();
    f.put(f.output, { ...report, source: historical }); denied(f.invoke(f.verify()));
    writeFileSync(f.output, '{' + secret); denied(f.invoke(f.verify()));
    truncateSync(f.output, maxQualificationBytes + 1); denied(f.invoke(f.verify()));
    f.put(f.output, report); chmodSync(f.output, 0o644); denied(f.invoke(f.verify()));
  } finally { f.close(); }
});
test('exclusive outputs reject symlinks and unsafe destinations and never echo thrown errors', () => {
  const f = fixture();
  try {
    symlinkSync(f.input, f.output); const original = readFileSync(f.input, 'utf8'); denied(f.invoke());
    assert.equal(readFileSync(f.input, 'utf8'), original); unlinkSync(f.output);
    const args = f.args(); args[12] = join(f.root, 'report.json'); denied(f.invoke(args));
    args[12] = f.privateDir + '/./report.json'; denied(f.invoke(args));
    denied(f.invoke(f.args(), { source: () => { throw new Error(secret + f.input); } }));
    assert.equal(existsSync(f.output), false);
  } finally { f.close(); }
});
