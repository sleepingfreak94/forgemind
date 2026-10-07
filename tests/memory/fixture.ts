import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeProject } from '../../src/project-workflow/project.js';
import { ProjectMemory } from '../../src/memory/service.js';
import { scanDocuments } from '../../src/memory/documents.js';
import type { MemoryInput } from '../../src/memory/contracts.js';

export function fixture(projectId = 'project-a') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'forgemind-memory-'))), root = join(base, 'repo'), directory = join(base, 'state');
  mkdirSync(root); let now = 1000;
  initializeProject(root, { schemaVersion: 1, projectId, name: projectId, documents: { prd: 'docs/PRD.md', srs: 'docs/SRS.md', adrs: 'docs/adr' },
    preferences: { askAt: 'project', draftPr: false, evidence: 'text', planReview: 'approve' } }, true);
  const path = 'docs/adr/ADR-0001-storage.md';
  writeFileSync(join(root, path), '# Local storage\n\nStatus: Accepted\n\nUse SQLite for durable project memory. FTS5 handles keyword retrieval.\n');
  let memory = new ProjectMemory(directory, root, () => now);
  const input = (text = 'Use SQLite transactions for durable decisions.'): MemoryInput => {
    const doc = scanDocuments(root, projectId).find(doc => doc.path === path)!;
    return { kind: 'decision', title: 'Storage decision', text, sources: [{ path: doc.path, sha256: doc.sha256, status: doc.status }] };
  };
  return { base, root, directory, projectId, path, input, get memory() { return memory; },
    setNow(value: number) { now = value; }, reopen() { memory.close(); memory = new ProjectMemory(directory, root, () => now); },
    dispose() { memory.close(); rmSync(base, { recursive: true, force: true }); } };
}
