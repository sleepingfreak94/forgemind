# Child output retention (LOG-A1)

The macOS check supervisor forwards bounded stdout and stderr from a sandboxed
child to private parent pipes. A child `close` event proves that its streams
have closed; it does not prove that the supervisor has flushed writes queued on
its own pipes. Exiting from the terminal IPC callback could discard those writes.

The supervisor now ends both output streams after child close and waits for
both `finish` events before sending `reaped` and exiting. A two-second watchdog
covers output completion **and** the terminal IPC callback. An unread pipe or
stalled callback cannot keep cleanup alive indefinitely. Output drain failure
does not produce a successful terminal receipt. Cancellation, deadlines and
parent disconnect still kill the detached child process group, with the existing
bounded stop fallback. A disconnect after reaping does not kill a reused PID.

The execution timer remains active until child close. The parent retains its
existing deadline and final cleanup limit. Output counting still combines both
streams, rejects overflow and never expands the configured byte allowance.
Private IPC is not inherited by the command child. `process.ts` is unchanged:
its normal path collects the final buffers until supervisor close.

## Reproduction and evidence

The fixed slow-reader scenario launches a Node command that naturally exits after
writing 600,000 ASCII `x` bytes to stdout. Odd-numbered samples also write 300,007
ASCII `y` bytes to stderr. The parent attaches permanent data handlers, pauses
both pipes for 500 ms, then reads at most 8,192 bytes per stream every 2 ms.
All bytes are retained, including Node's automatic pipe resume after child exit.

On macOS arm64 with Node 26.7.0, all eight unchanged-baseline samples retained
589,824 stdout bytes instead of 600,000, despite exit code 0 and `reaped` without
stopping. The baseline trace received all 600,000 child bytes and called
`process.exit(0)` with 10,176 stdout bytes still queued. The corrected candidate
retained the exact bytes and matching digests in all eight samples, both with
and without a diagnostic trace preload. Candidate traces finish both streams
with zero queued bytes before exit.

| Stream | Expected bytes | SHA-256 |
| --- | ---: | --- |
| stdout (`x`) | 600,000 | `34e95fe8877d07873716a3f575a4ea908b2e776b18e0b5122d33f7a93ff012b4` |
| stderr (`y`, mixed cases) | 300,007 | `15aade1a8d42f35d59cb6d594967fd496ea5d1f9bc2fd239c352775e277271fd` |
| baseline short stdout | 589,824 | `301960df76784912bd48a01aa183cd2323b3e0cd1f273d48ae0e650afa3f08ff` |

The private implementation handoff retains raw stdout/stderr, per-stream sizes
and digests, event traces, module/source identities and owner action receipts.
The original diagnostic collector omitted a data handler and could discard bytes
during Node's automatic exit-time resume. Those original runs are preserved and
explicitly superseded by the corrected collector; their sizes are not valid
supervisor-loss measurements. Historical LOG-A1 evidence remains unchanged.

## Regression coverage and limits

Run `npm run build`, then
`node --test dist/tests/live-workflow/process-output.test.js dist/tests/live-workflow/checks.test.js`.
The new host tests cover the fixed sample, nonzero exit, combined output limit,
public `supervised` results and rejection paths, deadline, IPC cancellation,
signals, parent disconnect, worker/descendant disappearance, an unread output
pipe, and a deliberately withheld terminal IPC callback.

The diagnostic fork tests use an allow-default sandbox profile to isolate pipe
behavior. The existing check tests separately verify the restrictive production
profile's denial of secrets, source writes, process forks and network access.
These tests require macOS; they do not certify enforcement on another platform.

This is evidence for a bounded forwarding fix and a fixed stress sample, not a
universal losslessness guarantee. It cannot recover historical missing output,
bytes never written by a command, output rejected by the limit, or abandoned
output after cancellation, a deadline, disconnect or drain timeout. The public
API returns strings; these ASCII fixtures do not certify arbitrary binary or
split UTF-8 decoding. Independent review and lead integration remain separate.
