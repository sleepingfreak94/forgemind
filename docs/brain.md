# Central brain: owner guide

The brain holds reviewed knowledge (conventions, lessons, decisions, patterns). It is local owner state in `~/.forgemind/brain`, never in a repository.

## Spaces

There are two isolated spaces, `personal` and `company`, each with its own database. Every project is mapped to exactly one space, once. Remapping to the other space is refused ("already mapped"). The space always comes from the map; commands have no space option except `map`. Concurrent `map` calls are not locked (last writer wins).

## Commands

```
npm run brain -- map --workspace /path/to/project --space personal
npm run brain -- add --workspace /path/to/project --kind convention --text "PR titles use type(scope): summary." --reason "owner" [--evidence E] [--scope project|space]
npm run brain -- list --workspace /path/to/project [--status proposed]
npm run brain -- show --workspace /path/to/project --id ID
npm run brain -- approve --workspace /path/to/project --id ID
npm run brain -- reject --workspace /path/to/project --id ID [--note N]
npm run brain -- retire --workspace /path/to/project --id ID
npm run brain -- learn --workspace /path/to/project [--source git|github|all] [--limit N]
npm run brain -- history --workspace /path/to/project [--limit N]
```

All commands accept `--brain-dir` (default `~/.forgemind/brain`). `--scope project` (default) limits an entry to the project; `--scope space` makes it space-wide.

## Lifecycle

New entries are `proposed`. You `approve` or `reject` them; an approved entry can later be `retire`d. Proposed, rejected and retired items never guide agents; only approved entries are used. Text that looks like a secret is refused.

## Learning from history

```
npm run brain -- learn --workspace /path/to/project --source all --limit 100
```

`learn` reads the git log and remote branch names, and merged pull requests through `gh`. It creates only `proposed` entries scoped to the project; you still `approve` or `reject` each one. Proposal text is generated from statistics (for example "4 of 5 commits"), never copied from commit, PR or review text, and evidence holds only identifiers (`git:<hash>`, `branch:<prefix>`, PR URLs). The command prints `{"proposed": [ids], "skipped": [sources]}`; a source that fails (for example `gh` not signed in) is listed in `skipped` and does not stop the others.

## Run history

History is facts, not rules, and never needs approval. Every harness run records its title, summary, files, outcome and evidence automatically in the project's mapped space; unmapped projects are skipped (the run prints `Brain: run not recorded (...)`). Secret-like values are stored as `[redacted]`. `history` lists the newest runs for the project (`--limit` 1 to 200, default 20). History never appears in `list` or guides agents.

## Use from Claude Code and Cursor

`forgemind-brain` is a local MCP server over stdio. Run `npm run build` first, and register `node` directly (not `npm run`, whose banner would corrupt the JSON-RPC stream).

Claude Code:

```
claude mcp add --scope user forgemind-brain -- node /Users/kshitijsharma/Documents/forgemind/dist/src/memory/brain-mcp.js --source claude-code
```

Cursor, in `~/.cursor/mcp.json`:

```
{"mcpServers":{"forgemind-brain":{"command":"node","args":["/Users/kshitijsharma/Documents/forgemind/dist/src/memory/brain-mcp.js","--source","cursor"]}}}
```

Options: `--source claude-code|cursor` (required), `--workspace` (default current directory, resolved to its git top-level), `--brain-dir`.

Tools: `brain_context` (project packet), `brain_search` (query, optional limit 1 to 5), `brain_propose` (kind, text, reason; stays `proposed` until you approve it), `brain_record` (title, summary, files, outcome; once per distinct summary per day).

Token caps: `brain_context` is at most 3200 characters (about 800 tokens), dropping the oldest items first and ending with `(N more; use brain_search)`. `brain_search` returns at most 5 items, 400 characters each and 2000 in total. Agents never get the whole store and never read the database.

Agents should call `brain_context` at the start of a session and `brain_record` at the end. In a project that is not mapped, every tool returns an error with the mapping hint: `npm run brain -- map --workspace <path> --space personal|company`.

## Output

Every command prints one JSON object. Exit codes: 0 success, 1 failure, 2 usage error.
