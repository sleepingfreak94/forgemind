# Fixed native Sol model catalog

`config/native-sol-model-catalog.json` contains the official `gpt-6.1-sol` entry
from Codex `rust-v0.162.1`, commit
`092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`, with three presentation reductions:
`tool_mode` is `direct`, `apply_patch_tool_type` is null, and
`experimental_supported_tools` is empty. All other fields are retained. This
exposes ForgeMind's host functions without launching the code-mode helper; it
adds no model capability or execution permission.

The [upstream catalog](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/models-manager/models.json)
has SHA-256 `943ca7fe1d19ed019054158303f0dbbd80b3bef43b3aa425a71aa7cb3fb52c2b`.
Restoring those three fields reproduces the official entry's serialized SHA-256
`9e7f6bcc65c0cf9e86cc97290447922e3b3834e54f4036a5ab916a4d5e2f9117`.
The shipped asset is 66,788 bytes with SHA-256
`b0ffc1c0e4e3a873df116e92afe103155a699303448484861225eb49f7838d45`.
Upstream licensing is retained in [LICENSE](licenses/codex-LICENSE.txt) and
[NOTICE](licenses/codex-NOTICE.txt). ForgeMind made the three modifications above.

The runtime uses a fixed module-relative asset path, not a task-selected path.
It rejects unknown models, altered bytes, symlinks, hardlinks, group/world writable
files and placement within either writable native directory. The canonical asset
identity joins the immutable launch dependencies and is checked throughout the
runtime. The sandbox receives literal read access to that pinned asset only.

The offline regression starts the actual pinned native executable within the
no-fork sandbox and sends only to a local HTTP fixture. It verifies the outbound
ResponsesLite catalog contains a `functions` namespace with exactly
`host_read`, `host_apply` and `host_check`, then returns a synthetic HTTP 401.
This proves tool advertisement; it does not exercise successful model inference,
dynamic callback handling, actual account entitlement or production completion.
Those remain separate reviewed live-canary acceptance criteria.
