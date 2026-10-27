# Brief

## Goal

Canonicalize `repo_name` so that the same git repository always maps to a single second-level directory under `paths.worktrees_dir`, regardless of which subpath was passed to `--repo-path`. The user has reported real drift: three subpaths of the same monorepo currently produce three different `repo_name` namespaces, scattering worktrees across `agent-workbench-live/`, `agentic-development-task-system-v3-ai/`, and `new-tech-monorepo/` parents. The CLI and the `/new-run` slash command share one code path, so a single fix in `cmd_new_run.py` closes both entry points. The explicit `--repo-name` override is preserved as the escape hatch for users who really do want a second namespace for the same repo.

## User-facing behavior

When a user runs `agent-workbench new-run --repo-path <path>` (or invokes `/new-run` with any subpath of an existing git repo) without supplying `--repo-name`, the derived `repo_name` is the slugified basename of the **git toplevel** (`git rev-parse --show-toplevel`), not the slugified basename of whatever path was typed. As a result, any subpath of the same repo lands worktrees under the same second-level dir. If the user passes `--repo-name foo` explicitly, that name wins unconditionally, exactly as today. If the target is not yet a git repo (the `--new-repo-path` flow), the old basename-of-the-path behavior applies, since there is no toplevel to resolve yet.

Optionally — only if no extra effort beyond a one-line warning — when canonicalization would land under `<worktrees_dir>/foo/` but a pre-canonicalization dir `<worktrees_dir>/foo-subpath/` already exists, print a single-line warning at `new-run` time so the user can notice the drift. Don't merge, don't move, don't error.

## Acceptance criteria

- Running `agent-workbench new-run --repo-path .../new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live …` and `agent-workbench new-run --repo-path .../new-tech-monorepo …` produces worktrees under the **same** second-level dir under `paths.worktrees_dir`.
- `--repo-name foo` continues to win unconditionally over canonicalization.
- The `--new-repo-path` flow continues to work: toplevel resolution is skipped before the new repo exists; once it exists, its own basename is used.
- A test in the existing `derive_repo_name` coverage demonstrates the canonical behavior — a synthetic repo at `/tmp/foo/` passed as `--repo-path /tmp/foo/sub/dir` derives `repo_name=foo`, not `dir`. The test fails under the pre-change code path.
- Module docstring on `lib/run_ids.py` and the `/new-run` slash-command doc both state the new rule: "`repo_name` defaults to the slugified basename of the *git toplevel*, not the path you typed. Use `--repo-name` to override."

## Non-goals

- **Re-homing pre-existing worktrees.** Worktrees already on disk under non-canonical parents stay where they are. No migration script. The user can choose to move or abandon them manually.
- **Re-homing the 578 orphan `aw-e2e-repo-*` / `aw-snap-repo-*` test directories.** Those are a separate test-hygiene issue — the fix is to point e2e fixtures at `AGENT_WORKBENCH_ROOT` or a tmp `paths.worktrees_dir` override, not to canonicalize.
- **Cross-machine path canonicalization** (e.g. `/Users/x` vs `/home/x` symlink equivalence). Canonicalization is delegated to `git rev-parse`; whatever git considers the toplevel is what we use.
- **Auto-merging existing-but-mis-namespaced worktrees.** The optional warning may surface drift, but never moves files.
- **Changing the per-run slug or date format.** Only the second-level (`repo_name`) directory under `worktrees_dir` changes.

## Good examples

- A user runs `cd ~/code/monorepo/services/api && /new-run`. The CLI resolves `git rev-parse --show-toplevel` to `~/code/monorepo`, derives `repo_name=monorepo`, and the worktree lands at `<worktrees_dir>/monorepo/<date>__<slug>`. The same user the next day runs `cd ~/code/monorepo && /new-run` — the worktree lands under the same `<worktrees_dir>/monorepo/` parent.
- A user genuinely wants two independent namespaces for the same repo to test divergent branches: they pass `--repo-name monorepo-experimental`. That overrides canonicalization, and the worktree lands at `<worktrees_dir>/monorepo-experimental/<date>__<slug>`.
- A user bootstraps a new repo with `--new-repo-path ~/code/brand-new`. The directory doesn't exist yet, so toplevel resolution is skipped; the new repo's eventual basename `brand-new` is used as `repo_name`.

