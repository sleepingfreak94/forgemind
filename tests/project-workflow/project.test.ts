import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeProject, readProject, documentStatus, profilePath } from '../../src/project-workflow/project.js';
import { fixture } from './fixture.js';

test('new project stores preferences and draft document scaffolds without accepted requirements', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'forgemind-project-'))); t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = fixture(), result = initializeProject(root, f.profile, true);
  assert.equal(result.created.length, 4); assert.deepEqual(readProject(root), f.profile);
  assert.ok(documentStatus(root, f.profile).every(item => item.exists));
  assert.match(readFileSync(join(root, f.profile.documents.srs), 'utf8'), /Draft/);
  assert.match(readFileSync(join(root, f.profile.documents.adrs, 'ADR-template.md'), 'utf8'), /Proposed/);
  assert.throws(() => initializeProject(root, { ...f.profile, projectId: 'another' }, true), /already registered/);
  assert.equal(readProject(root).projectId, f.profile.projectId);
});
test('existing PRD/SRS/ADR templates are preserved exactly, and another project has separate choices', t => {
  const roots = ['a', 'b'].map(name => realpathSync(mkdtempSync(join(tmpdir(), `forgemind-${name}-`)))); t.after(() => roots.forEach(root => rmSync(root, { recursive: true, force: true })));
  const f = fixture(), root = roots[0]!; mkdirSync(join(root, 'docs', 'adr'), { recursive: true });
  writeFileSync(join(root, 'docs', 'PRD.md'), 'Existing requirements'); writeFileSync(join(root, 'docs', 'adr', 'ADR-template.md'), 'Existing decisions');
  const result = initializeProject(root, f.profile, true);
  assert.equal(result.preserved.length, 2); assert.equal(readFileSync(join(root, 'docs', 'PRD.md'), 'utf8'), 'Existing requirements');
  assert.equal(readFileSync(join(root, 'docs', 'adr', 'ADR-template.md'), 'utf8'), 'Existing decisions');
  initializeProject(roots[1]!, { ...f.profile, projectId: 'project-b', preferences: { askAt: 'task', draftPr: false, evidence: 'video', planReview: 'show' } });
  assert.equal(readProject(root).preferences.evidence, 'text'); assert.equal(readProject(roots[1]!).preferences.evidence, 'video');
});
test('links and malformed profiles cannot redirect onboarding writes', t => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'forgemind-profile-links-'))); t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'repo'), outside = join(base, 'outside'); mkdirSync(root); mkdirSync(outside);
  symlinkSync(outside, join(root, 'docs'), 'junction'); const f = fixture();
  assert.throws(() => initializeProject(root, f.profile, true), /linked/);
  assert.throws(() => initializeProject(root, { ...f.profile, documents: { ...f.profile.documents, srs: '../secret' } }, false));
  mkdirSync(join(root, 'config')); writeFileSync(join(root, profilePath), '{"schemaVersion":99}');
  assert.throws(() => readProject(root));
});

test('invalid existing document types are checked before any scaffold writes', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'forgemind-scaffold-type-'))); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs', 'SRS.md'), { recursive: true });
  assert.throws(() => initializeProject(root, fixture().profile, true), /not a file/);
  assert.equal(existsSync(join(root, 'docs', 'PRD.md')), false); assert.equal(existsSync(join(root, profilePath)), false);
});
