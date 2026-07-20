# Context library

Small, opinionated, lazily-imported convention files. Agents pull in only what they need via `@context/path/to/file.md` — on demand, at the moment the leaf applies.

Each leaf file is one screen (≤~50 lines) and follows the same template:

- **Applies when:** one-line trigger.
- **Do:** the default behavior, bullet form.
- **Do not:** explicit anti-patterns.
- **Commands:** copy-pasteable shell snippets where useful.

Workflows belong in `.claude/commands/*`, not here. If you find yourself describing a multi-step process, put it in a command instead.

See [`@context/AUTHORING.md`](AUTHORING.md) before adding or editing a leaf.

## Git

- [`@context/git/commit.md`](git/commit.md) — one logical change per commit, imperative subject ≤70 chars, HEREDOC for multiline.
- [`@context/git/worktrees.md`](git/worktrees.md) — `LOCAL_worktrees/` convention; `pwd` + `git branch --show-current` + `git status --short` before any Git op.
- [`@context/git/draft-pr.md`](git/draft-pr.md) — inspect diff, run validation + tests, draft PRs for incomplete work, body = Summary + Test plan.

## Languages

### Python (`@context/languages/python/`)

- [`@context/languages/python/setup.md`](languages/python/setup.md) — Poetry default, pin Python, prefer repo scripts.
- [`@context/languages/python/dependencies.md`](languages/python/dependencies.md) — Poetry add/remove, lockfile committed, no global pip.
- [`@context/languages/python/testing.md`](languages/python/testing.md) — `bin/pytest` if present else `poetry run pytest`; mirror source layout.
- [`@context/languages/python/quality.md`](languages/python/quality.md) — `ruff check`, `ruff format --check`, `mypy`, `pytest` before push.

### JavaScript / TypeScript (`@context/languages/javascript-typescript/`)

- [`@context/languages/javascript-typescript/setup.md`](languages/javascript-typescript/setup.md) — Yarn default, no global installs, TS-first.
- [`@context/languages/javascript-typescript/dependencies.md`](languages/javascript-typescript/dependencies.md) — `yarn add`, lockfile committed, dedupe before push.
- [`@context/languages/javascript-typescript/testing.md`](languages/javascript-typescript/testing.md) — `yarn test`, getByRole over getByTestId, parametrize.
- [`@context/languages/javascript-typescript/quality.md`](languages/javascript-typescript/quality.md) — `yarn lint`, `yarn typecheck`, `yarn build`; avoid `any`.

### Go (`@context/languages/go/`)

- [`@context/languages/go/setup.md`](languages/go/setup.md) — Go modules, pinned `go` version in `go.mod`.
- [`@context/languages/go/dependencies.md`](languages/go/dependencies.md) — `go get`, `go mod tidy`, commit `go.sum`.
- [`@context/languages/go/testing.md`](languages/go/testing.md) — `go test ./...`, table tests, no global mutable state.
- [`@context/languages/go/quality.md`](languages/go/quality.md) — `gofmt`, `go vet`, wrap errors with `%w`, small interfaces.

## Infra

- [`@context/infra/secrets.md`](infra/secrets.md) — never commit secrets or `.env`; redact tokens in logs.
- [`@context/infra/shell.md`](infra/shell.md) — `set -euo pipefail`, quote variables, `mktemp`, guard destructive deletes.
- [`@context/infra/docker.md`](infra/docker.md) — multi-stage builds, pinned bases, `.dockerignore`, no baked secrets.
- [`@context/infra/ci.md`](infra/ci.md) — mirror CI checks locally; never weaken CI to pass.
- [`@context/infra/sql-migrations.md`](infra/sql-migrations.md) — backwards-compatible, expand-then-contract, backfill before `NOT NULL`.

## Diagnostics

- [`@context/diagnostics/sentry-bug-triage.md`](diagnostics/sentry-bug-triage.md) — identify project / env / release, first in-repo frame, regression test after root-cause.
