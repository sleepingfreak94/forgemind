const MIN_INPUT_MS = Date.UTC(2000, 0, 1);
const MAX_INPUT_MS = Date.UTC(2100, 0, 1);
const ANCHOR_MS = Date.UTC(2000, 0, 2, 4, 30);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function validateTimestamp(value: unknown, name: string): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < MIN_INPUT_MS ||
    value >= MAX_INPUT_MS
  ) {
    throw new RangeError(`${name} must be a safe integer timestamp in [2000, 2100)`);
  }
}

/** Sunday 10:00 Asia/Kolkata equals Sunday 04:30 UTC throughout this range. */
export function weeklyDue(
  nowMs: number,
  activatedAtMs: number,
  lastCompletedDueMs: number | null = null,
): Readonly<{ timeZone: 'Asia/Kolkata'; dueAt: number | null; nextDueAt: number }> {
  validateTimestamp(nowMs, 'nowMs');
  validateTimestamp(activatedAtMs, 'activatedAtMs');

  // Omission is allowed; an explicitly supplied undefined timestamp is invalid.
  if (arguments.length > 2 && arguments[2] === undefined) {
    throw new RangeError('lastCompletedDueMs must be a supported timestamp or null');
  }
  if (lastCompletedDueMs !== null) {
    validateTimestamp(lastCompletedDueMs, 'lastCompletedDueMs');
    if (
      (lastCompletedDueMs - ANCHOR_MS) % WEEK_MS !== 0 ||
      lastCompletedDueMs < activatedAtMs ||
      lastCompletedDueMs > nowMs
    ) {
      throw new RangeError('lastCompletedDueMs must be a weekly boundary between activation and now');
    }
  }

  const latest = ANCHOR_MS + Math.floor((nowMs - ANCHOR_MS) / WEEK_MS) * WEEK_MS;
  const firstAtActivation =
    ANCHOR_MS + Math.ceil((activatedAtMs - ANCHOR_MS) / WEEK_MS) * WEEK_MS;
  const dueAt = latest >= activatedAtMs &&
    (lastCompletedDueMs === null || latest > lastCompletedDueMs) ? latest : null;

  // Computed boundaries may extend into 2100; only inputs have an upper limit.
  return Object.freeze({
    timeZone: 'Asia/Kolkata' as const,
    dueAt,
    nextDueAt: Math.max(latest + WEEK_MS, firstAtActivation),
  });
}