## Bad examples

- Canonicalizing by walking up the path looking for a `.git` directory by hand instead of asking git. That re-implements `git rev-parse` and gets symlinks, worktrees, and submodules wrong. Use git itself.
- Silently rewriting `--repo-name` when both `--repo-name` and a canonical name disagree. The explicit override must win without warning, without rewrite.
- Erroring out when the path isn't inside a git repo. The `--new-repo-path` flow is an explicit valid case; falling back to the old basename-of-the-path behavior is correct there.
- Treating "different existing `repo_name` parent" as something to auto-migrate. The optional warning must be a warning only.
- Slug-matching string-equality on the path to decide canonicalization. Use `git rev-parse --show-toplevel` and slugify its basename — the only normalization step.

## Constraints

- The change lives in `cmd_new_run.py` and a thin git-toplevel helper (likely in `lib/repos.py`, or co-located). It must not change `make_worktree_path`, the run-id format, or the date prefix.
- Backward compatibility on disk: existing worktrees and existing `<worktrees_dir>/<old-repo_name>/` parents remain untouched and continue to work for the runs already inside them.
- `--repo-name` semantics are preserved exactly. The `naming.duplicate_repo_basename_strategy: require_repo_name_override` collision rule continues to apply where it applies today.
- The git-toplevel call must be guarded: if the repo doesn't exist (new-repo flow) or `git rev-parse` errors, fall back to today's behavior — never block a valid `new-run`.

## Assumptions

- The git-toplevel helper either already exists in `lib/repos.py` or can be added as a thin wrapper around `git -C <path> rev-parse --show-toplevel`. If a wrapper exists, prefer it.
- `derive_repo_name` lives in `lib/run_ids.py` (per the TODO's reference to `lib/run_ids.py:52-54`) and accepts a string; passing the toplevel basename to it requires no signature change.
- The test layout for `derive_repo_name` is `tests/test_run_ids.py` (per the TODO). The new test follows whatever fixture conventions already exist there.
- The optional drift-warning is genuinely optional. If it adds non-trivial branching or new state, it's deferred to a separate follow-up.

## Suggested QA scenarios

- **Subpath canonicalization (positive).** Synthetic git repo at `/tmp/foo`. Run `new-run --repo-path /tmp/foo/sub/dir --worktree-name x --idea-file …`. Assert worktree lands at `<worktrees_dir>/foo/<date>__x/` and `derive_repo_name` was given `foo`.
- **Toplevel itself (positive).** Same synthetic repo. Run `new-run --repo-path /tmp/foo …`. Assert worktree lands under the same `<worktrees_dir>/foo/` parent as the previous case.
- **Explicit override wins.** Same synthetic repo. Run `new-run --repo-path /tmp/foo/sub/dir --repo-name custom-name …`. Assert worktree lands at `<worktrees_dir>/custom-name/<date>__x/`.
- **New-repo flow unaffected.** Run `new-run --new-repo-path /tmp/brand-new …`. Assert the directory is created, the new repo's basename `brand-new` is used, and no `git rev-parse` error surfaces.
- **Non-git path falls back gracefully.** Point `--repo-path` at a directory that exists but is not a git repo. Assert the old behavior applies (basename of the path); no crash.
- **Slash command parity.** Invoke `/new-run` from cwd inside a subpath of the monorepo without explicit `--repo-name`. Assert the resulting `metadata.yaml` lists the canonical `repo_name` (toplevel-basename slug), not the subpath slug.
- **Optional drift warning (only if implemented).** Pre-create `<worktrees_dir>/foo-subpath/` to simulate a pre-canonicalization run. Run `new-run --repo-path /tmp/foo/sub/dir …` and assert exactly one warning line is printed and the new worktree still lands under canonical `<worktrees_dir>/foo/`.
