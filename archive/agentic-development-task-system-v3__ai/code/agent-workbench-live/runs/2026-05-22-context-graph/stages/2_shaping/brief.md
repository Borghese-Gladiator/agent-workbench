# Brief

<!--
Code-blind. Transcribes TODO §1 (Context Graph) faithfully.
-->

## Goal

Stop agents from repeatedly rediscovering project conventions (package manager, testing, Git safety, PR rules, infra/migration safety, bug triage) by adding a small opinionated **context library** under `agent-workbench-live/context/`. Agents lazy-import individual files via `@context/path/to/file.md`; slash commands compose targeted imports instead of duplicating instructions inline.

## User-facing behavior

- An agent opening this repo can resolve `@context/git/commit.md`, `@context/languages/python/testing.md`, etc., and get a focused one-screen convention file.
- Slash commands under `.claude/commands/` reference the specific context files they need at the top, so the agent loads only the conventions relevant to the current command.
- `AGENTS.md` (workbench root) and `agent-workbench-live/AGENTS.md` point at `@context/README.md` rather than listing every file inline.
- `CLAUDE.md` explains Claude Code's lazy `@context/...` resolution and references the README plus the two meta files an agent always needs first.

## Acceptance criteria

- Directory tree exists exactly as specified:
  - `agent-workbench-live/context/README.md`
  - `meta/{context-authoring,repo-discovery,risk-and-approval}.md`
  - `git/{commit,worktrees,draft-pr}.md`
  - `languages/python/{setup,dependencies,testing,quality}.md`
  - `languages/javascript-typescript/{setup,dependencies,testing,quality}.md`
  - `languages/go/{setup,dependencies,testing,quality}.md`
  - `infra/{secrets,shell,docker,ci,sql-migrations}.md`
  - `diagnostics/sentry-bug-triage.md`
- Every non-README file follows the four-header template: `Applies when:`, `Do:`, `Do not:`, `Commands:`.
- Every non-README file is ≤~50 lines (≤60 hard cap to accommodate code-block examples).
- `context/README.md` indexes every other file with one-line description and `@context/...` import path.
- `AGENTS.md` (workbench root) and `agent-workbench-live/AGENTS.md` reference `@context/README.md`, explain lazy loading + composition by commands, and **do not** inline the file list.
- `CLAUDE.md` (workbench root) references `@context/README.md`, `@context/meta/repo-discovery.md`, `@context/meta/risk-and-approval.md`.
- Relevant `.claude/commands/*.md` files compose targeted imports (e.g. plan/validate reference repo-discovery, draft-pr, ci as applicable).
- No `agent-workbench-live/context/workflows/` directory exists.
- Existing repo conventions (e.g. workbench-itself testing rules, worktree placement) are preserved where they differ from the generic defaults.
- New `tests/test_context_library.py` covers the structural invariants (file existence, headers, line cap, README index, no workflows dir).
- Full unit suite still passes (193 → ≥198 with the new tests).

## Non-goals

- Large workflow documents.
- One file per Git porcelain command.
- Duplicated guidance between context files and slash commands.
- Long-form architecture docs or tutorials.
- Assuming tools the repo doesn't already use.
- Sentry-specific API integrations (the diagnostic stays tool-agnostic).

## Good examples

- `context/git/commit.md` has ~6 bullets under `Do:` (imperative subject ≤70 chars, HEREDOC for multiline, one logical change per commit) and ~4 under `Do not:` (`--no-verify`, amending published commits) — fits on one screen.
- `context/languages/python/testing.md` says "use `bin/pytest` if present else `poetry run pytest`" rather than "it depends on the project."
- `.claude/commands/plan.md` opens with: `Context: @context/meta/repo-discovery.md, @context/meta/risk-and-approval.md` and trusts the agent to load them lazily.

## Bad examples

- A `context/workflows/release.md` file describing the release process — workflows belong in `.claude/commands/`.
- `context/git/git-commands.md` listing every porcelain command with flags — too generic, wrong granularity.
- A 200-line `context/languages/python/everything.md` covering setup, testing, lint, deploy — split it.
- `AGENTS.md` listing all twenty context files inline — should reference `@context/README.md` instead.

## Constraints

- Each context file ≤~50 lines (≤60 hard).
- Four-header template: `Applies when:`, `Do:`, `Do not:`, `Commands:` — no exceptions.
- File names lowercase-kebab; directory names lowercase. `javascript-typescript` (not `js-ts` or `ts`).
- Sentry diagnostic is tool-agnostic: no Sentry CLI/API calls, no MCP server assumption.
- Tests are stdlib `unittest`, matching existing suite style.

## Assumptions

- The workbench root has no existing `CLAUDE.md`; we add a thin one that satisfies the wiring requirement.
- Existing `.claude/commands/*.md` should gain a small `Context:` block near the top; we do not rewrite their bodies.
- The workbench-itself testing convention (stdlib unittest) is preserved for `tests/test_context_library.py`. The generic Python testing context file describes Poetry/pytest as the default because the library is for agents working in arbitrary repos.
- `@context/...` resolution is a Claude-Code-style lazy import. The library files are plain Markdown — no special tooling is required for the imports themselves; the convention is informational.

## Suggested QA scenarios

- Run `python -m unittest discover -s agent-workbench-live/tests -t agent-workbench-live` and confirm pass count rises from 193 to ≥198.
- `find agent-workbench-live/context -name '*.md'` lists all 21 files (README + 20 leaves).
- `grep -L '^Applies when:' agent-workbench-live/context/**/*.md` returns only `README.md`.
- `grep -c '@context/' agent-workbench-live/.claude/commands/*.md` shows imports wired in at least `plan.md`, `validate.md`, `start.md`.
- `grep '@context/README.md' AGENTS.md agent-workbench-live/AGENTS.md CLAUDE.md` returns three matches.
- `[ ! -d agent-workbench-live/context/workflows ]` succeeds.
