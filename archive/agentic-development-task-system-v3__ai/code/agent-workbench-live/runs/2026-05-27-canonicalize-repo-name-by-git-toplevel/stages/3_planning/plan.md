# Implementation plan

## Current repo understanding

The workbench composes worktree paths as `<paths.worktrees_dir>/<repo_name>/<YYYYMMDD>__<slug>` (`lib/run_ids.py:72-81`, `make_worktree_path`). `repo_name` is derived in exactly one place: `lib/cli/cmd_new_run.py:54`:

```python
repo_name = args.repo_name or run_ids.derive_repo_name(repo_path.name)
```

`derive_repo_name` (`lib/run_ids.py:52-54`) is a thin wrapper around `slugify` (`lib/run_ids.py:25-39`). It takes whatever basename it's given and lowercases / kebab-cases it.

This means three different `--repo-path` values pointing at subpaths of the *same* git repo produce three different `repo_name` namespaces under `paths.worktrees_dir`. The CLI never asks git "what is this repo's real root?" — it just slugifies the path the user typed.

The repo already has a clean git-subprocess helper pattern. `lib/repos.py:27-38` defines `_git` and `_git_strict` (both shell out via `git -C <path> ...`, never `cd`). `lib/runs.py:110-143` defines `_git_common_dir`, which is the closest existing analog to what we need: a `subprocess.run(["git", "-C", str(start), "rev-parse", "--git-common-dir"], ...)` call with a 5-second timeout and a None fallback on error. There is **no** existing `git rev-parse --show-toplevel` helper — we add one.

`--new-repo-path` (new-repo bootstrap) goes through the same `derive_repo_name(repo_path.name)` call at line 54 — but at that moment the directory may not even exist as a git repo yet, so any toplevel resolution must be skipped in that mode and the old basename behavior preserved.

The config key `naming.duplicate_repo_basename_strategy: require_repo_name_override` (`agent-workbench.yaml:51`) is defined but **unused** in code today. We don't change that. The TODO is explicit: `--repo-name` keeps winning unconditionally, and the collision-strategy config remains as it is. If anything, canonicalization *reduces* the number of accidental basename collisions, since same-repo-different-cwd cases now collapse onto one canonical name.

Tests for `derive_repo_name` don't exist yet — `tests/test_run_ids.py:32-43` only covers `slugify` directly (rejects empty input, lowercases kebab, strips unicode). The new test fits in alongside that class. There's no e2e test that exercises subpath-handling end-to-end through `new-run`.

The `/new-run` slash command (`agent-workbench-live/.claude/commands/new-run.md:59`) currently tells the agent **not** to pass `--repo-name` and to let CLI defaults apply. The doc has no mention of git-toplevel canonicalization. We add a one-line rule there per the TODO.

`cmd_new_run.py` has no existing non-fatal warning helper — the `_common.py:fail` helper exits non-zero, and stderr printing for non-fatal messages isn't a pattern in this file yet. Per the brief's *Assumptions* section, the optional drift warning is deferred unless it costs near zero. With no existing pattern to lean on, this run defers the warning to a follow-up TODO; we focus on the core canonicalization.

## Relevant files

- `agent-workbench-live/lib/cli/cmd_new_run.py:30-54` — repo-path resolution and `derive_repo_name` call site. The single behavior change happens here.
- `agent-workbench-live/lib/run_ids.py:52-54` — `derive_repo_name` definition. Module docstring updated; function body unchanged.
- `agent-workbench-live/lib/repos.py:27-38` — `_git` / `_git_strict` helpers. New `show_toplevel(path)` helper lands here (or alongside, exported).
- `agent-workbench-live/lib/runs.py:110-143` — `_git_common_dir`. Pattern reference for the new helper (5s timeout, None on error, no exception escape).
- `agent-workbench-live/tests/test_run_ids.py` — new test cases for canonicalization beside the existing `TestSlugify` class.
- `agent-workbench-live/.claude/commands/new-run.md` — add the one-line canonicalization rule the TODO calls for.
- `agent-workbench-live/agent-workbench.yaml:51` — read-only reference (`duplicate_repo_basename_strategy` stays as-is).

## Proposed changes

### 1. Add a `show_toplevel(path)` helper in `lib/repos.py`

