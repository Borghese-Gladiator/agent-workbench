> Extracted from `docs/TODO.md` §6 on 2026-05-27.

## 6. Canonicalize `repo_name` so the same repo always gets one worktree parent dir

### Symptom

`make_worktree_path` composes `<worktrees_dir>/<repo_name>/<YYYYMMDD>__<slug>`. `repo_name` is `slugify(basename(--repo-path))` (`lib/cli/cmd_new_run.py:54` → `lib/run_ids.py:52-54`). Three valid ways to point at the *same* monorepo today produce three different second-level dirs:

| `--repo-path` value | derived `repo_name` |
|---|---|
| `.../new-tech-monorepo` | `new-tech-monorepo` |
| `.../new-tech-monorepo/agentic-development-task-system-v3__ai` | `agentic-development-task-system-v3-ai` |
| `.../new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live` | `agent-workbench-live` |

All three are the same git repo (same `git rev-parse --show-toplevel`). The worktree parent dir disagrees because the CLI never asks git "what is this repo's real root?" — it just slugifies the path the user typed. Anyone running `/new-run` from a different cwd, or invoking `agent-workbench new-run` against a subpath, opens a new top-level dir under `worktrees/`. The intent of `paths.worktrees_dir` is one normalized location per repo; the implementation only normalizes the root, not the per-repo namespace under it.

### Confirmed root cause

`derive_repo_name(repo_path.name)` in `cmd_new_run.py:54` takes the basename of whatever path was passed, never the repo toplevel. There's a `--repo-name` override (`naming.duplicate_repo_basename_strategy: require_repo_name_override` triggers it only on basename collision), but no automatic canonicalization. The `agent-workbench-live/.claude/commands/new-run.md` slash command just shells out to `agent-workbench new-run --repo-path <whatever>`; it inherits the same gap.

The current behavior is also what produced the 578 orphan `aw-e2e-repo-*`/`aw-repo-*`/`aw-self-mod-*`/`aw-snap-repo-*` directories before this cleanup landed — pytest fixtures `mkdtemp` source repos in `/var/folders/...` and the CLI obediently writes their worktrees under the *real* `worktrees_dir`, leaving headless shells when the tmpdir is wiped. Canonicalizing by toplevel won't fix the test-detritus problem (the tests still point `--repo-path` at distinct tmp repos), but it does fix the same-repo-different-cwd case, and it makes the test-fixture fix (route their worktrees into the tmpdir via `AGENT_WORKBENCH_ROOT` or a `paths.worktrees_dir` override) more obviously correct.

### Tasks

- [ ] **Resolve the repo to its git toplevel before deriving `repo_name`.** In `cmd_new_run.py`, after `repo_path = args.repo_path.resolve()`, run `git -C <path> rev-parse --show-toplevel` (already available via `lib/repos.py` — add a thin wrapper if not). Use the toplevel's basename as input to `derive_repo_name`. Fall back to the old behavior if the path isn't inside a git repo (i.e. `new-repo` mode, where the repo doesn't exist yet).
- [ ] **Honor `--repo-name` unchanged.** The explicit override path stays exactly as today; it's the only escape hatch for users who really do want a second namespace for the same repo (e.g. testing two branches in parallel). Canonicalization only kicks in when `--repo-name` is not passed.
- [ ] **Optional: detect "same toplevel, different existing `repo_name`" and warn.** If the canonical `repo_name` is `foo` but `<worktrees_dir>/foo/` doesn't exist and `<worktrees_dir>/foo-subpath/` does (i.e. a prior run from a subpath created a different parent), print a one-line warning at `new-run` time so the user notices the drift. Don't auto-merge — the existing dir might genuinely belong to a different intent.
- [ ] **Add a test in `tests/test_run_ids.py` (or wherever `derive_repo_name` is covered) that exercises the canonicalization.** Synthetic repo at `/tmp/foo/`; passing `--repo-path /tmp/foo/sub/dir` derives `repo_name=foo`, not `dir`. Make sure the `--repo-name` override still wins.
- [ ] **Document the rule in `agent-workbench-live/.claude/commands/new-run.md` and `lib/run_ids.py` module docstring.** "`repo_name` defaults to the slugified basename of the *git toplevel*, not the path you typed. Use `--repo-name` to override."

### Acceptance

- `agent-workbench new-run --repo-path .../new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live …` and `agent-workbench new-run --repo-path .../new-tech-monorepo …` produce worktrees under the **same** second-level dir under `worktrees/`.
- `--repo-name foo` still wins unconditionally.
- New repos (`--new-repo-path`) keep working — toplevel resolution skipped before init, then the new repo's own basename is used.
- A test demonstrates the canonical behavior and would fail under today's `cmd_new_run.py:54`.

### Non-goals

Re-homing the 578 orphan e2e/snap/self-mod directories (those are a separate test-hygiene issue — the e2e fixtures should set `AGENT_WORKBENCH_ROOT` or override `paths.worktrees_dir` to a tmpdir, not depend on canonical naming). Renaming or merging existing pre-canonicalization worktree dirs on disk — that's a migration script, not a behavior change. Cross-machine path canonicalization (`/Users/x` vs `/home/x` symlinks etc.) — out of scope; we canonicalize via `git rev-parse`, not by string-matching.

### Origin

Surfaced 2026-05-26 while auditing the worktree list in this repo. Two real worktrees existed for the same monorepo under different `repo_name` parents (`agent-workbench-live/` vs `agentic-development-task-system-v3-ai/` vs `new-tech-monorepo/`) purely because of which subpath was passed to `--repo-path` at `/new-run` time. The user pushed back: paths "look all over the place, but they SHOULD be normalized. Different ways of creating like claude commands vs cli commands should make the same result." Slash commands and the CLI already share one code path; the gap is that the shared path doesn't canonicalize the input. This TODO closes that.
