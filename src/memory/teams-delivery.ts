import { bytes, dataSnapshot, object, serialize } from '../context-engine/validation.js';
import { natural, sha, slug } from './run-recording.js';
import { WeeklySchedule } from './weekly-schedule.js';
import { shape } from './weekly-delivery-envelope.js';
import { maxTeamsBytes, teamsBudget, teamsConfig, teamsEntry, teamsEnvelope, teamsPayload } from './teams-envelope.js';
import { assertTeamsAdapter, sendTeamsEnvelope } from './teams-transport.js';
import type { TeamsConfig, TeamsEntry } from './teams-envelope.js';
import type { OwnerTeamsAdapter } from './teams-transport.js';

export interface TeamsDeliveryOptions {
  readonly enabled: boolean; readonly destinationId: string | null; readonly endpointBinding: string | null;
  readonly consent: boolean; readonly maxBytes?: number;
}
export interface TeamsAuthorization { readonly destinationId: string; readonly endpointBinding: string; readonly consent: true }
export interface TeamsRecovery {
  readonly status: 'disabled' | 'pending-configuration' | 'no-summary' | 'enqueued' | 'existing'; readonly entry?: TeamsEntry;
}
export interface TeamsDispatch {
  readonly status: 'disabled' | 'pending-configuration' | 'pending' | 'accepted' | 'uncertain'; readonly entry?: TeamsEntry;
}
const prefix = 'weekly-teams:';
/** Destination-only configuration. No email recipient and no schedule reconfiguration. */
export class TeamsDelivery {
  readonly schedule: WeeklySchedule;
  constructor(directory: string, root: string, clock: () => number = Date.now) {
    this.schedule = new WeeklySchedule(directory, root, clock);
  }
  #config(): TeamsConfig {
    const store = this.schedule.store;
    const stored = store.get('weekly-teams-config');
    return teamsConfig(stored === undefined ? { schemaVersion: 1, projectId: store.projectId,
      originalRoot: store.originalRoot, enabled: false, destinationId: null, endpointBinding: null,
      consent: false, maxBytes: maxTeamsBytes } : stored, store.projectId, store.originalRoot);
  }
  #entry(id: string): TeamsEntry {
    sha(id);
    const store = this.schedule.store, entry = teamsEntry(store.get(prefix + id), store.projectId, store.originalRoot);
    if (entry.envelope.id !== id) throw new Error('Teams outbox key mismatch');
    return entry;
  }
  #put(raw: TeamsEntry): TeamsEntry {
    const store = this.schedule.store, entry = teamsEntry(raw, store.projectId, store.originalRoot);
    store.put(prefix + entry.envelope.id, entry); return entry;
  }
  configure(raw: TeamsDeliveryOptions): TeamsConfig {
    const v = dataSnapshot(raw);
    object(v, ['enabled', 'destinationId', 'endpointBinding', 'consent', 'maxBytes']);
    for (const key of ['enabled', 'destinationId', 'endpointBinding', 'consent']) {
      if (!Object.hasOwn(v, key)) throw new Error('incomplete Teams configuration');
    }
    if (Object.hasOwn(v, 'maxBytes')) teamsBudget(v.maxBytes);
    return this.schedule.store.database.transaction(() => {
      const old = this.#config(), store = this.schedule.store;
      const next = teamsConfig({ ...v, schemaVersion: 1, projectId: store.projectId, originalRoot: store.originalRoot,
        maxBytes: v.maxBytes ?? old.maxBytes }, store.projectId, store.originalRoot);
      store.put('weekly-teams-config', next); return next;
    });
  }
  status() {
    const schedule = this.schedule.status();
    const config = this.schedule.store.database.transaction(() => this.#config());
    return dataSnapshot({ config, schedule, externalSending: 'explicit-trusted-owner-dispatch-only',
      status: !config.enabled || !schedule.enabled ? 'disabled' :
        config.destinationId === null ? 'pending-configuration' : 'outbox-ready' });
  }
  /** Read-only rendering of the retained summary, even without a destination. */
  preview() {
    const status = this.schedule.status(), config = this.schedule.store.database.transaction(() => this.#config());
    if (status.lastCompletedDue === null) return dataSnapshot({ status: 'no-summary' as const });
    const summary = this.schedule.result(status.lastCompletedDue);
    return dataSnapshot({ status: 'ready' as const, summaryId: summary.id, ...teamsPayload(summary, config.maxBytes) });
  }
  recoverLatest(): TeamsRecovery {
    const before = serialize(this.schedule.store.get('schedule')), status = this.schedule.status();
    if (!status.enabled) return dataSnapshot({ status: 'disabled' as const });
    const summary = status.lastCompletedDue === null ? undefined : this.schedule.result(status.lastCompletedDue);
    return this.schedule.store.database.transaction(() => {
      if (serialize(this.schedule.store.get('schedule')) !== before) throw new Error('schedule changed before Teams recovery');
      const config = this.#config();
      if (!config.enabled) return dataSnapshot({ status: 'disabled' as const });
      if (!config.consent || !config.destinationId || !config.endpointBinding) return dataSnapshot({ status: 'pending-configuration' as const });
      if (!summary) return dataSnapshot({ status: 'no-summary' as const });
      const envelope = teamsEnvelope(summary, config.destinationId, config.endpointBinding, config.maxBytes);
      const old = this.schedule.store.get(prefix + envelope.id);
      if (old !== undefined) {
        const entry = this.#entry(envelope.id);
        if (serialize(entry.envelope.summary) !== serialize(summary)) throw new Error('Teams summary identity conflict');
        return dataSnapshot({ status: 'existing' as const, entry });
      }
      return dataSnapshot({ status: 'enqueued' as const,
        entry: this.#put({ schemaVersion: 1, envelope, status: 'pending', attempts: 0 }) });
    });
  }
  tick() {
    const before = this.recoverLatest();
    if (before.status === 'disabled') return dataSnapshot({ schedule: { status: 'disabled' as const }, delivery: before });
    const schedule = this.schedule.tick();
    return dataSnapshot({ schedule, delivery: this.recoverLatest() });
  }
  outbox(raw: { readonly limit?: number; readonly after?: string } = {}): readonly TeamsEntry[] {
    const v = dataSnapshot(raw); object(v, ['limit', 'after']);
    const limit = v.limit ?? 20; natural(limit);
    if (limit < 1 || limit > 100) throw new Error('invalid Teams outbox page size');
    if (v.after !== undefined) sha(v.after);
    return this.schedule.store.database.transaction(() => {
      this.#config();
      return Object.freeze(this.schedule.store.database.db.prepare(
        'SELECT key FROM owner_values WHERE key > ? AND key < ? ORDER BY key LIMIT ?'
      ).all(prefix + (v.after ?? ''), prefix + '~', limit).map(row => {
        if (typeof row.key !== 'string') throw new Error('invalid Teams outbox key');
        return this.#entry(row.key.slice(prefix.length));
      }));
    });
  }
  /** Claim is durable before I/O. ALL unknown/non-2xx attempts remain uncertain forever. */
  async dispatch(id: string, raw: TeamsAuthorization, adapter?: OwnerTeamsAdapter): Promise<TeamsDispatch> {
    sha(id);
    const auth = dataSnapshot(raw); shape(auth, ['destinationId', 'endpointBinding', 'consent']);
    slug(auth.destinationId); sha(auth.endpointBinding);
    if (auth.consent !== true) throw new Error('explicit Teams send consent required');
    if (adapter !== undefined) assertTeamsAdapter(adapter);
    const before = serialize(this.schedule.store.get('schedule'));
    if (!this.schedule.status().enabled) return dataSnapshot({ status: 'disabled' as const });
    const claim = this.schedule.store.database.transaction(() => {
      if (serialize(this.schedule.store.get('schedule')) !== before) throw new Error('schedule changed before Teams claim');
      const config = this.#config(), entry = this.#entry(id), e = entry.envelope;
      if (!config.enabled) return { status: 'disabled' as const, entry };
      if (!config.consent || !config.destinationId || !adapter) return { status: 'pending-configuration' as const, entry };
      if (config.destinationId !== auth.destinationId || config.endpointBinding !== auth.endpointBinding ||
          e.destinationId !== auth.destinationId || e.endpointBinding !== auth.endpointBinding ||
          adapter.destinationId !== auth.destinationId || adapter.endpointBinding !== auth.endpointBinding) {
        throw new Error('Teams destination consent mismatch');
      }
      if (entry.status !== 'pending') return { status: entry.status, entry };
      if (bytes(serialize(e.payload)) > config.maxBytes) throw new Error('Teams configured payload budget exceeded');
      natural(entry.attempts + 1);
      return { status: 'claimed' as const, entry: this.#put({ ...entry, status: 'uncertain', attempts: entry.attempts + 1 }) };
    });
    if (claim.status !== 'claimed') return dataSnapshot(claim);
    const result = await sendTeamsEnvelope(adapter!, claim.entry.envelope);
    if (result.status !== 'accepted') return dataSnapshot({ status: 'uncertain' as const, entry: claim.entry });
    return this.schedule.store.database.transaction(() => {
      const current = this.#entry(id);
      if (serialize(current) !== serialize(claim.entry)) throw new Error('Teams claim changed; reconcile externally');
      const entry = this.#put({ ...current, status: 'accepted' });
      return dataSnapshot({ status: 'accepted' as const, entry });
    });
  }
  close(): void { this.schedule.close(); }
}