Public function (not underscore-prefixed) that runs `git -C <path> rev-parse --show-toplevel` and returns either a resolved `pathlib.Path` or `None`. Match the `_git_common_dir` shape: 5-second timeout, returncode-zero check, strip and resolve, return `None` on any error (not-a-git-repo, timeout, OSError, empty output). No caching — `new-run` only calls it once per invocation, and caching adds state we don't need.

Signature:

```python
def show_toplevel(path: pathlib.Path) -> pathlib.Path | None:
    """Return ``git -C <path> rev-parse --show-toplevel`` resolved, or None if path is not inside a git repo."""
```

The helper itself is < 20 lines and only uses `subprocess.run` + `pathlib`. Place it in `lib/repos.py` near `_git_strict` so the git-subprocess code stays co-located.

### 2. Canonicalize in `cmd_new_run.py:54`

Today:

```python
repo_name = args.repo_name or run_ids.derive_repo_name(repo_path.name)
```

After:

```python
if args.repo_name:
    repo_name = args.repo_name
else:
    canonical_basename = _canonical_repo_basename(repo_path, repo_mode)
    repo_name = run_ids.derive_repo_name(canonical_basename)
```

With a private helper in the same file:

```python
def _canonical_repo_basename(repo_path: pathlib.Path, repo_mode: str) -> str:
    """Return the basename used as input to derive_repo_name. For existing
    repos, this is the git toplevel's basename; for the new-repo flow (no git
    repo yet) or any path not inside a git repo, fall back to repo_path.name."""
    if repo_mode != "existing":
        return repo_path.name
    toplevel = repos.show_toplevel(repo_path)
    if toplevel is None:
        return repo_path.name
    return toplevel.name
```

This keeps the change localized: one new helper module-function in `cmd_new_run.py`, one new helper in `lib/repos.py`. `derive_repo_name`'s signature is unchanged. `--repo-name` precedence is preserved by the `if args.repo_name` branch. The new-repo flow is preserved because `repo_mode == "new"` bypasses toplevel resolution. Non-git-repo paths (e.g. user passes a directory that exists but isn't a git repo) get the old behavior because `show_toplevel` returns `None`.

### 3. Documentation

- **`lib/run_ids.py` module docstring**: add a one-line note that `repo_name` is intended to be the slugified basename of the git toplevel — `derive_repo_name` itself is dumb and slugifies whatever it receives, but the convention enforced by the caller is "give it the toplevel basename."
- **`agent-workbench-live/.claude/commands/new-run.md`**: append a single bullet under "What you never do" or similar, stating: "`repo_name` defaults to the slugified basename of the *git toplevel*, not the path you typed. Use `--repo-name` to override."

### 4. Test coverage in `tests/test_run_ids.py`

Add a `TestCanonicalRepoName` class (or extend `TestSlugify` — either fits) that:

- Creates a temp git repo via `subprocess.run(["git", "init", str(tmp_path)], ...)`.
- Calls the new `_canonical_repo_basename` helper (imported from `lib.cli.cmd_new_run`) with `repo_path=tmp_path / "sub" / "dir"` (which the test mkdir's first) and `repo_mode="existing"`. Asserts the returned basename equals `tmp_path.name`.
- Same setup but `repo_mode="new"`: asserts the returned basename equals `"dir"` (the subpath's own basename).
- Path that is not a git repo (a fresh non-git tmpdir): asserts the returned basename equals the path's basename (fallback).
- Round-trip through `derive_repo_name` (the public-API view): assert that for the subpath case, `derive_repo_name(_canonical_repo_basename(subpath, "existing"))` equals the toplevel's slugified basename, not `dir`.

Parametrize where the structure repeats. Keep tests focused — per the brief's QA scenarios.

### 5. (Deferred — not in this run) Optional drift warning

The brief's "User-facing behavior" section flags this as "only if no extra effort beyond a one-line warning." With no existing `warn` helper in `cmd_new_run.py` and no precedent for non-fatal stderr in this file, we'd need to introduce a small helper. That's enough scope-creep to defer to a follow-up TODO. **Decision recorded as DR-002 below.**

## Files likely to change

- `agent-workbench-live/lib/cli/cmd_new_run.py` — add `_canonical_repo_basename` helper, change line 54 to call it.
- `agent-workbench-live/lib/repos.py` — add `show_toplevel(path)` public function.
- `agent-workbench-live/lib/run_ids.py` — module docstring update only (one line, no behavior change).
- `agent-workbench-live/tests/test_run_ids.py` — new test class / cases for canonicalization.
- `agent-workbench-live/.claude/commands/new-run.md` — one-line rule about toplevel-basename default.

Estimated diff size: ~80–120 lines of code + tests + docs, including the test cases.

## Data model changes

None. `metadata.yaml` schema is untouched. The `target.repo.name` field still stores the same shape (slug). Existing on-disk metadata for pre-canonicalization runs continues to load and validate.

## UI changes

None. The CLI's stdout/stderr surface is unchanged. No new flags, no removed flags. The only user-visible effect is that the worktree lands under a different parent dir when the user previously got a non-canonical one.

## Test plan

**Unit (`tests/test_run_ids.py`):**

- `test_canonical_basename_uses_git_toplevel`: synthetic git repo at `tmp_path`, subpath input, `repo_mode="existing"` → basename equals `tmp_path.name`.
- `test_canonical_basename_new_repo_uses_path_basename`: same subpath, `repo_mode="new"` → basename is the subpath's own basename (no git toplevel call needed; the helper short-circuits).
- `test_canonical_basename_falls_back_when_not_git`: non-git tmpdir, `repo_mode="existing"` → returns the path's basename (graceful fallback).
- `test_derive_repo_name_via_canonical`: end-to-end through `derive_repo_name(_canonical_repo_basename(...))` — same as test 1 but asserts the final slugified result.
- Existing `TestSlugify` cases are not touched (they cover `slugify` directly, which is unchanged).

**Integration / e2e (`tests/test_e2e.py` — optional, only if the existing fixture style makes it trivial):**

- New case: `new-run --repo-path <synthetic-repo>/sub/path --idea-file …`. Inspect the resulting `metadata.yaml`'s `target.repo.name` and `target.worktree.path`. Assert `repo.name` equals the slugified toplevel basename and `worktree.path` contains `/<toplevel-slug>/`. If the existing `_new_run` helper doesn't accept subpath repos cleanly, defer this to a follow-up — the unit tests are sufficient for confidence at this layer.

**Manual smoke (post-build):**

- Run `agent-workbench new-run --repo-path /path/to/this-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live --idea-file /tmp/smoke.md --worktree-name smoke-canonical`. Assert the resulting worktree lands under `<worktrees_dir>/new-tech-monorepo/…` (canonical toplevel slug), not under `agent-workbench-live/` or `agentic-development-task-system-v3-ai/`.
- Run again with `--repo-name explicit-override` and the same subpath. Assert the worktree lands under `<worktrees_dir>/explicit-override/…`.

## QA plan

Mirrors the brief's "Suggested QA scenarios" — see those bullets. The key human-visible checks are:

1. Same monorepo, two different subpaths → same parent dir under `worktrees/`.
2. `--repo-name foo` still wins, no warning suppression of the override.
3. `--new-repo-path` flow still creates the new repo and uses its basename.
4. Pointing at a non-git directory still works (falls back; no crash, no error).
5. `metadata.yaml`'s `target.repo.name` reflects the canonical name.
6. Existing pre-canonicalization worktrees on disk continue to work for their already-recorded runs.

## Risks

- **`git rev-parse` flakiness on slow filesystems.** Mitigated by the 5-second timeout (mirrors `_git_common_dir`). On timeout we fall back to the path basename — same behavior as today. Low risk.
- **Symlinked paths.** `git rev-parse --show-toplevel` resolves through symlinks per git's own logic. If a user passes `~/code-symlink/sub` where `~/code-symlink → ~/actual/repo`, git returns the canonical toplevel, and the slug matches whatever git reports. This is the *desired* behavior — it canonicalizes more than the brief promises, but consistently with how every other git command would treat that path. Document as DR-003.
- **Behavioral drift for users with prior worktrees under non-canonical parents.** Old worktrees keep working in-place. New worktrees go to the canonical parent. Users with active runs at the time of upgrade may see a split — but their old runs are not migrated, and the next run after upgrade simply lands under the canonical dir. Acceptable per the brief's non-goals (no migration).
- **`--repo-name` collision with a canonical name.** If a user previously created a worktree under `<worktrees_dir>/foo/` via `--repo-name foo`, and now an unrelated repo's canonical name is also `foo`, they collide as before. The pre-existing `duplicate_repo_basename_strategy` config governs this and is unaffected by our change. Low risk; the canonicalization narrows, not widens, the collision surface.
- **Test brittleness from `git init` in tmpdirs.** We rely on `git init` being available in test environments. The existing codebase already shells out to git in tests (see `tests/test_runs.py` patterns) — same assumption, no new risk.

## Definition of done

- `_canonical_repo_basename` helper in `cmd_new_run.py` and `show_toplevel` helper in `lib/repos.py` exist and are wired into the `repo_name` derivation path.
- `--repo-name` explicit override still wins unconditionally; verified by a unit test.
- `--new-repo-path` (new-repo bootstrap) path is unchanged; verified by a unit test.
- Non-git fallback works; verified by a unit test.
- Unit tests in `tests/test_run_ids.py` pass and would have failed under the pre-change code (specifically: the toplevel-uses-subpath assertion).
- Module docstring in `lib/run_ids.py` and slash-command doc in `.claude/commands/new-run.md` reflect the new rule.
- Manual smoke verified: a second `new-run` from a different subpath of this same monorepo lands worktrees under the same `<worktrees_dir>/<canonical>/` parent.
- The build's own test suite (`bin/agent-workbench-test` or the equivalent test command used by CI for this repo) is green.

## Preflight

- **Repo path resolved:** `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai` (existing, mode=existing).
- **Worktree path:** `/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260527__canonicalize-repo-name-by-git-toplevel` — note this run's own worktree is under `agentic-development-task-system-v3-ai/`, which is **exactly the kind of non-canonical placement this run will fix**. After this lands, future runs targeting the same monorepo will land under a canonical `new-tech-monorepo/` parent. This run's own worktree stays where it is.
- **Base ref:** `HEAD` at `6374738271e4f8284f11c830fefe79f844d12a04`.
- **Branch:** `agent/canonicalize-repo-name-by-git-toplevel`.
- **Tooling assumptions:** Python (existing repo runtime, no version bump). `git` binary on PATH (already required by the workbench).
- **Dependency hygiene:** No new dependencies. `subprocess` and `pathlib` are stdlib. The 5-second timeout pattern is already in-house (`lib/runs.py:_git_common_dir`).
- **No-op for in-flight runs:** This change only affects `new-run`. Already-created runs are not re-namespaced.

## Decisions & assumptions

### DR-001
- **Decision**: Resolve the git toplevel via `subprocess.run(["git", "-C", str(path), "rev-parse", "--show-toplevel"], ...)` in a new helper `show_toplevel(path)` in `lib/repos.py`, mirroring the shape of `_git_common_dir` in `lib/runs.py`.
- **Rationale**: The pattern is already in-house, tested in production (`_git_common_dir` is on the hot path for run-status queries), and avoids re-inventing path-walking-to-find-`.git` logic that handles submodules, worktrees, and symlinks correctly only when delegated to git itself.
- **Alternatives considered**: (a) Walk up parent dirs looking for a `.git` directory by hand. (b) Use `GitPython` or another git library. (c) Reuse `_git_common_dir` and derive toplevel from it.
- **Why not the alternatives**: (a) re-implements git's own logic incorrectly for symlinks/submodules — explicitly called out as a "bad example" in the brief. (b) introduces a heavyweight dependency for a single one-line wrapper. (c) `--git-common-dir` and `--show-toplevel` return different things (the former points at `.git/`, the latter at the repo root); deriving toplevel from common-dir requires assumptions about `.git` being a sibling of toplevel which break for worktrees.

### DR-002
- **Decision**: Defer the optional drift warning (canonical name `foo` exists at `<worktrees_dir>/foo-subpath/` but not `<worktrees_dir>/foo/`) to a follow-up TODO. Out of scope for this run.
- **Rationale**: `cmd_new_run.py` has no existing non-fatal warning pattern. The brief's "User-facing behavior" section explicitly conditions this feature on "only if no extra effort beyond a one-line warning." Adding a warning helper, deciding where it prints (stderr vs structured event), and wiring it into the CLI's output contract are non-trivial.
- **Alternatives considered**: (a) Print directly to `sys.stderr` from `cmd_new_run.py` ad-hoc. (b) Add a `warn()` helper in `_common.py`. (c) Emit a `Warning` event into the run's event log.
- **Why not the alternatives**: (a) sets a bad precedent that other CLI commands will copy badly. (b) is sound but is scope creep for this run. (c) requires schema and event-log surface changes — much larger than the brief's "one-line warning" budget. The follow-up TODO can pick the right shape carefully.

### DR-003
- **Decision**: Accept whatever `git rev-parse --show-toplevel` returns as canonical, including symlink resolution. Do not normalize further (no `realpath`, no string-equality canonicalization beyond what git itself does).
- **Rationale**: Cross-machine path canonicalization (`/Users/x` vs `/home/x` symlinks) is explicitly out of scope per the brief's non-goals. Delegating to git's own resolution rules means `repo_name` is consistent with how every other git command in the workbench treats the path.
- **Alternatives considered**: (a) Call `Path.resolve()` after git returns its answer, to follow any further symlinks git missed. (b) Lowercase / case-fold for case-insensitive filesystems.
- **Why not the alternatives**: (a) doubles up resolution and may diverge from git's view; not needed. (b) `slugify` already lowercases — this is solved downstream.

### DR-004
- **Decision**: Implement `_canonical_repo_basename` as a private helper inside `cmd_new_run.py` rather than as a public function in `lib/run_ids.py`.
- **Rationale**: The canonicalization rule lives at the *caller* of `derive_repo_name`, not in `derive_repo_name` itself. `derive_repo_name` is a pure slugify; it must not know about git or filesystem state. Keeping the helper next to its single use site preserves layering (`lib/run_ids.py` stays pure; `lib/cli/cmd_new_run.py` owns the policy).
- **Alternatives considered**: (a) Make `derive_repo_name(path, mode)` and do the git call inside it. (b) Make `_canonical_repo_basename` a public helper in `lib/repos.py` next to `show_toplevel`.
- **Why not the alternatives**: (a) turns a 3-line pure function into an impure git-aware function, harder to test and reason about. (b) `lib/repos.py` is about git operations on repos; the basename-policy helper is CLI-specific naming policy. Closer to `cmd_new_run.py`'s domain.

### ASM-001
- **Text**: The `_git_common_dir` pattern in `lib/runs.py:110-143` (5-second timeout, return `None` on any failure, no exception escape) is the right shape to reuse for `show_toplevel`. The 5-second timeout is appropriate for `new-run` — slow enough that legitimate git calls finish, fast enough that a hung filesystem doesn't block the whole CLI.
- **Reason**: The pattern is in production use and well-shaped for the same kind of "best-effort path resolution that must not crash the run" semantics we need.
- **Impact**: low — if the timeout turns out to be wrong we can tune it without touching the public API.

### ASM-002
- **Text**: `tests/test_run_ids.py` accepts adding new test classes that shell out to `git init` in a `tmp_path` fixture. Other tests in the repo do this (per the broader test conventions); the new test class won't be the first to require a real git binary in the test env.
- **Reason**: The codebase already runs `git` from tests (see `tests/test_runs.py` and the e2e suite). Adding one more `git init` call doesn't introduce a new requirement.
- **Impact**: low — if `git` is missing in the test env, the new tests fail loudly and obviously, same as the existing tests would.

### ASM-003
- **Text**: The `naming.duplicate_repo_basename_strategy: require_repo_name_override` config key remains unimplemented and is **not** touched by this run. The brief is clear: `--repo-name` semantics are preserved exactly as today.
- **Reason**: Implementing the collision strategy is a separate concern with its own scope, error-handling needs, and config-schema implications. The TODO scopes our change to canonicalization only.
- **Impact**: medium — if a future reviewer expects collision-detection to land alongside canonicalization, we need to point them at the brief's non-goals and at this assumption.

### ASM-004
- **Text**: The agent-workbench test suite is runnable from the workbench root via the existing test command (likely `pytest` directly, given `tests/test_run_ids.py` shape). The build stage will discover the exact invocation when it runs tests.
- **Reason**: Standard Python test layout; no signal from the brief or the recent commits that a custom runner is required.
- **Impact**: low — at build time we discover and use whatever command already works locally.
