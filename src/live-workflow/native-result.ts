import { createHash } from 'node:crypto';

export interface NativeFinalMessage {
  readonly id: string;
  readonly text: string;
}
/** Model-authored evidence only: this structure grants no verdict or authority. */
export interface NativeFinalResult {
  readonly schema: 'native-final-text-v1';
  readonly trust: 'evidence-only';
  readonly source: string;
  readonly turnId: string;
  readonly messages: readonly NativeFinalMessage[];
  readonly digest: string;
}
type CompletedItem = { type: string; fingerprint: string | null; message: NativeFinalMessage | null };
const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Current-turn completions only. The executor meters every item before retaining
 * evidence; this collector adds neither an allowance nor another budget charge. */
export class NativeResultCollector {
  readonly #items = new Map<string, CompletedItem>();
  clear(): void { this.#items.clear(); }

  completed(item: Record<string, unknown>): void {
    const agent = item.type === 'agentMessage';
    if (agent && (typeof item.id !== 'string' || !item.id.length || typeof item.text !== 'string')) {
      throw new Error('Malformed native final message');
    }
    // Other completed types need only their identity/type for collision detection.
    if (typeof item.id !== 'string' || !item.id.length) return;
    let fingerprint: string | null = null, message: NativeFinalMessage | null = null;
    if (agent) {
      // AppServer may omit the optional phase or serialize its absence as null.
      const phase = item.phase ?? 'final_answer';
      if (phase !== 'final_answer' && phase !== 'commentary') throw new Error('Invalid native message phase');
      const text = item.text as string;
      fingerprint = hash(JSON.stringify([phase, text]));
      if (phase === 'final_answer') message = { id: item.id, text };
    }
    const type = String(item.type), previous = this.#items.get(item.id);
    if (previous) {
      if (previous.type !== type || previous.fingerprint !== fingerprint) throw new Error('Conflicting native completed item');
      return;
    }
    this.#items.set(item.id, { type, fingerprint, message });
  }

  snapshot(source: string, turnId: string): NativeFinalResult {
    const messages = Object.freeze([...this.#items.values()].flatMap(item =>
      item.message ? [Object.freeze({ ...item.message })] : []));
    // Property order and array order are part of the v1 digest encoding.
    const evidence = { schema: 'native-final-text-v1' as const, trust: 'evidence-only' as const, source, turnId, messages };
    return Object.freeze({ ...evidence, digest: hash(JSON.stringify(evidence)) });
  }
}
