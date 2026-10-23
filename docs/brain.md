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
```

All commands accept `--brain-dir` (default `~/.forgemind/brain`). `--scope project` (default) limits an entry to the project; `--scope space` makes it space-wide.

## Lifecycle

New entries are `proposed`. You `approve` or `reject` them; an approved entry can later be `retire`d. Proposed, rejected and retired items never guide agents; only approved entries are used. Text that looks like a secret is refused.

## Learning from history

```
npm run brain -- learn --workspace /path/to/project --source all --limit 100
```

`learn` reads the git log and remote branch names, and merged pull requests through `gh`. It creates only `proposed` entries scoped to the project; you still `approve` or `reject` each one. Proposal text is generated from statistics (for example "4 of 5 commits"), never copied from commit, PR or review text, and evidence holds only identifiers (`git:<hash>`, `branch:<prefix>`, PR URLs). The command prints `{"proposed": [ids], "skipped": [sources]}`; a source that fails (for example `gh` not signed in) is listed in `skipped` and does not stop the others.

## Output

Every command prints one JSON object. Exit codes: 0 success, 1 failure, 2 usage error.
