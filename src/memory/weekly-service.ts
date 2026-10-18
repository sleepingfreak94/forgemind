import { dataSnapshot, object } from '../context-engine/validation.js';
import { readProject } from '../project-workflow/project.js';
import { canonicalWorkspace } from './documents.js';
import { RunHistory } from './run-history.js';
import { natural } from './run-recording.js';
import { appendWeeklyRecords, createWeeklyAccumulator, finishWeeklySummary, validateWeeklySummary } from './weekly-summary.js';
import type { Summary, WeeklyOptions } from './weekly-summary.js';

export interface GenerateWeeklyOptions extends WeeklyOptions {
  readonly dueAt: number; readonly lowerExclusive: number;
  readonly upperInclusive?: number; readonly pageSize?: number;
}
/** Reads actual history. Watermarks are sequence bounds, never fabricated records. */
export class WeeklyService {
  readonly projectId: string;
  readonly originalRoot: string;
  readonly #history: RunHistory;
  constructor(directory: string, originalRoot: string) {
    this.originalRoot = canonicalWorkspace(originalRoot);
    this.projectId = readProject(this.originalRoot).projectId;
    this.#history = new RunHistory(directory, this.originalRoot);
  }
  #scope(): void {
    if (readProject(canonicalWorkspace(this.originalRoot)).projectId !== this.projectId) throw new Error('weekly service scope changed');
  }
  watermark(lowerExclusive = 0): number {
    this.#scope(); natural(lowerExclusive);
    const last = this.#history.list({ afterSequence: 0, limit: 1, order: 'desc' })[0];
    return Math.max(lowerExclusive, last?.sequence ?? 0);
  }
  generate(raw: GenerateWeeklyOptions): Summary {
    this.#scope();
    const input = dataSnapshot(raw);
    object(input, ['dueAt', 'lowerExclusive', 'upperInclusive', 'pageSize', 'executionSelection', 'maxBytes']);
    natural(input.lowerExclusive); natural(input.dueAt);
    const pageSize = input.pageSize ?? 100;
    natural(pageSize); if (pageSize < 1 || pageSize > 100) throw new Error('invalid weekly page size');
    const upperInclusive = input.upperInclusive ?? this.watermark(input.lowerExclusive);
    natural(upperInclusive);
    const options: WeeklyOptions = { ...(input.executionSelection === undefined ? {} : { executionSelection: input.executionSelection }),
      ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }) };
    let state = createWeeklyAccumulator({ projectId: this.projectId, originalRoot: this.originalRoot,
      dueAt: input.dueAt, lowerExclusive: input.lowerExclusive, upperInclusive }, options);
    while (state.cursor < upperInclusive) {
      this.#scope();
      const rows = this.#history.list({ afterSequence: state.cursor, throughSequence: upperInclusive, limit: pageSize, order: 'asc' });
      const last = rows.at(-1);
      // Only an actual empty bounded read proves that the remaining revoked gap is exhausted.
      state = appendWeeklyRecords(state, rows, last ? last.sequence : upperInclusive);
    }
    this.#scope();
    return validateWeeklySummary(finishWeeklySummary(state));
  }
  close(): void { this.#history.close(); }
}
