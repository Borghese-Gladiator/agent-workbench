# AGENTS.md
You are an AI agent (Claude Code, Codex, Cursor, anything similar) opening this repo to **work on the workbench itself** — fix bugs, ship features, refactor, write docs. This file tells you how to leave the project files in a coherent state when you finish.

If you are instead **driving a run** inside the workbench (`/shape`, `/plan`, `/validate`, …), the file you want is `agent-workbench-live/AGENTS.md` — that one is about lifecycle discipline. This one is about repo-level hygiene.

## The two-file contract
Every change that touches the actual infrastructure — `agent-workbench-live/`, the schemas, the slash commands, the CLI, the test suite, configuration — leaves two project files out of sync if you don't update them:
- `docs/TODO.md` — what's still to do. Sections are numbered. Each open item is a `- [ ]` bullet.
- `docs/LOG.md` — chronological diary of what happened. Sections are dated (`## YYYY-MM-DD`).

**When you ship infrastructure work, you MUST update both:**
1. **Delete the item from `docs/TODO.md`.** If a whole section (`## N. …`) is done, delete the section and renumber the sections that follow
2. **Add a `docs/LOG.md` entry under today's date.** If today's date section doesn't exist yet, create it (`## YYYY-MM-DD`). Write 1-3 paragraphs of prose, not a bullet list of file paths. Cover: what shipped, why it mattered, the commit SHA(s), test counts before/after, and any surprises that came out of the work (especially anything a future reader would want to know that isn't obvious from the diff). Match the existing entries' tone — narrative, specific, mildly self-critical.

This is not optional. A TODO whose item is "done" but still rendered as `- [ ]` is misinformation. A LOG.md that skips a feature shipped today is amnesia. Both compound: the next session, looking at TODO.md to pick its next task, will work on something that's already done; the next session, looking at LOG.md to understand "how did we get here", will think a whole feature never happened.


## What counts as "infrastructure work"
If the change touches any of these, the contract applies:
- `agent-workbench-live/` — anything under it: `bin/`, `lib/`, `tests/`, `templates/`, `schemas/`, `.claude/commands/`, `requirements-board.txt`, `AGENTS.md`, `README.md`.
- `docs/` — `lifecycle.md`, `LOG.md`, `TODO.md`, `architecture.md` (and any new doc).
- Repo-level scaffolding — this file, top-level `README.md`, root-level scripts.

What does NOT trigger the contract:
- Editing artifacts inside a specific `runs/<id>/` directory (those are run history, not infrastructure).
- Scratch files like `plan.md` at the repo root (workflow ephemera; the convention is they ride alongside feature commits but aren't required to).
- A pure dogfood run that doesn't change any code — the `runs/<id>/` tree gets committed but TODO + LOG don't need entries because nothing about the workbench itself changed.

When in doubt, ask: *would a future session need to know this happened to do their work?* If yes, log it.

## Order of operations
Do this in the same session, ideally in one commit (or two if the code change and the docs are large):

1. Make the code change. Land tests. Run the suite.
2. Update `docs/TODO.md`
3. Update `docs/LOG.md` — add the dated entry. Include commit SHAs (you'll have them from `git log` after the code commit; if you're committing docs together, write the message + SHA in afterwards or amend).
4. Commit.


## Context library
Conventions, safety defaults, and per-language quartets live under `agent-workbench-live/context/`. Agents lazy-import individual files via `@context/path/to/file.md` on demand — pull in the leaf you need at the moment you need it.

Start at `@context/README.md` — it indexes every file with one-line descriptions and import paths. This AGENTS.md deliberately does not enumerate the library; the README is the single source of truth and stays in sync as files are added or removed.

## Related conventions
- `CLAUDE.md` (repo root): Claude-Code-specific pointers (slash commands); defers to this file for the cross-runtime contract.
- `agent-workbench-live/AGENTS.md`: governs in-run behavior (the lifecycle rules, only-`draft`-asks-questions, only-`transitions.transition`-writes-status). That file is what you read if you're inside a `/shape` / `/plan` / `/validate` invocation.
- The global `~/.claude/CLAUDE.md` instruction to write a root-level `plan.md` before non-trivial changes does **not** apply to runs. Runs hold their full plan inside `runs/<run_id>/plan.md` (written by `/plan`); that is the authoritative plan, and no second `plan.md` belongs at the repo root.
