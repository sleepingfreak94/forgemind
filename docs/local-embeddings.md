# Explicit pinned local embeddings

SemanticMemory stays off unless a trusted local owner supplies this configuration. No model, package or tokenizer is downloaded. Repository dependencies, global defaults and environment variables are unchanged. This optional CPU backend is not general model-quality certification.

The supported artifact is `Xenova/all-MiniLM-L6-v2` revision `cb3d680149bf9a3209564e1b27ab3bb355b65707`, q8 ONNX, 384 dimensions, mean pooling and normalized vectors. The runtime is `@huggingface/transformers` 4.3.1. The bundled Node module SHA-256 and all five model/tokenizer files are pinned in `src/memory/local-embedding.ts`; unexpected model files (including custom code) are rejected. Immutable provider identity binds model revision, engine/version, device, dtype, dimensions and artifact pin digest.

Use an **already installed**, trusted local runtime and model cache outside the project. Expected layout:

```text
/private/install/node_modules/@huggingface/transformers/dist/transformers.node.mjs
/private/models/Xenova/all-MiniLM-L6-v2/config.json
/private/models/Xenova/all-MiniLM-L6-v2/tokenizer.json
/private/models/Xenova/all-MiniLM-L6-v2/tokenizer_config.json
/private/models/Xenova/all-MiniLM-L6-v2/special_tokens_map.json
/private/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx
```

Build using the repository's authorized command harness. Then run this standalone entry point through that harness (there is no new package script):

```sh
node dist/src/local-runtime/embedding-cli.js config --runtime /private/install/node_modules/@huggingface/transformers --model /private/models/Xenova/all-MiniLM-L6-v2
```

Save stdout as owner-private JSON, mode `0600`, outside the project. `config` verifies pins and emits JSON; it does not persist or activate anything. Explicit paths must be canonical and owner-controlled, without symlinks or group/world write access. Model outputs are not configuration.

```sh
node dist/src/local-runtime/embedding-cli.js status --config /private/embedding.json
node dist/src/local-runtime/embedding-cli.js recall --config /private/embedding.json --workspace /canonical/project --state-dir /private/project-memory --query 'Survive sudden power outages' --mode semantic --limit 3
```

`status` checks artifact pins only; `ready` is not proof inference ran. Omit `--config` to observe `provider-needed`. Missing, nonprivate or invalid config/cache reports `provider-needed` with an actionable instruction and exit code 2. No fallback vectors are manufactured. CPU failures fail the command with exit code 2. Inputs, corpus, vectors, child output and runtime are bounded.

Ingest, inspect and validate project memory using the existing owner memory CLI. Recall never promotes candidates. It constructs current `ProjectMemory` from explicit workspace/state and supplies it to `SemanticMemory` (this baseline has no `currentProjectMemory` factory). Validated records persist across restarts; vectors are derived afresh. Changed, deleted, deregistered, expired and foreign project/workspace records inherit existing validity checks before and after inference. Packets remain evidence-only and confer no execution authority.

Inference uses a separate Node permission process with filesystem reads limited to compiled source, the explicit runtime dependency tree and pinned model directory. It has no network, file write or subprocess grants. Remote models, filesystem/browser caches and fetch are disabled there. The child receives a minimal environment, excluding inherited NODE_OPTIONS, preloads and credential variables, and checks denied capabilities before reading input. Caller globals and environment are unchanged. Each embedding starts a fresh CPU process with a 45-second timeout; isolation costs throughput.

The runtime installation and native ONNX dependencies are **trusted owner code**. The adapter pins the Transformers bundle and checks package version; it does not attest every transitive native dependency or provide an OS sandbox against malicious addons. Node's addon permission is necessary for CPU ONNX. Keep the installation immutable during use; filesystem checks cannot eliminate a hostile concurrent owner replacement race. Model custom code is unsupported.

Synthetic tests exercise numeric plumbing and lifecycle only. Real quality evidence must run the actual cached model with public fixtures and label the small smoke, exact source/pins, query ranks, restart, invalidation and cross-project checks. A missing cache is an honest configuration gap.

Record text remains limited to 32,768 UTF-8 bytes (queries: 2,048); each of the two canonical configuration paths is limited to 4,096 UTF-8 bytes. The JSON transport cap is derived as the serialized empty-text/empty-path pinned configuration framing plus `6 * (32768 + 2 * 4096)` bytes. Six is the worst JSON string expansion per UTF-8 input byte (a one-byte control character becomes `\u00XX`); quote/backslash expansion is two. With the current pins the fixed framing is 291 bytes and the complete transport cap is 246,051 bytes. Both parent and child enforce this cap; the child separately revalidates decoded text and configuration limits. Output, diagnostic, timeout and native runtime budgets are unchanged. Tests cover the formula, record boundaries, oversized framing, escaped checkout child paths and Windows URL conversion; actual cached CPU transport evidence belongs to the source-bound private repair handoff. URL conversion and simulated portable discovery do not certify native Windows execution.

The layout contract compares exact path components with the host's native
basename/dirname operations: runtime ends in node_modules, @huggingface,
transformers; model ends in Xenova, all-MiniLM-L6-v2. Component case and
boundaries remain exact. Backslashes are not rewritten: they remain literal
filename characters on POSIX. Canonical absolute paths, symlink rejection,
owner checks and all artifact pins are still required before inference.

Portable layout tests exercise POSIX paths, Windows drive paths and UNC
components without certifying filesystem permissions. On hosts without
POSIX owner identity (getuid), configured embedding inspection/inference
fails closed with ownership checks unavailable. Native Windows ACL and Linux
enforcement qualification remain deferred. The original module-pin, revision-pin and nonprivate-config assertions run
on both POSIX and Windows component fixtures against the actual compiled
validator in isolated VM contexts with simulated canonical owner metadata.
They never skip when getuid is absent. The separate native filesystem
ownership test explicitly skips unsupported hosts. Portable layout,
fail-closed ownership and denied-capability tests still run. VM fixtures
certify a path/pin contract only, not native permissions. Actual Ubuntu/Windows CI and independent review
of the final source are integration gates, not results of a simulated probe.
