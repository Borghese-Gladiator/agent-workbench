# Implementation plan

## Current repo understanding

`lib/metrics/lines.py:count_generated()` and `count_accepted()` are the only consumers of the metrics line-count path. They both shell to git inside the worktree and use `base_ref` as the left-hand side of a dotted range (`<base_ref>..HEAD` for generated, `<base_ref>...<sha>` for accepted). The string `base_ref` is read from `metadata.target.repo.base_ref` by `lib/metrics/writer.py:212` and passed through. The workbench config defaults `base_ref: HEAD` (`agent-workbench.yaml:14`), and `lib/cli/cmd_new_run.py:42` writes the literal `"HEAD"` to `metadata.target.repo.base_ref`. `HEAD..HEAD` resolves to zero commits, so `generated_lines` always reports 0 for default-config runs.

The worktree branch created by `lib/repos.py:create_worktree()` is forked off whatever `base_ref` points to at that moment — i.e. the source repo's `HEAD` commit. Resolving `HEAD` → SHA against the **source repo** at `/start` time gives the exact commit boundary the worktree branched from, which is what we want for `<base_ref>..HEAD`. Resolving `HEAD` later inside the worktree would resolve to the worktree's current HEAD (after the builder lands commits), which is wrong.

`lib/repos.py:current_branch()` already exists (used by `resolve_parent_branch`) and is the right shape for branch-name resolution, but for our needs we want the raw 40-char SHA via `git rev-parse <base_ref>`. We can add a thin helper or do the rev-parse inline.

Other `base_ref` consumers exist but are out of scope for this run:
- `lib/board/source.py:_git_shortstat` runs `git diff --shortstat <base_ref>...HEAD` inside the worktree; the `HEAD...HEAD` triple-dot resolves to a real diff if the worktree has new commits, so this is **not** broken the same way. Out of scope.
- `lib/doc_claims.py:77` runs `git diff --name-only <base_ref>...HEAD` — same triple-dot form, also not broken the same way. Out of scope.
- `lib/audit.py:64` prints `base_ref` cosmetically. Out of scope.

## Relevant files

- `agent-workbench-live/lib/metrics/lines.py` — the buggy consumer. Both `count_generated` and `count_accepted` take `base_ref: str`. The fix prefers `base_ref_sha` if present; else lazily resolves via `git rev-parse <base_ref>` inside the worktree.
- `agent-workbench-live/lib/metrics/writer.py:209-231` — call site. Reads `repo.base_ref`; needs to also read `repo.base_ref_sha` and pass it through.
- `agent-workbench-live/lib/cli/cmd_start.py:52-69` — call site for `create_worktree`. Add SHA resolution before the `create_worktree` call (against the **source repo**), persist via `metadata.update(...)`.
- `agent-workbench-live/lib/repos.py` — git plumbing. We may add a small `resolve_ref_to_sha(repo_path, ref) -> str` helper for the `/start` resolution path, returning the 40-char hex via `git rev-parse <ref>`. Reuses the existing `_git_strict` machinery.
- `agent-workbench-live/schemas/run-metadata.yaml` — declare `base_ref_sha` as an optional field on `target.repo` (and add to the illustrative `template:` block with `null` to keep documentation honest).
- `agent-workbench-live/tests/test_metrics_lines.py` — regression coverage for the symbolic-`HEAD`-with-resolved-SHA case + the lazy-resolver fallback case + the `count_accepted` parallel case.
- `agent-workbench-live/tests/test_repos.py` — coverage for the new `resolve_ref_to_sha` helper.

## Proposed changes

### 1. New helper in `lib/repos.py` — `resolve_ref_to_sha(repo_path, ref) -> str`

```python
def resolve_ref_to_sha(repo_path: pathlib.Path | str, ref: str) -> str:
    """Resolve a symbolic ref (HEAD, branch name, short sha) to a full 40-char SHA.

    Raises RepoError if the ref cannot be resolved.
    """
    sha = _git_strict(repo_path, "rev-parse", "--verify", ref).strip()
    if not sha or len(sha) < 7:
        raise RepoError(f"unexpected rev-parse output for {ref!r}: {sha!r}")
    return sha
```

Rationale for a new helper rather than inlining `subprocess.run`: matches the pattern of every other git call in the codebase, gives us one place to test, and surfaces clean errors through `RepoError`.

