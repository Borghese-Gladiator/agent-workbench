# Implementation plan

## Current repo understanding

The `base_ref_sha` prefer-SHA / lazy-resolve / fallback pattern was added by `303bd40` and lives today in `lib/metrics/lines.py:_effective_ref`. Five sites already consume it (the two metrics counters in `lines.py`, `metrics/writer.py`, `cmd_start.py`, `cmd_new_run.py`, and `cli/_stop_banner.py`). Four diff-emitting helpers do **not** consume it:

1. `lib/validate_context.py:build` and `build_blast_radius` — five `git diff …<base_ref>...HEAD…` call sites total
2. `lib/board/source.py:_git_shortstat`
3. `lib/doc_claims.py:verify`
4. `cmd_validate.py:_write_validate_context_artifacts` and the `doc_claims.verify` call site in `cmd_validate.py:_verify_doc_claims_staged` — the call-side glue that needs to read the SHA from metadata and thread it through

Three other `base_ref` consumers (`cmd_plan.py` evidence payloads, `cmd_show.py` print, `cmd_complete.py` parent-branch resolve) are intentionally **not** part of this run — they aren't diff-emitting code paths.

The pre-fix run `2026-05-22-token-efficiency-tracking` is still present with `base_ref: HEAD` and no `base_ref_sha`, confirming it is a valid backfill target.

Audit infrastructure: `lib/audit.py` uses an opt-in if-chain (line 126–134) for event-type inclusion plus a `_payload_summary` dispatch (line 163–184). Schema definitions live in `schemas/events.jsonl` as one JSON object per line with required/optional payload field lists.

Backfill template: `tools/backfill_completion_refs.py` is the shape to mirror — argparse with `--root` and `--dry-run`, a walk of `runs/*/metadata.yaml`, `yaml_io.loads` / `yaml_io.dumps`, summary line at the end.

## Relevant files

**Source (touched):**
- `agent-workbench-live/lib/validate_context.py` — `build`, `build_blast_radius`, five `_git(... "diff" ...)` call sites
- `agent-workbench-live/lib/board/source.py` — `_git_shortstat` (L311–344) and its caller (L586–588)
- `agent-workbench-live/lib/doc_claims.py` — `verify` (L62–86)
- `agent-workbench-live/lib/cli/cmd_validate.py` — `_write_validate_context_artifacts` (L46–84), `_verify_doc_claims_staged` (L188–233) and the symmetric flat-run helper if present
- `agent-workbench-live/lib/cli/cmd_start.py` — emit `BaseRefResolved` between L88 (metadata.update) and L97 (transition)
- `agent-workbench-live/lib/audit.py` — add `BaseRefResolved` to the inclusion list (L126–134) and to `_payload_summary` (L163–184)
- `agent-workbench-live/schemas/events.jsonl` — new event-schema line

**Source (read-only, template):**
- `agent-workbench-live/lib/metrics/lines.py:_effective_ref` (L60–75)
- `agent-workbench-live/lib/metrics/writer.py` (callers of `_effective_ref`)
- `agent-workbench-live/lib/cli/_stop_banner.py:_resolve_effective_ref` (similar pattern)
- `agent-workbench-live/lib/repos.py:resolve_ref_to_sha` (L53–61)
- `agent-workbench-live/lib/metadata.py:update` (L257–262), `metadata.load` (L108–117)
- `agent-workbench-live/lib/yaml_io.py` — `loads`/`dumps` used by the backfill
- `agent-workbench-live/tools/backfill_completion_refs.py` — argparse + walk + dry-run shape

**New:**
- `agent-workbench-live/tools/backfill_base_ref_sha.py` — the new backfill script

