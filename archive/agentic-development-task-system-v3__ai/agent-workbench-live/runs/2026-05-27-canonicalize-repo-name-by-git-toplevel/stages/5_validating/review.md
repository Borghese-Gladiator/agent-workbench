# Review

<!--
Adversarial self-review against brief.md + plan.md.
The reviewer is not the builder.
-->

## Decision

approve

## Did the implementation satisfy the brief?

Yes. The brief's acceptance criteria are all covered:

- **Same second-level dir from any subpath**: `_canonical_repo_basename` in `lib/cli/cmd_new_run.py:14-28` calls `repos.show_toplevel(repo_path)` and returns the toplevel's basename whenever the path is inside a git repo. The unit test `test_existing_repo_subpath_resolves_to_toplevel` proves a `sub/dir` subpath derives the repo's toplevel name, not `"dir"`. An out-of-test smoke run confirms two distinct subpaths of the same repo both derive `repo_name=my-actual-monorepo`.
- **`--repo-name` wins unconditionally**: `cmd_new_run.py:71-76` short-circuits on `args.repo_name` *before* calling `_canonical_repo_basename`, so the override path never touches git at all. Confirmed by re-reading the source.
- **`--new-repo-path` flow still works**: `_canonical_repo_basename` early-returns `repo_path.name` when `repo_mode != "existing"` (line 23). The `new` branch's own bootstrap (`repos.create_new`) runs after, so the basename used for `repo_name` matches the eventually-created repo's name. Covered by `test_new_repo_mode_uses_path_basename`.
- **New test fails under pre-change code path**: `test_round_trip_through_derive_repo_name` would have asserted `repo_name == "api"` before the change (subpath basename slugify) and now asserts `repo_name == "cool-monorepo"` (toplevel basename slugify), with an explicit `assertNotEqual(repo_name, "api")` to prevent silent regression.
- **Docstring + slash-command doc updated**: `lib/run_ids.py:8-12` and `.claude/commands/new-run.md:61` both carry the new rule.

## Did it accidentally expand scope?

No. The diff is one commit (`b52a9c6`) touching 5 files for +121/-1. The only "extra" surface is the public-ish helper `show_toplevel` in `lib/repos.py` — but per DR-001 that's exactly the right place for it, and it mirrors the existing `_git_common_dir` shape from `lib/runs.py`. The optional drift warning (brief's "User-facing behavior" §2) is correctly deferred to a follow-up per DR-002.

## Are there fragile assumptions?

A few worth flagging — none rising to "blocker":

1. **`pathlib.Path(raw).resolve()` on git's output (`lib/repos.py:65`)** — DR-003 said "do not normalize further", but the implementation *does* call `.resolve()`. This is benign in practice because git already returns the resolved real path of toplevel, so `.resolve()` is a no-op for that input. But it's a minor contradiction with the stated decision. Acceptable; the slugify downstream lowercases anyway so the only observable effect would be on hypothetical case-insensitive filesystems, where it's still consistent.
2. **5-second timeout claimed in ASM-001 is not actually present.** `show_toplevel` invokes `_git`, which calls `subprocess.run` *without* a timeout. ASM-001 said the pattern would mirror `_git_common_dir`'s 5-second timeout; in fact `_git` in `lib/repos.py:27-30` has no timeout. A hung filesystem could block `new-run` indefinitely. Low likelihood, but worth noting as a follow-up.
3. **`is_git_repo` is not used before `show_toplevel`.** The helper does its own `path.exists()` guard and then trusts `git rev-parse --show-toplevel` to fail-with-nonzero on a non-git path. That's fine — git does the right thing — but it's a subtle layering choice (the helper *replaces* what could have been an `is_git_repo` guard with a direct git call). The fallback to `repo_path.name` keeps it safe.

## Are there missing tests?

The covered surface is solid for the 5-test budget. Tests not present that *could* be added later:

- A test where `--repo-name` is explicitly passed alongside a subpath, to lock in the "override wins" semantics at the integration level (the unit test layer reaches `_canonical_repo_basename` directly, bypassing the `if args.repo_name:` branch in `cmd_new_run.py`). The branch is exercised by other `new-run` integration tests that pass `--repo-name`; the override behavior is unchanged by this diff, so coverage is not regressed. Worth adding a focused test if/when the helper grows.
- A test where the path is a symlink into the repo. The smoke run I executed confirms it works (the symlinked path resolves to the actual repo's toplevel), but it's not in the suite.
- A test that exercises `--repo-name` + a deep subpath end-to-end. Not strictly needed because the code path is already clear, but it'd lock in the contract.

Not blocking.

## Are there security / data loss / migration risks?

None I can find.

- **No path traversal**: `show_toplevel` takes a `pathlib.Path` and passes it via `git -C <path>`. git rejects paths outside any repo with a non-zero exit, which the helper handles.
- **No data loss**: the change is purely about *naming* a new worktree directory. It does not move, merge, or touch existing `<worktrees_dir>/foo-subpath/` directories. Existing per-subpath worktrees stay where they are; only future `new-run`s land in the canonical dir. The brief explicitly says no migration.
- **No `--repo-name` semantics drift**: the override behavior is preserved exactly.
- **`subprocess.run` without `shell=True`**: confirmed in `lib/repos.py:29`.

Migration risk worth flagging for the human: any existing worktrees under non-canonical names (e.g. the user's current `agent-workbench-live/`, `agentic-development-task-system-v3-ai/` parents) will remain, and a follow-on `new-run` for that same repo will land under a *third* parent (the canonical one). The drift warning per DR-002 is the right way to surface this — and it's correctly deferred. The human may want to make the follow-up TODO concrete before merging.

## What should the human review first?

1. Run `agent-workbench new-run --repo-path <monorepo>` from two distinct subpaths of the same repo with the same `--worktree-name` template and confirm both lands under the same `<worktrees_dir>/<canonical>/`. This is the acceptance criterion.
2. Verify DR-002's deferral of the drift warning is acceptable, or queue the follow-up TODO. The user reported real drift (3 different parents for the same monorepo) — they may want the warning before they're satisfied.
3. Sanity-check that DR-003's `.resolve()` call on git's output (`lib/repos.py:65`) is genuinely a no-op on the platforms they care about. macOS `/var → /private/var` is the obvious concern; the test's own `setUp` had to call `.resolve()` on the tmpdir to work around it, which proves the test team is already aware.
4. Confirm the 2 pre-existing snapshot failures in `tests/test_human_review.py` (`test_happy_snapshot`, `test_bounce_pass2_snapshot`) are not something they want addressed in this run. They're date-pinned snapshots (`2026-05-22-*-snap` vs `2026-05-27-*-snap`) that have nothing to do with this diff.

## Blast radius

From `blast-radius.txt`:

**Depth 1** (changed files): 5 source files, all expected and listed in the brief.

**Depth 2** (direct callers of changed symbols):
- `show_toplevel` → only `cmd_new_run.py`. Single caller, as designed (DR-001 + DR-004).
- `_canonical_repo_basename` → only `tests/test_run_ids.py`. Private helper, single test consumer.
- `lib/cli/cmd_new_run.py:register` lights up a noisy "depth-2" list of agentic-development-task-system-v1/v2 archive paths, scaffolds, and unrelated repos under the umbrella monorepo — but these are coincidental name matches on the generic word `register`, not real callers of `cmd_new_run.register`. The CLI's depth-1 scope-creep check did NOT flag any new file additions outside the expected scope.

**Depth 3**: a long alternation tree because `register`/`setUp`/`tearDown` are generic test-framework names. Nothing in the depth-3 set is a real caller of the changed symbols; the noise is from `git grep` matching identifiers by name across the whole umbrella monorepo. No scope-creep concern.

**Net**: blast radius is appropriately small. The change is exactly where the brief said it would be.

## Findings

(none rising above "minor" — see Fragile assumptions and Missing tests sections above for follow-ups worth queuing.)