### 2. `lib/cli/cmd_start.py` — capture and persist the SHA

Inside `run()`, after reading `base_ref` from metadata, before `repos.create_worktree`:

```python
try:
    base_ref_sha = repos.resolve_ref_to_sha(repo_path, base_ref)
except repos.RepoError as e:
    return fail(f"failed to resolve base_ref {base_ref!r}: {e}", 2)
```

Then create the worktree as before. After the worktree exists (so the `git worktree add` had a chance to fail loudly first), extend the existing `_m` mutator to also persist the SHA:

```python
def _m(d):
    d["target"]["worktree"]["path"] = str(worktree_path)
    d["target"]["worktree"]["created"] = True
    d["target"]["repo"]["base_ref_sha"] = base_ref_sha
metadata.update(cfg, run_id, _m)
```

No transition-evidence change needed — the existing `base_ref` value still goes into the transition evidence as before.

### 3. `lib/metrics/lines.py` — prefer SHA, lazy fallback

Add an optional `base_ref_sha` parameter to both `count_generated` and `count_accepted`. When provided, use it instead of `base_ref` in the git command. When absent, attempt a lazy `git rev-parse <base_ref>` inside the worktree; if that fails (or returns empty), fall back to the original symbolic `base_ref` (matching today's behavior — strict improvement, never a regression).

Sketch:

```python
def _effective_ref(worktree_path: str, base_ref: str, base_ref_sha: str | None) -> str:
    if base_ref_sha:
        return base_ref_sha
    # Lazy migration for pre-existing runs (metadata.yaml predates base_ref_sha).
    try:
        proc = subprocess.run(
            ["git", "-C", worktree_path, "rev-parse", base_ref],
            capture_output=True, text=True, check=False,
        )
    except FileNotFoundError:
        return base_ref
    if proc.returncode == 0:
        sha = proc.stdout.strip()
        if sha:
            return sha
    return base_ref
```

Then `_worktree_log_added` and `count_accepted`'s `git diff` both use `_effective_ref(...)` as the left-hand side of the range.

### 4. `lib/metrics/writer.py` — pass the new field

`repo.get("base_ref_sha")` next to the existing `repo.get("base_ref")`; pass through to both `count_generated` and `count_accepted`.

### 5. `schemas/run-metadata.yaml` — additive field

Under `target.repo.fields`, add:

```yaml
base_ref_sha:
  type:
    - string
    - null
  description: 40-char SHA `base_ref` resolved to at `/start` time. Optional for backward compatibility — older runs use a lazy resolver in lib/metrics/lines.py.
```

Add `base_ref_sha: null` to the illustrative `template.target.repo` block.

### 6. Tests — see Test plan below.

## Files likely to change

- `agent-workbench-live/lib/metrics/lines.py` — add `_effective_ref`, add `base_ref_sha` param to both public functions.
- `agent-workbench-live/lib/metrics/writer.py` — pass `base_ref_sha` through.
- `agent-workbench-live/lib/cli/cmd_start.py` — resolve and persist SHA.
- `agent-workbench-live/lib/repos.py` — new `resolve_ref_to_sha` helper.
- `agent-workbench-live/schemas/run-metadata.yaml` — additive field declaration + template stub.
- `agent-workbench-live/tests/test_metrics_lines.py` — new cases.
- `agent-workbench-live/tests/test_repos.py` — new case for `resolve_ref_to_sha`.

## Data model changes

`target.repo.base_ref_sha` (optional, string or null). Purely additive — no existing field semantics change. Old `metadata.yaml` files without the field continue to load fine (the metadata loader does not validate every nested field in `target.repo`).

`target.repo.base_ref` retains its current string-or-`HEAD` semantics. The literal `"HEAD"` is no longer load-bearing for the metrics path but stays for human readability and for any future logic that wants to know the symbolic intent.

## UI changes

None. No CLI flags, no new commands, no banner changes. Only the *numbers* change.

## Test plan

### Unit tests (`tests/`)

1. `test_repos.py::test_resolve_ref_to_sha_head` — tmp repo with one commit; `resolve_ref_to_sha(tmp, "HEAD")` returns the same SHA as `git rev-parse HEAD`.
2. `test_repos.py::test_resolve_ref_to_sha_branch_name` — same tmp repo on `main`; `resolve_ref_to_sha(tmp, "main")` returns the commit SHA.
3. `test_repos.py::test_resolve_ref_to_sha_missing_raises` — `resolve_ref_to_sha(tmp, "nope")` raises `RepoError`.
4. `test_metrics_lines.py::test_generated_with_base_ref_sha` — tmp repo with initial commit, switch to feature branch, add one commit with 3 lines. Call `count_generated(worktree_path=tmp, base_ref="HEAD", base_ref_sha=<initial-sha>, events_path=None)`. Assert n == 3. **This is the regression test the brief calls for.**
5. `test_metrics_lines.py::test_generated_lazy_resolver_head` — same tmp repo, no `base_ref_sha`. Call with `base_ref="main"` (so the lazy resolver inside the worktree resolves "main"). Assert n == 3.
6. `test_metrics_lines.py::test_generated_lazy_resolver_falls_back_on_bad_ref` — `base_ref="nonexistent"`, no `base_ref_sha`. Lazy `rev-parse` fails; function falls back to symbolic `"nonexistent"`; `git log <nonexistent>..HEAD` also fails; returns 0. (No crash — that's the assertion.)
7. `test_metrics_lines.py::test_accepted_with_base_ref_sha` — parallel: tmp repo with initial + a follow-up merge commit; call `count_accepted(..., base_ref="HEAD", base_ref_sha=<initial-sha>, completion_ref=<merge-sha>)`. Assert non-zero `accepted_lines`.

### Smoke / behavioral

8. Manually validate the lazy-resolver path against the dogfood run's existing worktree (if it still exists on disk): run `agent-workbench metrics 2026-05-22-token-efficiency-tracking --rebuild`, then read the resulting `metrics.jsonl` and assert the `kind: line_count, phase: generated` row has a non-zero `lines` value. Document the result in `qa/report.md`. (Best-effort, per ASM-005.)

### Existing-test impact

- `test_e2e.py` drives runs through `/start`. The new `base_ref_sha` will appear in `metadata.yaml`. To confirm during build whether any snapshot test pins the literal metadata payload — if it does, regenerate the snapshot. If it doesn't, no change.
- `test_metrics_writer.py` constructs metadata manually for its tests. Adding the new param to `count_generated` / `count_accepted` is backwards-compatible because the new param has a `None` default, so writer-side tests don't need to change.

## QA plan

- **QA-1** Run the full unit suite from the repo root: `cd agent-workbench-live && python -m pytest tests/ -q`. Expect green except for the two pre-existing date-baked snapshot failures the LOG.md mentions on master.
- **QA-2** Create a brand-new run end-to-end inside the run's worktree:
  1. Spin up a tmp scratch repo with one commit.
  2. `agent-workbench new-run --repo-path <scratch>` with an inline idea.
  3. Stub the brief + plan minimally so the gate passes.
  4. `agent-workbench start <id> --approved-by manual-qa`.
  5. Verify `runs/<id>/metadata.yaml` now has `target.repo.base_ref_sha: <40-char-sha>`.
  6. Inside the worktree, land a commit that adds N lines.
  7. `agent-workbench metrics <id> --rebuild`.
  8. Inspect `runs/<id>/metrics.jsonl` — the `kind: line_count, phase: generated` row should report N.
- **QA-3** (dogfood, best-effort) `agent-workbench metrics 2026-05-22-token-efficiency-tracking --rebuild`. If the worktree still exists, assert the new `generated_lines` is non-zero. If the worktree has been pruned, document in `qa/report.md` that QA-3 was unreachable.
- **QA-4** Confirm `agent-workbench` doctor / schema-validate paths (whichever exist) still accept every existing `runs/*/metadata.yaml`. Run `agent-workbench doctor` if such a command exists; otherwise sample 3–5 `metadata.yaml` files and confirm they still load via `metadata.load`.

## Risks

- **R-1** A new run's `/start` could fail on a repo that has `HEAD` pointing nowhere (no commits yet, detached + unborn). Mitigation: surface the `RepoError` as a clean `fail(...)`. The existing `verify_existing` step at `/new-run` already guards against most of this (`ref_exists` is called), so this is mostly a safety net.
- **R-2** The lazy resolver inside the worktree calls `git rev-parse <base_ref>`. If the worktree branch has *advanced* and `base_ref` is `HEAD`, the lazy resolver will resolve `HEAD` to the **current** worktree HEAD — which is exactly the bug we're trying to fix (the dotted range collapses to "no commits"). Mitigation: this is *only* a fallback for pre-existing runs that lack `base_ref_sha`; new runs always get a captured SHA at `/start`. For the dogfood run, the worktree's history walked back from HEAD will include all the commits since the original fork point, so as long as `base_ref="HEAD"` resolves to the worktree's current HEAD, the lazy resolver still produces 0. This means **the dogfood-run recompute acceptance criterion (QA-3) is impossible to satisfy by the lazy resolver alone** for runs whose `base_ref` is `HEAD` and whose worktree HEAD has advanced. The brief calls this out as best-effort. To document explicitly in `decisions.md` (DR-001).
- **R-3** Cmd_start lives behind the `building` transition gate, which calls `transitions.transition(...)` with the evidence dict. If we mutate `metadata` *after* the transition emits its evidence, the audit log loses the SHA. Mitigation: persist SHA via the existing `_m(d)` mutator (which runs before `transitions.transition`), so the audit picture is consistent.
- **R-4** A test in `test_e2e.py` could compare snapshot YAML against a literal `metadata.yaml` payload and bork on the new field. Mitigation: confirm during build, regenerate if needed (snapshots that include `target.repo.*` should be regenerated to include `base_ref_sha`).
- **R-5** `resolve_ref_to_sha` uses `git rev-parse --verify <ref>`. Symbolic refs like `HEAD` work; ambiguous refs fail with a non-zero exit; commit SHAs round-trip to themselves. No surprises expected.

## Definition of done

- All unit tests pass except the two pre-existing date-baked snapshot drifts noted in LOG.md.
- A new run's `metadata.yaml` after `/start` contains `target.repo.base_ref_sha: <40-char hex>`.
- `agent-workbench metrics <new-run-id> --rebuild` on a new run with one or more commits on the worktree branch reports non-zero `generated_lines`.
- The dogfood-run recompute (QA-3) result is documented in `qa/report.md` — either it produces non-zero `generated_lines`, or the report explains why R-2 makes that impossible for runs whose `base_ref="HEAD"` and whose worktree HEAD has advanced (the brief says best-effort).
- `tests/test_metrics_lines.py` has the regression test from the brief.
- `schemas/run-metadata.yaml` declares `base_ref_sha` optional; existing `metadata.yaml` files still validate.
- No `metadata.yaml` file under `runs/*/` is rewritten by this PR. (Read-only `metrics --rebuild` only writes `metrics.jsonl`.)

## Preflight

- Tooling: Python 3.10+ (per `~/.claude/CLAUDE.md`); `git` available on PATH.
- Repo state: clean working tree at `master` per pre-run `git status`. One untracked dir for the parallel run `2026-05-24-cli-stop-banner-on-agent-stopping-transitions` exists — out of scope, leave alone.
- Dependencies: no new pip packages. Only `subprocess` + stdlib.
- Test runner: `python -m pytest` from `agent-workbench-live/` (per `tests/README.md` — to verify during build).
- Branch: `agent/fix-generated-lines-base-ref-head` per the worktree-name template. No collision (verified via `git show-ref refs/heads/agent/fix-generated-lines-base-ref-head` — does not exist).
- Repo path resolved: `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai`.
- Base ref symbolic: `HEAD`; will be resolved to a SHA at `/start` (per this very fix — meta-validation).

## Decisions & assumptions

### DR-001
- **Decision**: Add `target.repo.base_ref_sha` (Option (a) from the brief) rather than rewriting `target.repo.base_ref` in place.
- **Rationale**: Brief explicitly prefers (a). Additive schema; keeps the symbolic-ref intent legible for humans reading `metadata.yaml`; doesn't lose information.
- **Alternatives considered**: (b) rewrite `base_ref` in place at `/start`; (c) compute SHA at metrics time only.
- **Why not the alternatives**: (b) loses the symbolic intent; (c) means `count_generated` for *new* runs depends on whatever HEAD is at metrics time, which can differ from the actual fork point — see R-2.

### DR-002
- **Decision**: Capture the SHA against the **source repo** at `/start` time, *before* the worktree exists. The lazy fallback in `lines.py` runs against the **worktree** at metrics time.
- **Rationale**: At `/start`, the worktree doesn't exist yet — `git worktree add` is the call we're about to make. The source repo's `HEAD` is what `worktree add` will fork from, so it's the right boundary.
- **Alternatives considered**: Capture inside the worktree post-`worktree add`.
- **Why not the alternatives**: Same SHA either way for fresh forks, but the source-repo flow is the one we *want* to model. Lazy fallback uses the worktree because the source-repo path may no longer be reachable from `lines.py`'s perspective (and the existing code already operates inside the worktree).

### DR-003
- **Decision**: Make `base_ref_sha` an optional metadata field; gate the lazy resolver on "field absent." Don't error out if it's absent — fall back transparently.
- **Rationale**: Migration story for existing runs without an explicit one-shot script. Brief: "Lazy resolver is simpler — recommended."
- **Alternatives considered**: One-shot migration script that touches every `runs/*/metadata.yaml`.
- **Why not the alternatives**: Brief explicitly chose lazy. Touching old metadata files violates "no rewrites" non-goal.

### DR-004
- **Decision**: Both `count_generated` and `count_accepted` get the new `base_ref_sha` parameter, even though the brief only calls out `count_generated` explicitly.
- **Rationale**: `count_accepted` has the same `<base_ref>...<sha>` bug for any run that landed a merge SHA but had `base_ref="HEAD"`. Fix the pattern in both places now.
- **Alternatives considered**: Fix only `count_generated`.
- **Why not the alternatives**: Leaves the same hole in `accepted_lines`. Cost of fixing both is small.

### DR-005
- **Decision**: The lazy fallback uses `git rev-parse` inside the **worktree**, not the source repo. If that fails or returns empty, fall back to the *symbolic* `base_ref` (today's behavior).
- **Rationale**: `lines.py` already operates inside the worktree (the `-C worktree_path` flag is on every git call). Reaching into the source repo from `lines.py` requires extra plumbing for `metadata.target.repo.path` and adds a failure mode (source repo deleted, moved, etc.). Per R-2, the lazy resolver is best-effort by design.
- **Alternatives considered**: Lazy resolution against the source repo via `metadata.target.repo.path`.
- **Why not the alternatives**: More plumbing, more failure modes, the brief's wording is "lazy resolver in `lines.py` that calls `git rev-parse` inside the worktree."

### ASM-001
- **Text**: `git rev-parse --verify HEAD` against the source repo at `/start` returns the same 40-char SHA that `git worktree add ... HEAD` will fork from.
- **Reason**: Git semantics — `worktree add <path> HEAD` resolves HEAD to its current commit and creates the new branch off that. No concurrent commit can land between the rev-parse and the worktree-add in normal local usage.
- **Impact**: medium. If wrong, the captured SHA could be off by one commit. We accept this as an inherent local-tool race.

### ASM-002
- **Text**: Existing `metadata.yaml` files under `runs/*/` will continue to load via `metadata.load()` without modification when we add an optional `base_ref_sha` field to the schema.
- **Reason**: `metadata.py:_validate` only enforces the `REQUIRED_TOP_LEVEL` keys + status enum. Nested `target.repo.*` is not strictly validated by the loader; the YAML schema in `schemas/run-metadata.yaml` is descriptive only at the moment.
- **Impact**: low. Verified by inspection of `metadata.py:68-77`.

### ASM-003
- **Text**: Existing E2E snapshot tests do not pin the literal contents of `metadata.yaml` such that adding a new optional field breaks them.
- **Reason**: Best assumption — snapshot tests typically compare run-output structure not the full metadata blob. To verify during build by running `test_e2e.py` early.
- **Impact**: medium. If wrong, snapshot regen is cheap.

### ASM-004
- **Text**: The dogfood run's worktree at `~/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/...` may or may not still exist on disk; QA-3 is best-effort regardless.
- **Reason**: The brief explicitly says best-effort. Worktree pruning is a normal user action.
- **Impact**: low.

### ASM-005
- **Text**: There is no `agent-workbench doctor` command that hard-validates every field in the YAML schema against `schemas/run-metadata.yaml`. (To verify in QA-4.)
- **Reason**: Spot-check of `lib/cli/cmd_doctor.py` would confirm; the validate path in `metadata.py:_validate` is shallow.
- **Impact**: low.
