import { bytes, dataSnapshot, object, serialize } from '../context-engine/validation.js';
import { natural, sha } from './run-recording.js';
import { WeeklySchedule } from './weekly-schedule.js';
import { budget, deliveryConfig, envelope, maxEnvelopeBytes, outboxEntry, receipt, recipient, shape } from './weekly-delivery-envelope.js';
import type { DeliveryConfig, EmailEnvelope, OutboxEntry } from './weekly-delivery-envelope.js';
import type { TickResult } from './weekly-schedule.js';

export type { DeliveryConfig, EmailEnvelope, OutboxEntry } from './weekly-delivery-envelope.js';
export interface DeliveryOptions {
  readonly enabled: boolean; readonly recipient: string | null; readonly consent: boolean; readonly maxBytes?: number;
}
export interface SendAuthorization {
  readonly serviceId: string; readonly recipient: string; readonly consent: true;
}
export type AdapterResult = { readonly status: 'accepted'; readonly receiptId: string } | { readonly status: 'not-accepted' };
/** Trusted owner code only. No provider/model output may supply this function. */
export type OwnerEmailAdapter = (envelope: EmailEnvelope) => Promise<AdapterResult>;
export interface Recovery {
  readonly status: 'disabled' | 'pending-configuration' | 'no-summary' | 'enqueued' | 'existing';
  readonly entry?: OutboxEntry;
}
export interface DispatchResult {
  readonly status: 'disabled' | 'pending-configuration' | 'pending' | 'accepted' | 'uncertain';
  readonly entry?: OutboxEntry;
  readonly reason?: 'adapter-result-unknown';
}
const prefix = 'weekly-email:';
/** Local outbox is evidence of enqueue/transport acceptance, never email delivery. */
export class WeeklyDelivery {
  readonly schedule: WeeklySchedule;
  constructor(directory: string, root: string, clock: () => number = Date.now) {
    this.schedule = new WeeklySchedule(directory, root, clock);
  }
  #config(): DeliveryConfig {
    const store = this.schedule.store;
    const stored = store.get('weekly-email-config');
    return deliveryConfig(stored === undefined ? { schemaVersion: 1, projectId: store.projectId,
      originalRoot: store.originalRoot, enabled: false, recipient: null, consent: false, maxBytes: maxEnvelopeBytes } : stored,
    store.projectId, store.originalRoot);
  }
  #entry(id: string): OutboxEntry {
    sha(id);
    const store = this.schedule.store, entry = outboxEntry(store.get(prefix + id), store.projectId, store.originalRoot);
    if (entry.envelope.id !== id) throw new Error('outbox key mismatch');
    return entry;
  }
  #put(entry: OutboxEntry): OutboxEntry {
    const store = this.schedule.store, validated = outboxEntry(entry, store.projectId, store.originalRoot);
    store.put(prefix + validated.envelope.id, validated);
    return validated;
  }
  configure(raw: DeliveryOptions): DeliveryConfig {
    const v = dataSnapshot(raw); object(v, ['enabled', 'recipient', 'consent', 'maxBytes']);
    for (const key of ['enabled', 'recipient', 'consent']) if (!Object.hasOwn(v, key)) throw new Error('incomplete delivery options');
    if (Object.hasOwn(v, 'maxBytes')) budget(v.maxBytes);
    const store = this.schedule.store;
    return store.database.transaction(() => {
      const old = this.#config();
      const next = deliveryConfig({ ...v, schemaVersion: 1, projectId: store.projectId, originalRoot: store.originalRoot,
        maxBytes: v.maxBytes ?? old.maxBytes }, store.projectId, store.originalRoot);
      store.put('weekly-email-config', next); return next;
    });
  }
  status() {
    const schedule = this.schedule.status();
    const config = this.schedule.store.database.transaction(() => this.#config());
    return dataSnapshot({ config, schedule, externalSending: 'requires-trusted-owner-adapter' as const,
      status: !config.enabled || !schedule.enabled ? 'disabled' as const :
        config.recipient === null ? 'pending-configuration' as const : 'outbox-ready' as const });
  }
  /** Call before another tick to repair a crash after schedule commit, or after stdout failure. */
  recoverLatest(): Recovery {
    const scheduleBefore = serialize(this.schedule.store.get('schedule'));
    const status = this.schedule.status();
    if (!status.enabled) return dataSnapshot({ status: 'disabled' as const });
    // The schedule's retained result is separately committed. Re-reading is safe after restart.
    const summary = status.lastCompletedDue === null ? undefined : this.schedule.result(status.lastCompletedDue);
    return this.schedule.store.database.transaction(() => {
      if (serialize(this.schedule.store.get('schedule')) !== scheduleBefore) throw new Error('schedule changed before recovery');
      const config = this.#config();
      if (!config.enabled) return dataSnapshot({ status: 'disabled' as const });
      if (!config.recipient || !config.consent) return dataSnapshot({ status: 'pending-configuration' as const });
      if (!summary) return dataSnapshot({ status: 'no-summary' as const });
      const message = envelope(summary, config.recipient);
      if (bytes(serialize(message)) > config.maxBytes) throw new Error('configured envelope byte limit exceeded');
      const old = this.schedule.store.get(prefix + message.id);
      if (old !== undefined) {
        const entry = this.#entry(message.id);
        if (serialize(entry.envelope) !== serialize(message)) throw new Error('outbox summary identity conflict');
        return dataSnapshot({ status: 'existing' as const, entry });
      }
      const entry = this.#put({ schemaVersion: 1, envelope: message, status: 'pending', attempts: 0, receiptId: null, serviceId: null });
      return dataSnapshot({ status: 'enqueued' as const, entry });
    });
  }
  tick(): { readonly schedule: TickResult; readonly delivery: Recovery } {
    const before = this.recoverLatest();
    if (before.status === 'disabled') return dataSnapshot({ schedule: { status: 'disabled' as const }, delivery: before });
    const schedule = this.schedule.tick();
    return dataSnapshot({ schedule, delivery: this.recoverLatest() });
  }
  /** Bounded lexicographic keyset page. Includes accepted/uncertain; never purges deduplication keys. */
  outbox(raw: { readonly limit?: number; readonly after?: string } = {}): readonly OutboxEntry[] {
    const options = dataSnapshot(raw); object(options, ['limit', 'after']);
    const limit = options.limit ?? 20; natural(limit);
    if (limit < 1 || limit > 100) throw new Error('invalid outbox page size');
    if (options.after !== undefined) sha(options.after);
    return this.schedule.store.database.transaction(() => {
      this.#config(); this.schedule.store.assertCurrent();
      const rows = this.schedule.store.database.db.prepare(
        'SELECT key FROM owner_values WHERE key > ? AND key < ? ORDER BY key LIMIT ?'
      ).all(prefix + (options.after ?? ''), prefix + '~', limit);
      // Each entry is already validated, byte-bounded and deeply frozen by #entry.
      return Object.freeze(rows.map(row => {
        if (typeof row.key !== 'string') throw new Error('invalid outbox key');
        return this.#entry(row.key.slice(prefix.length));
      }));
    });
  }
  /** Explicit owner action only; tick/CLI never dispatch. Uncertain attempts cannot be replayed. */
  async dispatch(id: string, raw: SendAuthorization, adapter?: OwnerEmailAdapter): Promise<DispatchResult> {
    sha(id);
    const authorization = dataSnapshot(raw);
    shape(authorization, ['serviceId', 'recipient', 'consent']);
    recipient(authorization.recipient); receipt(authorization.serviceId);
    if (authorization.consent !== true || adapter !== undefined && typeof adapter !== 'function') throw new Error('invalid trusted send authorization');
    const scheduleBefore = serialize(this.schedule.store.get('schedule'));
    if (!this.schedule.status().enabled) return dataSnapshot({ status: 'disabled' as const });
    const claim = this.schedule.store.database.transaction(() => {
      if (serialize(this.schedule.store.get('schedule')) !== scheduleBefore) throw new Error('schedule changed before dispatch claim');
      const config = this.#config(), entry = this.#entry(id);
      if (!config.enabled) return { status: 'disabled' as const, entry };
      if (!config.consent || !config.recipient || !adapter) return { status: 'pending-configuration' as const, entry };
      if (config.recipient !== authorization.recipient || entry.envelope.recipient !== authorization.recipient) throw new Error('destination consent mismatch');
      if (entry.status !== 'pending') return { status: entry.status, entry };
      if (bytes(serialize(entry.envelope)) > config.maxBytes) throw new Error('configured envelope byte limit exceeded');
      natural(entry.attempts + 1);
      // Commit BEFORE leaving this process. A crash at any following point stays uncertain.
      const claimed = this.#put({ ...entry, status: 'uncertain', attempts: entry.attempts + 1, serviceId: authorization.serviceId });
      return { status: 'claimed' as const, entry: claimed };
    });
    if (claim.status !== 'claimed') return dataSnapshot(claim);
    let result: AdapterResult;
    try {
      const value = dataSnapshot(await adapter!(claim.entry.envelope));
      object(value, ['status', 'receiptId']);
      if (value.status === 'accepted') { shape(value, ['status', 'receiptId']); receipt(value.receiptId); }
      else { shape(value, ['status']); if (value.status !== 'not-accepted') throw new Error('unknown adapter result'); }
      result = value as AdapterResult;
    } catch {
      // Explicit uncertainty is the durable outcome, including callback throws and invalid responses.
      return dataSnapshot({ status: 'uncertain' as const, entry: claim.entry, reason: 'adapter-result-unknown' as const });
    }
    return this.schedule.store.database.transaction(() => {
      const current = this.#entry(id);
      if (serialize(current) !== serialize(claim.entry)) throw new Error('adapter claim changed; reconcile externally');
      const entry = this.#put({ ...current, status: result.status === 'accepted' ? 'accepted' : 'pending',
        receiptId: result.status === 'accepted' ? result.receiptId : null });
      return dataSnapshot({ status: entry.status, entry });
    });
  }
  close(): void { this.schedule.close(); }
}
