# Implementation plan

## Current repo understanding

Self-hosting run against this repo. The workbench root is `agent-workbench-live/`. There is no existing `agent-workbench-live/context/` directory.

Existing wiring touchpoints:

- `AGENTS.md` (repo root) — describes the two-file LOG/TODO contract for infra work on the workbench itself.
- `agent-workbench-live/AGENTS.md` — describes lifecycle discipline for in-run agents. No mention of a context library yet.
- `agent-workbench-live/.claude/commands/` — 13 slash commands: `abandon`, `board`, `bounce`, `complete`, `followups`, `handoff`, `new-run`, `plan`, `run-show`, `runs`, `shape`, `start`, `validate`. None currently load `@context/…` imports.
- No `CLAUDE.md` exists at the workbench root or repo root (the user has a global one at `~/.claude/CLAUDE.md`).
- Tests live at `agent-workbench-live/tests/` as stdlib `unittest` modules. Suite is currently 193/193 green.

Repo-specific conventions that diverge from the generic defaults in §1's task list:

- Worktrees live under `LOCAL_worktrees/` (per the user's global `CLAUDE.md`), not adjacent to the source repo. This is the convention `context/git/worktrees.md` must reflect.
- The workbench-itself test suite is stdlib `unittest`, NOT pytest. The Python context files describe the generic default (Poetry + pytest) because they're for agents working in arbitrary repos; the workbench itself stays on `unittest` and the new `test_context_library.py` follows suit.
- Git: never chain commands with `&&` / `||`; HEREDOC for multiline commit messages. These belong in `context/git/commit.md`.

## Relevant files

Existing files to read/modify:

- `agent-workbench-live/AGENTS.md` — add wiring block referencing `@context/README.md`.
- `AGENTS.md` (repo root) — add wiring block referencing `@context/README.md`.
- `agent-workbench-live/.claude/commands/plan.md`, `validate.md`, `start.md`, `new-run.md`, `followups.md` — add `Context:` import lines per §1's examples.
- `agent-workbench-live/tests/` — add `test_context_library.py` following the existing unittest style.

New files (entire context tree + the thin workbench-root `CLAUDE.md`):

- `agent-workbench-live/context/README.md`
- `agent-workbench-live/context/meta/{context-authoring,repo-discovery,risk-and-approval}.md`
- `agent-workbench-live/context/git/{commit,worktrees,draft-pr}.md`
- `agent-workbench-live/context/languages/python/{setup,dependencies,testing,quality}.md`
- `agent-workbench-live/context/languages/javascript-typescript/{setup,dependencies,testing,quality}.md`
- `agent-workbench-live/context/languages/go/{setup,dependencies,testing,quality}.md`
- `agent-workbench-live/context/infra/{secrets,shell,docker,ci,sql-migrations}.md`
- `agent-workbench-live/context/diagnostics/sentry-bug-triage.md`
- `CLAUDE.md` (repo root) — thin, references `@context/README.md` + the two meta files.

## Proposed changes

1. Create the `context/` directory tree (1 README + 20 leaf files = 21 files), each leaf following the four-header template (`Applies when:` / `Do:` / `Do not:` / `Commands:`) and ≤~50 lines.
2. Author `context/README.md` as the discovery entrypoint: one section per concern, one bullet per file with `@context/...` path + one-line description.
3. Add a "Context library" section to `agent-workbench-live/AGENTS.md` and to repo-root `AGENTS.md` that references `@context/README.md`, explains lazy loading, and explicitly does NOT inline the file list.
4. Create a thin `CLAUDE.md` at the repo root that references `@context/README.md`, `@context/meta/repo-discovery.md`, and `@context/meta/risk-and-approval.md`.
5. Add `Context:` import lines to the five slash commands per §1's examples:
   - `plan.md` → `@context/meta/repo-discovery.md`, `@context/meta/risk-and-approval.md`
   - `validate.md` → `@context/meta/repo-discovery.md`, `@context/git/draft-pr.md`, `@context/infra/ci.md`
   - `start.md` → `@context/git/worktrees.md`
   - `followups.md` → `@context/meta/risk-and-approval.md`
   - `new-run.md` → `@context/meta/context-authoring.md` (light, since this stage is code-blind)
6. Add `agent-workbench-live/tests/test_context_library.py` covering: every required file path exists, every non-README has the four headers, every non-README ≤60 lines, README indexes every file via `@context/...` path, no `workflows/` subdirectory.

## Files likely to change

- `agent-workbench-live/AGENTS.md`
- `AGENTS.md` (repo root)
- `agent-workbench-live/.claude/commands/plan.md`
- `agent-workbench-live/.claude/commands/validate.md`
- `agent-workbench-live/.claude/commands/start.md`
- `agent-workbench-live/.claude/commands/followups.md`
- `agent-workbench-live/.claude/commands/new-run.md`
- 21 new files under `agent-workbench-live/context/`
- `CLAUDE.md` (repo root, new)
- `agent-workbench-live/tests/test_context_library.py` (new)
- `docs/TODO.md` and `docs/LOG.md` (two-file contract; updated during commit prep)

## Data model changes

None.

## UI changes

None. The board, CLI, and slash command surfaces stay the same except for the small `Context:` line additions.

## Test plan

`agent-workbench-live/tests/test_context_library.py` — stdlib `unittest`:

- `test_directory_tree_exists`: every required path in the layout block exists as a file.
- `test_no_workflows_subdir`: `agent-workbench-live/context/workflows/` does NOT exist.
- `test_each_non_readme_has_four_headers`: every non-README context file contains the literal markers `Applies when:`, `Do:`, `Do not:`, `Commands:`.
- `test_each_non_readme_line_count`: every non-README context file is ≤60 lines.
- `test_readme_indexes_every_file`: every non-README path appears in `context/README.md` as an `@context/...` import.

Full suite must still pass: target ≥198 (193 existing + 5 new).

## QA plan

- `python -m unittest discover -s agent-workbench-live/tests -t agent-workbench-live` → expect ≥198 passing, 0 failures.
- `find agent-workbench-live/context -name '*.md'` → expect 21 paths.
- `grep -L '^Applies when:' agent-workbench-live/context/**/*.md` → expect README only.
- `grep '@context/' agent-workbench-live/.claude/commands/*.md` → expect non-empty for at least plan / validate / start.
- `grep '@context/README.md' AGENTS.md agent-workbench-live/AGENTS.md CLAUDE.md` → expect 3 hits.
- `[ ! -d agent-workbench-live/context/workflows ]` → expect success.

## Risks

- **Line-cap violations.** The 50-line target plus a four-header template plus code fences leaves little room. Mitigation: leaf files use bullet lists, not prose; tests enforce a 60-line hard cap.
- **Drift between AGENTS.md inlines and the README.** Mitigation: AGENTS.md says nothing about specific files — it points at `@context/README.md` and only the README enumerates.
- **Test fragility on the README index check.** If a file path changes, the README assertion fails — that's intended; the test enforces the index contract.
- **Generic vs. local defaults.** The Python testing file would mislead if it said the workbench uses pytest. Mitigation: the Python files describe the generic default (Poetry + pytest); the workbench-itself testing convention stays in `agent-workbench-live/AGENTS.md`.

## Definition of done

- All 21 context files exist with the four-header template and ≤60 lines.
- `context/README.md` indexes every file with an `@context/...` import path.
- `AGENTS.md` (root + workbench) and the new `CLAUDE.md` reference `@context/README.md` without inlining the file list.
- Five slash commands carry the targeted `Context:` imports per the proposed mapping above.
- `tests/test_context_library.py` passes with the rest of the suite (≥198 total).
- `docs/TODO.md` §1 deleted, ✅ summary added with commit SHA, §2 → §1 and §3 → §2 renumbered.
- `docs/LOG.md` carries a dated 2026-05-22 entry covering this work.
- Commit lands on the worktree's `agent/context-graph` branch. No push.

## Preflight

- repo_path: `/Users/timothy.shee/GitHub/LOCAL_worktrees/202605_agent_workbench_v2/agentic-development-task-system-v2__ai`
- repo_name: `agentic-development-task-system-v2-ai`
- base_ref: `202605_agent_workbench_v2`
- worktree_name: `context-graph`
- branch_name: `agent/context-graph`
- Checks:
  - base_ref exists in the target repo ✅ (current branch in this checkout)
  - no existing worktree at the planned path ✅
  - no existing branch named `agent/context-graph` (will be created by `start`)
  - no dependency / install steps required (stdlib `unittest`, plain Markdown)
- Warnings: none.

## Decisions & assumptions

### DR-001
- **Decision**: Use a single `Context:` line near the top of each affected slash command rather than weaving imports inline through the body.
- **Rationale**: One concentrated import block is easy to audit and grep for. Inline weaving would scatter `@context/...` references and make the slash command harder to read.
- **Alternatives considered**: Inline references at every point of use; a YAML-style `context:` list in the frontmatter.
- **Why not the alternatives**: Inline references duplicate paths. YAML frontmatter would be invisible to anyone reading the markdown body and creates a second discovery surface.

### DR-002
- **Decision**: Hard cap each non-README context file at 60 lines (test-enforced); aim for ~50.
- **Rationale**: §1 specifies "one screen max (~50 lines)" but code-block examples can push a tight file over 50 without being bloated. A 60-line hard ceiling preserves the intent (one screen) while giving authors room for two short fenced blocks.
- **Alternatives considered**: Hard cap at 50; soft cap with no test enforcement.
- **Why not the alternatives**: 50 is too tight once `Commands:` carries a multi-line shell block. A purely soft cap rots — the test is what keeps the library honest.

### DR-003
- **Decision**: Keep the Python language files describing the *generic* default (Poetry + pytest) even though the workbench itself uses stdlib `unittest`.
- **Rationale**: The context library is for agents working in arbitrary repos. The workbench-specific convention belongs in `agent-workbench-live/AGENTS.md`, where it already lives.
- **Alternatives considered**: Make `languages/python/testing.md` workbench-specific; add a workbench-specific overlay file.
- **Why not the alternatives**: Workbench-specific overlay creates a second source of truth. AGENTS.md already covers it.

### DR-004
- **Decision**: Add a new `CLAUDE.md` at the repo root (not under `agent-workbench-live/`).
- **Rationale**: `AGENTS.md` exists at both levels; `CLAUDE.md` doesn't exist at either. The repo root is the natural entry point — that's where the user's session opens. §1 requires `CLAUDE.md` to wire the library; placing it at the root keeps it visible.
- **Alternatives considered**: Put `CLAUDE.md` under `agent-workbench-live/`; put it at both levels.
- **Why not the alternatives**: Workbench-level only would hide it from a root-level session. Two CLAUDE.md files is duplication for no gain — the workbench AGENTS.md already covers in-run agent rules.

### DR-005
- **Decision**: Use literal `Applies when:` / `Do:` / `Do not:` / `Commands:` markers (no leading `##`), and assert their presence as substrings in the test.
- **Rationale**: §1's template language matches the literal form. Adding `##` would force every file to render four heavyweight headings on what is meant to be a one-screen reference.
- **Alternatives considered**: Use `## Do` / `## Do not` headings; bold markers (`**Do:**`).
- **Why not the alternatives**: Heading-form bloats the rendered file. Bold-markers are stylable but harder to test for — substring-match on the literal form is unambiguous.

### ASM-001
- **Text**: Claude Code resolves `@context/path/to/file.md` as a lazy import relative to the workbench root (or whatever the session opened).
- **Reason**: The TODO uses `@context/...` syntax matching Claude Code's documented lazy-import convention. No tooling change is needed inside the workbench — the convention is informational.
- **Impact**: low

### ASM-002
- **Text**: The five slash commands listed in proposed-changes step 5 are a reasonable starting set; other commands can opt in later without breaking anything.
- **Reason**: §1's task bullet gives three example mappings (validation, Python impl, Sentry triage). The five chosen align with those examples plus the obvious additions (`start.md` for worktree conventions, `new-run.md` for authoring).
- **Impact**: medium — a future agent may want to add `Context:` lines to `board.md`, `bounce.md`, etc.; this run does not preclude that.

### ASM-003
- **Text**: The new `CLAUDE.md` at the repo root will not collide with user-global `~/.claude/CLAUDE.md`.
- **Reason**: Claude Code merges multiple CLAUDE.md scopes; the user's global file remains authoritative for personal rules, and the repo-root file adds project-specific guidance.
- **Impact**: low
