# Context Graph

Stop agents from repeatedly rediscovering project conventions (package manager, testing, Git safety, PR rules, infra/migration safety, bug triage) by adding a small opinionated context library under `agent-workbench-live/context/`. Agents lazy-import individual files via `@context/path/to/file.md`; slash commands compose targeted imports instead of duplicating instructions inline.

## Design principles

- Context files are conventions/safety/defaults, not workflows. Workflows belong in `.claude/commands/*`, which compose context files.
- One concern per file, one screen max (~50 lines), example-heavy over prose, one default way ("it depends" is a smell).
- Organized by concern: `meta`, `git`, `languages`, `infra`, `diagnostics`. No `context/workflows/` directory.
- Every file follows the same template: `Applies when:` / `Do:` / `Do not:` / `Commands:`.

## Directory layout

```text
agent-workbench-live/context/
  README.md
  meta/{context-authoring,repo-discovery,risk-and-approval}.md
  git/{commit,worktrees,draft-pr}.md
  languages/python/{setup,dependencies,testing,quality}.md
  languages/javascript-typescript/{setup,dependencies,testing,quality}.md
  languages/go/{setup,dependencies,testing,quality}.md
  infra/{secrets,shell,docker,ci,sql-migrations}.md
  diagnostics/sentry-bug-triage.md
```

## Tasks

- Inspect existing `AGENTS.md`, `CLAUDE.md`, `.claude/commands/*`, and repo conventions before authoring; preserve any defaults that already differ from the generic ones below.
- Create the normalized directory tree under `agent-workbench-live/context/`.
- **Meta** — `context-authoring.md` (naming, one-screen rule, when to split, examples > prose, when to inline vs. import, avoid workflow duplication); `repo-discovery.md` (detect language / package manager / test runner / CI / lint+format+typecheck commands; prefer repo-local scripts; example commands: `pwd`, `ls`, `find . -maxdepth 3 -name pyproject.toml -o -name package.json -o -name go.mod`, `find . -maxdepth 3 -name AGENTS.md -o -name CLAUDE.md -o -name Makefile`); `risk-and-approval.md` (ask before force-push / destructive deletes / destructive migrations; classify low/medium/high risk; prefer reversible operations).
- **Git** — intent-oriented, not one file per porcelain command. `commit.md` (one logical change per commit, imperative ≤70-char subject, HEREDOC for multiline, never `--no-verify` without approval, never amend published commits unless approved). `worktrees.md` (`LOCAL_worktrees/` convention, cleanup expectations, always `pwd` + `git branch --show-current` + `git status --short` before Git ops). `draft-pr.md` (inspect diff, run validation + tests before PR, draft PRs for incomplete work, body = Summary + Test plan, never force-push to `main`).
- **Languages** — same `setup` / `dependencies` / `testing` / `quality` quartet for each. **Python**: Poetry default; `bin/pytest` if present else `poetry run pytest`; `ruff check`, `ruff format --check`, `mypy`, `pytest`. **JS/TS** (directory `javascript-typescript`): Yarn default, no global installs, TS-first; `yarn lint` / `typecheck` / `build` / `test`; avoid `any`. **Go**: Go modules, `gofmt`, `go test ./...`, wrap errors with `%w`, small interfaces, no mutable package globals.
- **Infra** — `secrets.md` (never commit secrets or `.env`, redact tokens in logs, no creds in PRs/issues/tests); `shell.md` (`set -euo pipefail`, quote variables, `mktemp`, guard destructive deletes); `docker.md` (multi-stage builds, `.dockerignore`, pinned bases, never `latest`, no baked secrets); `ci.md` (mirror CI checks locally, prefer repo scripts, never weaken CI to pass, document skipped checks); `sql-migrations.md` (backwards-compatible, expand-then-contract, backfill before `NOT NULL`, avoid long locks, never drop columns in the same release that stops writes).
- **Diagnostics** — `sentry-bug-triage.md`: tool-agnostic (no Sentry CLI/API assumptions). Identify project/env/release, inspect frequency/impact, find first in-repo stack frame, correlate with recent deploys / dependency bumps, add regression tests after root-cause, never log sensitive data, never close issues without rationale.
- Create `context/README.md` — primary discovery entrypoint. Lists every file with one-line description + `@context/...` import path, organized by section.
- Wire `AGENTS.md`: add a section that references `@context/README.md`, explains lazy loading + composition by commands, does **not** inline the file list.
- Wire `CLAUDE.md`: explain Claude Code's lazy `@context/...` resolution, prefer focused imports, reference `@context/README.md` + `@context/meta/repo-discovery.md` + `@context/meta/risk-and-approval.md`.
- Update existing `.claude/commands/*` files to compose targeted imports (examples: validation → `@context/meta/repo-discovery.md` + `@context/git/draft-pr.md` + `@context/infra/ci.md`; Python implementation → `@context/languages/python/testing.md` + `@context/languages/python/quality.md` + `@context/git/worktrees.md`; Sentry triage → `@context/diagnostics/sentry-bug-triage.md` + `@context/git/draft-pr.md` + `@context/meta/risk-and-approval.md`).
- Run formatting / lint / tests; confirm acceptance: every required file exists and follows the template, every file ≤~50 lines, no `context/workflows/` directory, `README.md` indexes every file, `AGENTS.md` + `CLAUDE.md` reference the library, relevant commands use targeted imports, existing repo conventions preserved over generic defaults.

## Non-goals

Large workflow documents; one file per Git command; duplicated guidance; long-form architecture docs; tutorials; assuming tools the repo doesn't already use; Sentry-specific API integrations.
