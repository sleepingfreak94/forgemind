import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  linkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEdits } from "../../src/live-workflow/edits.js";
import { sha256 } from "../../src/live-workflow/validation.js";
test("edit application validates all preimages before any write and limits host to granted paths", () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "fm-edit-")));
  try {
    writeFileSync(join(d, "one"), "before");
    let calls = 0;
    const authority = {
      reserve: () => {
        calls++;
        return { check: () => {}, finish: () => {} };
      },
    };
    assert.throws(() =>
      applyEdits(
        d,
        "source",
        ["one", "two"],
        {
          summary: "x",
          edits: [
            { path: "one", beforeSha256: sha256("before"), content: "after" },
            { path: "two", beforeSha256: sha256("missing"), content: "new" },
          ],
        },
        authority,
        () => {},
      ),
    );
    assert.equal(readFileSync(join(d, "one"), "utf8"), "before");
    assert.equal(calls, 0);
    applyEdits(
      d,
      "source",
      ["one"],
      {
        summary: "x",
        edits: [
          { path: "one", beforeSha256: sha256("before"), content: "after" },
        ],
      },
      authority,
      () => {},
    );
    assert.equal(readFileSync(join(d, "one"), "utf8"), "after");
    assert.equal(calls, 1);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

function replacementFixture(content: string | Buffer = 'alpha\r\nbeta 🙂\r\ngamma\r\n') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fm-replace-')));
  const path = join(root, 'source.txt');
  writeFileSync(path, content, { mode: 0o640 });
  let reservations = 0;
  const envelopes: unknown[] = [];
  const authority = { reserve: (envelope: unknown) => {
    reservations++; envelopes.push(envelope);
    return { check: () => {}, finish: () => {} };
  } };
  const edit = (replacements: unknown, extra: object = {}) => ({
    path: 'source.txt', beforeSha256: sha256(content), format: 'text-replacements-v1', replacements, ...extra,
  });
  const apply = (edits: unknown[]) => applyEdits(root, 'source', ['source.txt', 'second.txt'],
    { summary: 'Change exact text', edits }, authority, () => {});
  return { root, path, edit, apply, envelopes, reservations: () => reservations,
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('compact edits preserve untouched UTF-8 bytes, CRLF and mode; anchors use the original', () => {
  const f = replacementFixture();
  try {
    const result = f.apply([f.edit([
      { before: 'beta 🙂', after: 'alpha ✨' },
      { before: 'alpha\r\n', after: 'first\r\n' },
    ])]);
    assert.deepEqual(readFileSync(f.path), Buffer.from('first\r\nalpha ✨\r\ngamma\r\n'));
    assert.equal(statSync(f.path).mode & 0o777, 0o640);
    assert.equal(f.reservations(), 1);
    assert.equal(result.edits[0]!.content, 'first\r\nalpha ✨\r\ngamma\r\n');
    assert.deepEqual(f.envelopes, [{ kind: 'files.apply', source: 'source', detail: { edits: [{
      path: 'source.txt', before: sha256('alpha\r\nbeta 🙂\r\ngamma\r\n'),
      after: sha256('first\r\nalpha ✨\r\ngamma\r\n'),
    }] } }]);
  } finally { f.cleanup(); }
});

for (const [name, content, replacements, extra] of [
  ['stale digest', 'alpha', [{ before: 'alpha', after: 'after' }], { beforeSha256: sha256('stale') }],
  ['missing anchor', 'alpha', [{ before: 'missing', after: 'after' }], {}],
  ['ambiguous anchor', 'alpha alpha', [{ before: 'alpha', after: 'after' }], {}],
  ['self-overlapping matches', 'aaa', [{ before: 'aa', after: 'after' }], {}],
  ['overlapping operations', 'abcdef', [{ before: 'abc', after: 'x' }, { before: 'bcde', after: 'y' }], {}],
  ['duplicate operations', 'alpha', [{ before: 'alpha', after: 'x' }, { before: 'alpha', after: 'y' }], {}],
  ['empty anchor', 'alpha', [{ before: '', after: 'after' }], {}],
  ['no-op', 'alpha', [{ before: 'alpha', after: 'alpha' }], {}],
  ['unknown operation key', 'alpha', [{ before: 'alpha', after: 'after', regex: true }], {}],
  ['mixed representations', 'alpha', [{ before: 'alpha', after: 'after' }], { content: 'after' }],
  ['unknown format', 'alpha', [{ before: 'alpha', after: 'after' }], { format: 'fuzzy' }],
  ['unauthorized path', 'alpha', [{ before: 'alpha', after: 'after' }], { path: 'private.txt' }],
  ['missing preimage', 'alpha', [{ before: 'alpha', after: 'after' }], { beforeSha256: null }],
  ['NUL replacement', 'alpha', [{ before: 'alpha', after: 'after\0' }], {}],
  ['malformed Unicode', 'alpha', [{ before: 'alpha', after: '\ud800' }], {}],
  ['no operations', 'alpha', [], {}],
  ['too many operations', 'alpha', Array.from({ length: 101 }, () => ({ before: 'alpha', after: 'after' })), {}],
  ['oversized fragment', 'alpha', [{ before: 'alpha', after: 'x'.repeat(262145) }], {}],
  ['oversized result', 'a' + 'x'.repeat(262143), [{ before: 'a', after: 'aa' }], {}],
  ['invalid UTF-8 original', Buffer.from([0x61, 0xc3, 0x28]), [{ before: 'a', after: 'after' }], {}],
  ['binary original', Buffer.from('alpha\0'), [{ before: 'alpha', after: 'after' }], {}],
] as const) test('compact edits reject ' + name + ' before writes or reservation', () => {
  const f = replacementFixture(content);
  try {
    const original = readFileSync(f.path);
    assert.throws(() => f.apply([f.edit(replacements, extra)]));
    assert.deepEqual(readFileSync(f.path), original);
    assert.equal(f.reservations(), 0);
  } finally { f.cleanup(); }
});

test('compact batch validates every file and combined payload before the first write', () => {
  const f = replacementFixture('alpha');
  try {
    writeFileSync(join(f.root, 'second.txt'), 'beta');
    assert.throws(() => f.apply([f.edit([{ before: 'alpha', after: 'after' }]), {
      path: 'second.txt', beforeSha256: sha256('beta'), format: 'text-replacements-v1',
      replacements: [{ before: 'missing', after: 'after' }],
    }]));
    assert.equal(readFileSync(f.path, 'utf8'), 'alpha');
    assert.equal(readFileSync(join(f.root, 'second.txt'), 'utf8'), 'beta');
    assert.equal(f.reservations(), 0);
    const big = 'x'.repeat(262144);
    assert.throws(() => f.apply([f.edit(Array.from({ length: 5 }, () => ({ before: 'alpha', after: big })))]));
    assert.equal(f.reservations(), 0);
  } finally { f.cleanup(); }
});

test('compact text deletion uses an exact nonempty anchor', () => {
  const f = replacementFixture('alpha');
  try {
    f.apply([f.edit([{ before: 'alpha', after: '' }])]);
    assert.equal(readFileSync(f.path, 'utf8'), '');
  } finally { f.cleanup(); }
});

for (const kind of ['symlink', 'hardlink'] as const) test('compact edits retain ' + kind + ' denial', () => {
  const f = replacementFixture('alpha');
  try {
    const other = join(f.root, 'linked.txt');
    if (kind === 'symlink') symlinkSync(f.path, other); else linkSync(f.path, other);
    assert.throws(() => applyEdits(f.root, 'source', ['linked.txt'], {
      summary: 'Denied linked edit', edits: [{ ...f.edit([{ before: 'alpha', after: 'after' }]), path: 'linked.txt' }],
    }, { reserve: () => { throw Error('Must not reserve'); } }, () => {}));
    assert.equal(readFileSync(f.path, 'utf8'), 'alpha');
  } finally { f.cleanup(); }
});

test('compact edits retain the source recheck after authority reservation', () => {
  const f = replacementFixture('alpha');
  try {
    let checks = 0;
    assert.throws(() => applyEdits(f.root, 'source', ['source.txt'], {
      summary: 'Concurrent edit', edits: [f.edit([{ before: 'alpha', after: 'after' }])],
    }, { reserve: () => ({ check: () => {
      if (++checks === 1) writeFileSync(f.path, 'concurrent change');
    }, finish: () => {} }) }, () => {}), /Source changed/);
    assert.equal(readFileSync(f.path, 'utf8'), 'concurrent change');
  } finally { f.cleanup(); }
});

test('compact edits do not write when authority denies the resolved batch', () => {
  const f = replacementFixture('alpha');
  try {
    assert.throws(() => applyEdits(f.root, 'source', ['source.txt'], {
      summary: 'Denied edit', edits: [f.edit([{ before: 'alpha', after: 'after' }])],
    }, { reserve: () => { throw Error('Policy denied'); } }, () => {}), /Policy denied/);
    assert.equal(readFileSync(f.path, 'utf8'), 'alpha');
  } finally { f.cleanup(); }
});

test('mixed batch rejects deletion of an absent file before any write or reservation', () => {
  const f = replacementFixture('alpha');
  try {
    assert.throws(() => f.apply([
      f.edit([{ before: 'alpha', after: 'after' }]),
      { path: 'second.txt', beforeSha256: null, content: null },
    ]), /Cannot delete absent source/);
    assert.equal(readFileSync(f.path, 'utf8'), 'alpha');
    assert.equal(existsSync(join(f.root, 'second.txt')), false);
    assert.equal(f.reservations(), 0);
  } finally { f.cleanup(); }
});

test('legacy creation and existing-file deletion remain supported', () => {
  const f = replacementFixture('alpha');
  try {
    f.apply([
      { path: 'source.txt', beforeSha256: sha256('alpha'), content: null },
      { path: 'second.txt', beforeSha256: null, content: 'created' },
    ]);
    assert.equal(existsSync(f.path), false);
    assert.equal(readFileSync(join(f.root, 'second.txt'), 'utf8'), 'created');
    assert.equal(f.reservations(), 1);
  } finally { f.cleanup(); }
});