**Tests (new):**
- `agent-workbench-live/tests/test_validate_context_build.py` — extend with two-commit-worktree SHA case
- `agent-workbench-live/tests/test_doc_claims.py` — extend with prefer-SHA case
- `agent-workbench-live/tests/test_board_snapshot.py` — extend with `_git_shortstat` SHA case (the existing seed_run fixture doesn't drive a real git diff; a small sibling fixture is needed — see DR-005)
- `agent-workbench-live/tests/test_backfill_base_ref_sha.py` — new file, mirrors the existing backfill script's test if one exists; otherwise builds a synthetic `runs/` tree
- `agent-workbench-live/tests/test_cmd_start.py` (or extend existing) — assert the `BaseRefResolved` event is emitted in the right order
- `agent-workbench-live/tests/test_audit.py` (or extend) — assert the new event renders into `audit.md`

## Proposed changes

The work is the four sub-items from the brief (2a, 2b, 2c, 2d). Implementation order: **2a, 2b, 2d, 2c**. The reasoning: 2a is the highest-leverage fix, 2b is the type-symmetry fix that touches similar code, 2d adds the audit event we want emitted by the time the backfill runs, and 2c is last because its real-repo acceptance test exercises `metrics --rebuild` (which goes through `lines.py:_effective_ref`, not the new code paths). All four can land in one PR.

### 2a — `validate_context.build` + `build_blast_radius` accept `base_ref_sha`

1. In `lib/validate_context.py`, add a small private helper `_effective_ref(worktree_path, base_ref, base_ref_sha)` (mirrors `metrics/lines.py:_effective_ref`). Returns the SHA when present, lazy-resolves the symbolic ref via `git rev-parse <base_ref>^{commit}` in the worktree when missing, falls back to `base_ref` literal as last resort.
   - Decision: implement locally (DR-001) rather than import from `metrics/lines.py` to keep the metrics module's API surface stable.
2. Change `build(*, brief_path, plan_path, build_md_path, qa_report_path, worktree_path, base_ref, base_ref_sha=None) -> str` — add the new kwarg with `None` default for backward compat.
3. Change `build_blast_radius(*, worktree_path, base_ref, base_ref_sha=None) -> str` — same.
4. Resolve `effective_ref = _effective_ref(worktree_path, base_ref, base_ref_sha)` once at the top of each function. Replace every `f"{base_ref}...HEAD"` in the five `_git(...)` call sites (L192, L195, L210, L260, L282) with `f"{effective_ref}...HEAD"`.

### 2a/glue — `cmd_validate.py` reads and threads the SHA

5. In `_write_validate_context_artifacts` (L46–84): after reading `base_ref = repo.get("base_ref") or "HEAD"`, add `base_ref_sha = repo.get("base_ref_sha")`. Pass `base_ref_sha=base_ref_sha` to both `validate_context.build(...)` and `validate_context.build_blast_radius(...)`.
6. In `_verify_doc_claims_staged` (around L207–208): read `base_ref_sha` the same way and pass it through `doc_claims.verify`.
7. Check if there is a flat-run sibling helper that calls `validate_context.build` or `doc_claims.verify` and apply the same change. (Builder will confirm with a focused grep.)

### 2b — `board/source.py:_git_shortstat` + `doc_claims.py:verify` accept `base_ref_sha`

8. In `lib/doc_claims.py`, add `base_ref_sha: str | None = None` to `verify()`. Add an `_effective_ref` helper locally (or inline the prefer-SHA logic — two lines, no helper needed; see DR-002). Replace the symbolic `base_ref` in the `git diff --name-only <base_ref>...HEAD` invocation with the effective ref.
9. In `lib/board/source.py`, add `base_ref_sha: str | None = None` to `_git_shortstat()`. Apply the same effective-ref pattern at the top of the function. The `cache_key` should still be `(run_id, updated_at)` — the SHA doesn't need to enter the cache key because the SHA is bound to (run_id, updated_at) by metadata.
10. Update the call site in `board/source.py:586` (`load_run_snapshot`) — read `base_ref_sha` from the metadata dict (already loaded as `target.repo.base_ref_sha`) and pass it to `_git_shortstat`.

### 2d — `BaseRefResolved` event

11. In `schemas/events.jsonl`, append a new schema line: `{"schema_version":1,"kind":"event_schema","event_type":"BaseRefResolved","description":"Symbolic base_ref was resolved to a concrete SHA at /start.","required_fields":["schema_version","seq","event_id","run_id","at","actor","type","status","payload"],"payload_required":["symbolic_ref","sha"],"payload_optional":["source_repo_path"]}`. Match the field order and structure of the existing lines exactly.
12. In `cmd_start.py`, between L88 (the `metadata.update` that writes `base_ref_sha`) and L97 (the `transitions.transition` to `building`), call `events.append(cfg, run_id, type="BaseRefResolved", status="ok", payload={"symbolic_ref": base_ref, "sha": base_ref_sha, "source_repo_path": str(repo_path)}, actor=actor)`. Confirm the exact `events.append` API by reading `lib/events.py` before writing this — the call shape may differ (e.g. it may take a dataclass or a flat function call).
13. In `lib/audit.py`, add `"BaseRefResolved"` to the inclusion tuple at L126–134.
14. In `_payload_summary` (L163–184), add a branch:
    ```python
    if event_type == "BaseRefResolved":
        return f"`{payload.get('symbolic_ref','?')}` -> `{(payload.get('sha') or '')[:12]}`"
    ```

### 2c — `tools/backfill_base_ref_sha.py`

15. Create `tools/backfill_base_ref_sha.py` mirroring `tools/backfill_completion_refs.py`. Shape:
    ```python
    # argparse: --root (default workbench root) and --dry-run
    # walk runs_dir.glob("*/metadata.yaml")
    # for each metadata that has symbolic target.repo.base_ref and missing target.repo.base_ref_sha:
    #     branch = data["target"]["worktree"]["branch_name"]
    #     repo_path = data["target"]["repo"]["path"]
    #     default_base = cfg.defaults.base_ref  (or hardcode "HEAD" with a comment — see DR-006)
    #     sha = git -C <repo_path> merge-base <branch> <default_base>
    #     if merge-base fails: sha = git -C <repo_path> rev-list --max-parents=0 <branch> (first commit)
    #     write back via yaml_io.dumps after setting data["target"]["repo"]["base_ref_sha"] = sha
    # print a summary line at the end
    ```
16. Do **not** use `metadata.update` from the loaded `lib.metadata` module — that would require building a `Config` object inside the script, and `backfill_completion_refs.py` shows the project convention is `yaml_io.loads/dumps` directly. (See DR-007.)
17. After the script lands, run it once against `agent-workbench-live/` and confirm the live `2026-05-22-token-efficiency-tracking/metadata.yaml` gains a `base_ref_sha`. Then `agent-workbench metrics --rebuild` against that run id and confirm `generated_lines > 0`. (This is the acceptance test, not part of the unit-test suite.)

## Files likely to change

- `agent-workbench-live/lib/validate_context.py`
- `agent-workbench-live/lib/cli/cmd_validate.py`
- `agent-workbench-live/lib/board/source.py`
- `agent-workbench-live/lib/doc_claims.py`
- `agent-workbench-live/lib/cli/cmd_start.py`
- `agent-workbench-live/lib/audit.py`
- `agent-workbench-live/schemas/events.jsonl`
- `agent-workbench-live/tools/backfill_base_ref_sha.py` (new)
- `agent-workbench-live/tests/test_validate_context_build.py`
- `agent-workbench-live/tests/test_doc_claims.py`
- `agent-workbench-live/tests/test_board_snapshot.py`
- `agent-workbench-live/tests/test_backfill_base_ref_sha.py` (new)
- `agent-workbench-live/tests/test_cmd_start.py` (extend if exists, else new)
- `agent-workbench-live/tests/test_audit.py` (extend if exists)
- `docs/TODO.md` — strike §3 once acceptance is verified

## Data model changes

- `metadata.yaml` schema is **unchanged**. `target.repo.base_ref_sha` already exists and is populated by `cmd_start.py`. The backfill only populates it on older runs that predate the field.
- `schemas/events.jsonl` gains one new event schema line for `BaseRefResolved`.

## UI changes

None. `audit.md` is the only rendered surface that changes — the new event appears as one extra `- **BaseRefResolved** at <ts> by …: `<symbolic>` -> `<sha[:12]>`` line per run.

## Test plan

### Unit tests

- **`test_validate_context_build.py` — extend**
  - New test `test_build_prefers_base_ref_sha_over_symbolic_head`: synthetic two-commit worktree where `base_ref="HEAD"` and `base_ref_sha=<actual fork point>`. Call `validate_context.build(..., base_ref="HEAD", base_ref_sha=fork_sha)`. Assert the rendered text contains the names of files from the two worktree commits.
  - New test `test_build_falls_back_to_lazy_resolve_when_sha_missing`: same fixture, `base_ref_sha=None`. Assert it still resolves (may produce empty if lazy resolve can't recover — fine; the assertion is "does not crash").
  - New test `test_blast_radius_prefers_sha`: parallel coverage for `build_blast_radius`.
- **`test_doc_claims.py` — extend**
  - New test in `TestVerify`: with the existing `main`+`feat` fixture, capture `fork_sha = git merge-base main feat` before checkout, then call `verify(["README.md", "src.py"], repo, base_ref="HEAD", base_ref_sha=fork_sha)`. Assert `"README.md"` is returned (unverified) and `"src.py"` is not.
  - New negative test: `base_ref_sha=None` falls back to symbolic-ref path (the existing `TestVerify` coverage already exercises that — confirm it still passes).
- **`test_board_snapshot.py` — extend**
  - The existing `seed_run` fixture doesn't drive a real diff. Add a new test class `TestGitShortstatPrefersSHA` that builds a small real git repo (using the `_init_repo` pattern from `test_validate_context_build.py`) and calls `_git_shortstat(worktree_path, "HEAD", base_ref_sha=fork_sha, cache_key=("t","0"))` directly. Assert non-zero added lines.
- **`test_backfill_base_ref_sha.py` — new**
  - `test_dry_run_reports_change_but_writes_nothing`: synthetic workbench with one stale run (symbolic `base_ref`, no `base_ref_sha`) and one already-populated run. Run with `--dry-run`. Assert metadata.yaml byte-identical for both.
  - `test_write_path_populates_sha`: same fixture, run without `--dry-run`. Assert the stale run now has `target.repo.base_ref_sha` matching `git merge-base <branch> HEAD` on the synthetic repo.
  - `test_idempotency`: run twice in a row. Second run reports 0 changes.
  - `test_merge_base_fallback_to_root_commit`: synthetic orphan branch (no merge-base with default). Assert the script falls back to `git rev-list --max-parents=0` output.
  - `test_missing_worktree_skipped`: a run whose worktree path doesn't exist (deleted). Assert it's skipped with a printed warning, not a crash.
- **`test_cmd_start.py` (or new file)**
  - `test_emits_base_ref_resolved_event`: drive `/start` on a synthetic run, then walk `events.jsonl`. Assert there is exactly one `BaseRefResolved` event, that it appears before the `StatusTransitioned ready -> building` event, and that its payload has all three fields.
- **`test_audit.py` (extend if exists, else add minimal coverage)**
  - `test_audit_md_includes_base_ref_resolved`: synthesize an events.jsonl with one `BaseRefResolved`. Call the audit renderer. Assert the output contains a `- **BaseRefResolved**` bullet with the formatted summary.

### Manual / dogfood QA

- After the script lands, from the workbench root:
  - `agent-workbench-live/tools/backfill_base_ref_sha.py --root agent-workbench-live --dry-run` — should report at least one stale run.
  - `agent-workbench-live/tools/backfill_base_ref_sha.py --root agent-workbench-live` — actually write.
  - `agent-workbench-live/bin/agent-workbench metrics --rebuild 2026-05-22-token-efficiency-tracking` — should report a non-zero `generated_lines`.
- `grep -n 'base_ref' agent-workbench-live/lib/board/source.py agent-workbench-live/lib/doc_claims.py` — every match referring to the kwarg also names `base_ref_sha` somewhere on the same call.

## QA plan

Same as Suggested QA scenarios in `brief.md`. The unit-test plan above covers QA scenarios 1, 2, 3, 4, 5, 7, 8, and 10. The dogfood QA above covers scenarios 6 and 10. Scenario 9 (combined end-to-end through `/shape → /plan → /start → /validate`) is implicitly covered by the workbench's existing E2E test suite — those tests already run validate; with the new code in place they exercise the SHA path automatically.

## Risks

1. **Audit ordering test fragility.** Asserting `BaseRefResolved` appears between two specific transitions reads the events.jsonl file by seq number. If the existing seq generation isn't monotonic-with-emit-time, the test could be brittle. Mitigation: use seq-based assertions, not wall-clock.
2. **Default base ref in the backfill.** `agent-workbench.yaml` has `defaults.base_ref: HEAD`. Using "HEAD" as the merge-base argument is degenerate (`git merge-base <branch> HEAD` from inside the source repo gives the worktree's own HEAD, not what we want). Mitigation: the backfill should use the source repo's `HEAD` as observed from the source-repo working tree (not from inside the worktree). Concretely: `git -C <repo_path> merge-base <branch_name> HEAD` where `<repo_path>` is `target.repo.path` (the master repo, not the worktree). See DR-006 for the full reasoning.
3. **Worktree may have been deleted.** Pre-fix runs (2026-05-22-token-efficiency-tracking, etc.) may no longer have their worktrees. `git merge-base <branch> HEAD` only requires the branch ref to exist in the *source repo* — which it does because `agent-workbench-live/runs/*/metadata.yaml`'s `target.worktree.branch_name` refs are not pruned. Mitigation: backfill operates against `target.repo.path`, not the worktree path. Verified above.
4. **`backfill_completion_refs.py` hardcodes a `BACKFILL = {run_id: sha}` table.** The new backfill must *not* hardcode anything; it must walk and discover. The shape is similar (argparse + walk + dry-run) but the body differs structurally. Don't copy-paste the dict at the top.
5. **Events module API.** Step 12 calls `events.append(...)`; the actual function name and arg list need to be confirmed by reading `lib/events.py` before writing the call. The plan can't pin the exact signature without that read.

## Definition of done

- All eight acceptance criteria in `brief.md` pass.
- The dogfood QA on `2026-05-22-token-efficiency-tracking` shows `generated_lines > 0` after the backfill runs.
- All new unit tests pass; all pre-existing tests still pass (`bin/pytest -m unit agent-workbench-live/tests/`).
- `grep -n 'base_ref' agent-workbench-live/lib/board/source.py agent-workbench-live/lib/doc_claims.py` shows the kwarg consistently.
- `docs/TODO.md` §3 is struck through or marked done.
- The worktree's `build.md` documents the four sub-changes and lists any deviations from this plan.

## Preflight

| Field | Value |
|---|---|
| repo_path | `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai` |
| repo_name | `agentic-development-task-system-v3-ai` |
| base_ref | `HEAD` (resolved SHA: `e657d140dca7172d25300c9165e16f6fa4156bc8`) |
| branch_name | `agent/base-ref-sha-plumbing-across-remaining-con` |
| worktree_name | `base-ref-sha-plumbing-across-remaining-con` |

**Checks:**

- Worktree is created and on the right branch (verified via `git worktree list`).
- `metadata.yaml` carries both `base_ref: HEAD` and `base_ref_sha: e657d140…` — this run is its own dogfood for the SHA-already-flows path.
- Pre-fix run `2026-05-22-token-efficiency-tracking` is present in `runs/` with symbolic `base_ref` and no `base_ref_sha`. Valid backfill target.
- No uncommitted changes in the worktree besides `runs/2026-05-25-base-ref-sha-plumbing-across-remaining-con/` (the workbench's own artifacts).
- All template/test files referenced in the plan exist and are accessible.

**Warnings:** None.

## Decisions & assumptions

### DR-001
- **Decision**: Add a *local* `_effective_ref` helper inside `lib/validate_context.py` rather than importing `lib/metrics/lines.py:_effective_ref`.
- **Rationale**: Keeps the metrics module's public surface small. The helper is six lines; cross-module import is more weight than duplication for a leaf utility.
- **Alternatives considered**: (a) Import from `metrics/lines.py`. (b) Promote to a new `lib/_refs.py` module shared by all four call sites.
- **Why not the alternatives**: (a) Couples `validate_context` to `metrics` for no real benefit. (b) Premature abstraction — four call sites with six-line helpers is fine; the third copy is the right time to extract, not the second.

### DR-002
- **Decision**: In `lib/doc_claims.py` and `lib/board/source.py:_git_shortstat`, inline the prefer-SHA logic (two lines: `effective_ref = base_ref_sha or base_ref`) rather than calling a helper. No lazy in-worktree rev-parse fallback for these two.
- **Rationale**: For `validate_context.build`, the lazy-resolve fallback exists because `metrics/lines.py:_effective_ref` does it — symmetry within the diff-stat path matters. For `doc_claims.verify` and `board/source.py:_git_shortstat`, the failure mode of an unresolvable symbolic ref is already handled (`doc_claims.verify` catches `subprocess` errors and returns `[]`; `_git_shortstat` returns `(None, None, None)`). Adding a lazy-resolve step just changes the failure shape without changing the observable behavior.
- **Alternatives considered**: (a) Mirror `validate_context.py`'s `_effective_ref` exactly in all three places. (b) Promote the helper to `lib/repos.py`.
- **Why not the alternatives**: (a) Adds code without adding behavior. (b) Belongs in DR-001's third-copy moment, not now.

### DR-003
- **Decision**: Use the `events.append(...)` (or whatever the actual API is — confirmed at build time) function from `lib/events.py` to emit `BaseRefResolved`. Do not write to `events.jsonl` directly.
- **Rationale**: Every other event in the codebase goes through `lib/events.py` for sequence-number assignment and schema validation. Bypassing it would silently break invariants.
- **Alternatives considered**: Manually append JSON to `events.jsonl`.
- **Why not the alternatives**: Loses the seq monotonicity contract.

### DR-004
- **Decision**: Emit `BaseRefResolved` from `cmd_start.py` only — not from `cmd_new_run.py` (which also resolves the SHA via `repos.resolve_ref_to_sha` at L87).
- **Rationale**: The brief's acceptance criterion 6 says "between `planning → ready` and `ready → building` transitions". `cmd_start.py` is the boundary that does the `ready → building` transition; `cmd_new_run.py` happens at the `draft` boundary, before any audit-trail event of substance. Emitting from both would double the event count and confuse the audit narrative.
- **Alternatives considered**: Emit from both. Emit from a shared helper called by both.
- **Why not the alternatives**: First doubles the audit signal. Second adds an abstraction for two call sites with subtly different actor contexts (`cmd_new_run.py` actor may be the human running the slash command; `cmd_start.py` actor is the same but the timing is different).

### DR-005
- **Decision**: Add a new test class to `test_board_snapshot.py` that drives `_git_shortstat` directly against a real synthetic git repo, rather than using the existing `seed_run` metadata-only fixture.
- **Rationale**: `seed_run` only writes metadata.yaml; it doesn't create a worktree, so calling `_git_shortstat` against it would fail or return `(None, None, None)`. The acceptance criterion requires asserting non-zero added lines, which needs a real diff.
- **Alternatives considered**: Extend `seed_run` to also build a real git repo.
- **Why not the alternatives**: Bloats the fixture for every other consumer. The `_init_repo` pattern from `test_validate_context_build.py` is the right size for the new test class.

### DR-006
- **Decision**: The backfill computes the fork point as `git -C <target.repo.path> merge-base <target.worktree.branch_name> HEAD`, treating the source repo's current `HEAD` as the comparison anchor (not the worktree's HEAD, not `agent-workbench.yaml`'s `defaults.base_ref` value `"HEAD"`).
- **Rationale**: When `base_ref` was captured as the literal string `"HEAD"`, it meant "the source repo's `HEAD` at the time `/start` ran." We can't recover the historical `HEAD`, but we can compute the fork point between the worktree branch and the *current* `HEAD` — which is a stable surrogate as long as the worktree branch was created from `HEAD` and no rebase has moved its base. For runs where that assumption is wrong, the fallback (`git rev-list --max-parents=0`) gives a root-commit floor that at least keeps `metrics --rebuild` from reporting zero.
- **Alternatives considered**: (a) Use `defaults.base_ref` from `agent-workbench.yaml` directly — produces the literal string `"HEAD"`. (b) Require a user-provided base ref via a CLI flag. (c) Scan reflog for the original `/start` HEAD.
- **Why not the alternatives**: (a) Is the bug we're trying to fix, not the fix. (b) Defeats the "idempotent walk over all stale runs" model. (c) Reflog may have been pruned; too brittle.

### DR-007
- **Decision**: The backfill uses `yaml_io.loads` / `yaml_io.dumps` directly (mirroring `tools/backfill_completion_refs.py`), not `lib/metadata.py:update`.
- **Rationale**: `metadata.update` requires a `Config` object, which standalone tools don't build. The existing backfill demonstrates the convention.
- **Alternatives considered**: Build a `Config` inside the script.
- **Why not the alternatives**: Heavier than necessary; inconsistent with the existing backfill's shape.

### ASM-001
- **Text**: `lib/events.py` exposes an append-style API (single function call, takes a payload dict and event type) usable from `cmd_start.py` without further setup.
- **Reason**: Every other `cmd_*.py` that emits events does so with a simple call; the codebase pattern is consistent. The exact signature will be confirmed by reading the module at build time.
- **Impact**: low — if the API is meaningfully different, step 12 of "Proposed changes" adapts but the plan shape doesn't change.

### ASM-002
- **Text**: `cmd_validate.py:_verify_doc_claims_staged` is the only call site of `doc_claims.verify` in the workbench. Other code paths (e.g. flat-run validation) either don't call it or call it through the same helper.
- **Reason**: The explore subagent's report named one call site and the grep confirmed it. A focused grep at build time will catch any additional sites.
- **Impact**: low — adding the kwarg to extra call sites is mechanical.

### ASM-003
- **Text**: The 2026-05-22-token-efficiency-tracking run still has its worktree branch in the source repo's ref database (i.e. `git -C <repo_path> show-ref agent/2026-05-22-token-efficiency-tracking` succeeds), even if the worktree directory itself has been removed.
- **Reason**: Workbench branches are not auto-deleted on `/complete` or `/abandon` in the current shape; the worktree is removed but the branch ref persists.
- **Impact**: medium — if the branch ref is gone, the backfill's merge-base step fails for this specific run. Mitigation: the fallback to `git rev-list --max-parents=0` requires the branch ref too, so the failure mode is "skip the run with a warning" rather than crash. We will verify this is the actual state at build time, before running the dogfood acceptance.

### ASM-004
- **Text**: No external consumers read `agent-workbench-live/schemas/events.jsonl` or `runs/*/events.jsonl` directly. The schema file is descriptive; adding a new line does not break any contract.
- **Reason**: The workbench is local-only by design (architecture.md states this), and the schema file is referenced only by `lib/audit.py` and the events emitter at present.
- **Impact**: low.

### ASM-005
- **Text**: The new `BaseRefResolved` event's `payload.sha` field name is consistent with how SHAs are named elsewhere in event payloads (e.g. existing `payload.merge_sha` or similar). Reading `lib/events.py` and one or two existing event payloads at build time will confirm.
- **Reason**: Schema consistency.
- **Impact**: low — if the convention is `payload.base_ref_sha` rather than `payload.sha`, rename mechanically.

### ASM-006
- **Text**: `bin/pytest` (with `-m unit`) is the correct test runner for these tests and will pick up the new test files automatically.
- **Reason**: Existing test files in the same directory use the same pytest conventions; no new fixture registration needed.
- **Impact**: low.
