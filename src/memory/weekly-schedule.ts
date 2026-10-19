import { dataSnapshot, freeze, object, serialize } from '../context-engine/validation.js';
import { natural, OwnerStore } from './run-recording.js';
import { weeklyDue } from './weekly-due.js';
import { WeeklyService } from './weekly-service.js';
import { createWeeklyAccumulator, validateWeeklySummary } from './weekly-summary.js';
import type { Summary, WeeklyOptions } from './weekly-summary.js';

interface ScheduleState {
  readonly schemaVersion: 1; readonly projectId: string; readonly originalRoot: string;
  readonly enabled: boolean; readonly activatedAt: number; readonly lastCompletedDue: number | null;
  readonly lowerExclusive: number; readonly executionSelection: 'authenticated' | 'all'; readonly maxBytes: number;
}
export interface ScheduleStatus {
  readonly enabled: boolean; readonly projectId: string; readonly originalRoot: string;
  readonly timeZone: 'Asia/Kolkata'; readonly lowerExclusive: number;
  readonly activatedAt: number | null; readonly lastCompletedDue: number | null;
  readonly dueAt: number | null; readonly nextDueAt: number | null;
}
export interface TickResult { readonly status: 'disabled' | 'not-due' | 'committed'; readonly summary?: Summary }
/** No daemon, delivery, provider or OS job. Every tick is an explicit local owner call. */
export class WeeklySchedule {
  readonly store: OwnerStore;
  readonly #service: WeeklyService;
  readonly #clock: () => number;
  constructor(directory: string, root: string, clock: () => number = Date.now) {
    this.store = new OwnerStore(directory, root); this.#clock = clock;
    try { this.#service = new WeeklyService(directory, root); }
    catch (error) { this.store.close(); throw error; }
  }
  #state(): ScheduleState | undefined {
    const value = this.store.get('schedule');
    if (value === undefined) return undefined;
    object(value, ['schemaVersion', 'projectId', 'originalRoot', 'enabled', 'activatedAt', 'lastCompletedDue', 'lowerExclusive', 'executionSelection', 'maxBytes']);
    if (value.schemaVersion !== 1 || value.projectId !== this.store.projectId || value.originalRoot !== this.store.originalRoot || typeof value.enabled !== 'boolean') throw new Error('invalid schedule scope or state');
    natural(value.activatedAt); natural(value.lowerExclusive); natural(value.maxBytes);
    if (value.lastCompletedDue !== null) natural(value.lastCompletedDue);
    if (value.executionSelection !== 'authenticated' && value.executionSelection !== 'all') throw new Error('invalid schedule selection');
    const state = value as unknown as ScheduleState;
    weeklyDue(state.activatedAt, state.activatedAt);
    if (state.lastCompletedDue !== null) {
      weeklyDue(state.lastCompletedDue, state.activatedAt, state.lastCompletedDue);
      const summary = this.#result(state.lastCompletedDue);
      if (summary.upperInclusive !== state.lowerExclusive) throw new Error('schedule cursor/result mismatch');
    } else if (state.lowerExclusive !== 0) throw new Error('schedule cursor without result');
    createWeeklyAccumulator({ projectId: state.projectId, originalRoot: state.originalRoot,
      dueAt: state.activatedAt, lowerExclusive: state.lowerExclusive, upperInclusive: state.lowerExclusive },
    { executionSelection: state.executionSelection, maxBytes: state.maxBytes });
    return state;
  }
  #result(dueAt: number): Summary {
    natural(dueAt);
    const result = validateWeeklySummary(this.store.get(`summary:${dueAt}`));
    if (result.projectId !== this.store.projectId || result.originalRoot !== this.store.originalRoot || result.dueAt !== dueAt) throw new Error('persisted summary scope mismatch');
    return result;
  }
  /** Enable explicitly. Reconfiguration preserves activation, history and cursor. */
  configure(raw: WeeklyOptions = {}): ScheduleStatus {
    const options = dataSnapshot(raw); object(options, ['executionSelection', 'maxBytes']);
    return this.store.database.transaction(() => {
      const old = this.#state(), now = this.#clock();
      weeklyDue(now, now);
      const normalized = createWeeklyAccumulator({ projectId: this.store.projectId, originalRoot: this.store.originalRoot,
        dueAt: now, lowerExclusive: 0, upperInclusive: 0 }, {
        executionSelection: options.executionSelection ?? old?.executionSelection ?? 'authenticated',
        maxBytes: options.maxBytes ?? old?.maxBytes ?? 8192
      });
      const state: ScheduleState = { schemaVersion: 1, projectId: this.store.projectId, originalRoot: this.store.originalRoot,
        enabled: true, activatedAt: old?.activatedAt ?? now, lastCompletedDue: old?.lastCompletedDue ?? null,
        lowerExclusive: old?.lowerExclusive ?? 0, executionSelection: normalized.executionSelection, maxBytes: normalized.maxBytes };
      this.store.put('schedule', state);
      return this.#status(state, now);
    });
  }
  #status(state: ScheduleState | undefined, now: number): ScheduleStatus {
    weeklyDue(now, now);
    const due = state?.enabled ? weeklyDue(now, state.activatedAt, state.lastCompletedDue) : undefined;
    return freeze({ enabled: state?.enabled ?? false, projectId: this.store.projectId, originalRoot: this.store.originalRoot,
      timeZone: 'Asia/Kolkata', lowerExclusive: state?.lowerExclusive ?? 0,
      activatedAt: state?.activatedAt ?? null, lastCompletedDue: state?.lastCompletedDue ?? null,
      dueAt: due?.dueAt ?? null, nextDueAt: due?.nextDueAt ?? null });
  }
  status(): ScheduleStatus {
    return this.store.database.transaction(() => this.#status(this.#state(), this.#clock()));
  }
  disable(): ScheduleStatus {
    return this.store.database.transaction(() => {
      const old = this.#state(), state = old ? { ...old, enabled: false } : undefined;
      if (state) this.store.put('schedule', state);
      return this.#status(state, this.#clock());
    });
  }
  tick(): TickResult {
    return this.store.database.transaction(() => {
      const state = this.#state(), now = this.#clock();
      weeklyDue(now, now);
      if (!state?.enabled) return freeze({ status: 'disabled' as const });
      const dueAt = weeklyDue(now, state.activatedAt, state.lastCompletedDue).dueAt;
      if (dueAt === null) return freeze({ status: 'not-due' as const });
      const upperInclusive = this.#service.watermark(state.lowerExclusive);
      const summary = validateWeeklySummary(this.#service.generate({ dueAt, lowerExclusive: state.lowerExclusive, upperInclusive,
        executionSelection: state.executionSelection, maxBytes: state.maxBytes }));
      if (summary.projectId !== state.projectId || summary.originalRoot !== state.originalRoot || summary.dueAt !== dueAt ||
          summary.lowerExclusive !== state.lowerExclusive || summary.upperInclusive !== upperInclusive ||
          summary.executionSelection !== state.executionSelection || summary.maxBytes !== state.maxBytes) throw new Error('generated summary scope drift');
      if (this.store.get(`summary:${dueAt}`) !== undefined) throw new Error('unexpected preexisting schedule result');
      if (serialize(this.#state()) !== serialize(state)) throw new Error('schedule changed during generation');
      this.store.put(`summary:${dueAt}`, summary);
      this.store.put('schedule', { ...state, lastCompletedDue: dueAt, lowerExclusive: upperInclusive });
      return freeze({ status: 'committed' as const, summary });
    });
  }
  /** Repair interrupted stdout by reading committed bytes; never regenerate an old week. */
  result(dueAt?: number): Summary {
    return this.store.database.transaction(() => {
      const state = this.#state(), selected = dueAt ?? state?.lastCompletedDue;
      if (selected === null || selected === undefined) throw new Error('no committed weekly result');
      return this.#result(selected);
    });
  }
  close(): void { this.#service.close(); this.store.close(); }
}
