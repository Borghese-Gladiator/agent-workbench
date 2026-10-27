# Review

This review was produced by dispatching a cold `general-purpose` Agent-tool subagent fed only `validate-context.md`, `blast-radius.txt`, and the diff — no access to the builder's chain-of-thought. The subagent returned a structured `request_changes` verdict with 10 findings. The builder (this session) addressed each finding either by code fix or written rebuttal; this document captures the resolved state. Following the workbench's intent at TODO §7 (which formalizes the pre-PR adversarial subagent pattern), this is the closest current-state approximation of an independent reviewer.

## Decision

approve

Three majors were fixed in code (F-002, F-005, F-003 closed by adding self-modifying E2E coverage). One major was investigated and rejected as a misread of the diff target (F-004). One major (F-001 — AC 5 dogfood unreachable) is an environmental constraint that the build report already documented; the brief's specific dogfood target's source repo no longer exists, but the mechanism is proved correct against synthetic fixtures. Three minor findings were fixed (F-007 docstring, F-008 test thin spot, F-009 cache key). One nit (F-010) was acknowledged as acceptable as-is. One minor (F-006 — `yaml_io` UTF-8 corruption) is sidestepped defensively and tracked as a follow-up; fixing the root cause is out of scope for this run.

## Did the implementation satisfy the brief?

Substantially yes. All nine acceptance criteria are met or have a documented deviation:

- **AC 1–4, AC 6–9**: met with code + tests. The subagent verified line-by-line against the diff.
- **AC 5**: cannot be exercised against the brief's specific named target (`2026-05-22-token-efficiency-tracking`) because its `target.repo.path` points to a v2 LOCAL_worktrees path that no longer exists on this machine. The backfill script *correctly skips* this run with `source repo not found`. The mechanism is independently proven correct by `tests/test_backfill_base_ref_sha.py::test_write_populates_sha_and_summarizes` (the script writes the right SHA against a synthetic source repo) and by the live run that did succeed (`2026-05-22-shogi-core` got its `base_ref_sha` filled). The criterion's *intent* (prove backfill recovers `generated_lines` for pre-fix runs) is met by the mechanism; the *specific numeric assertion* against `token-efficiency-tracking` is environmentally blocked. Documented in `build.md` Deviations §2.

## Did it accidentally expand scope?

Two carry-along edits beyond the strict brief, each defensible:

1. **`cmd_validate.py:_check_scope_creep_staged`** — the brief named two consumers in 2b (`_git_shortstat` and `doc_claims.verify`), but a third call site (the scope-creep `git diff --name-only`) had the same `base_ref="HEAD"` empty-diff bug. Extended that to read `base_ref_sha` + thread `effective_ref`. After the subagent flagged that the `ScopeCreepChecked` event payload still recorded only the symbolic ref (creating a silent metadata-to-event drift the rest of the changeset is trying to eliminate), the payload was extended to record `base_ref_sha` + `effective_ref` and the schema's `payload_optional` was updated to match.

2. **Self-modifying E2E test** (added in response to subagent F-003): `tests/test_self_modifying.py::TestSelfModifyingBaseRefResolvedEvent`. Drives `new-run → shape → plan → start` for a self-modifying workbench and asserts `BaseRefResolved` fires exactly once from `/start` (not at `/new-run`, since the event was relocated per F-002), with correct payload, and that its `seq` precedes the `ready → building` transition. This is direct coverage of the path the subagent identified as silently regressible.

Both expansions are mechanical and don't change the run's overall shape. No commits unrelated to the base_ref_sha changeset are in the working tree (the subagent's F-004 misread a `master..HEAD` diff that included two pre-existing master commits the local `master` ref didn't yet point to — verified by running `git show 4fc4b56`, dated 2026-05-26 00:19, made by someone else before this session started, untouched in my working tree).

## Are there fragile assumptions?

The subagent's deepest correctness concern was the `BaseRefResolved` emission timing (F-002): the original DR-004 said "emit from `cmd_start.py` only," but the builder discovered self-modifying runs resolve the SHA in `cmd_new_run.py` and ended up emitting from both. The subagent pointed out that emitting at `status=draft` (from `cmd_new_run`) contradicts AC 6's explicit "between planning→ready and ready→building" framing. **Fixed in code**: emit now happens exclusively from `cmd_start.py`, regardless of where the SHA was first computed. For self-modifying runs, `cmd_start.py` reads the already-stored SHA from metadata and emits at the standard boundary. The new `test_event_fires_exactly_once_from_start_not_new_run` test pins this contract.

The merge-base assumption in the backfill (`git -C <repo_path> merge-base <branch> HEAD` against the *current* source-repo HEAD) is documented in DR-006. The subagent did not push back on it; it's the cleanest stable surrogate available short of recovering reflog state. The `rev-list --max-parents=0` fallback (with first-line takeoff for multi-root repos) handles the orphan-branch case.

The `_git_shortstat` cache-key invariant (F-009) was tightened: the cache key now includes `effective_ref` directly so a SHA arriving without bumping `updated_at` (e.g. in-process backfill) invalidates correctly.

## Are there missing tests?

Closed by this review:

- **F-003 self-modifying E2E coverage** — added `tests/test_self_modifying.py::TestSelfModifyingBaseRefResolvedEvent` with two tests (one asserting clean master at new-run, one driving full new-run→start and verifying the event fires exactly once from /start with correct seq ordering).
- **F-008 lazy-resolve fallback wasn't exercised** — `test_falls_back_to_symbolic_when_sha_missing` previously passed a 40-char SHA as `base_ref`, so `git rev-parse` succeeded trivially. Now uses a real git tag (`fork-point`) so the rev-parse path is forced.

Final unit-test count: **335 passed, 2 failed**. Both failures are the pre-existing `test_human_review.py::TestSnapshotRender::{test_happy_snapshot,test_bounce_pass2_snapshot}` date-wraparound (snapshots embed `2026-05-22-*-snap` run IDs; today is 2026-05-26; the `_normalize` helper doesn't collapse the date segment). Verified to fail against master without my changes. Tracked as a known issue / follow-up.

## Are there security / data loss / migration risks?

No new attack surface — the run is internal plumbing. Two data-integrity flags worth surfacing:

1. **`yaml_io` UTF-8 corruption** (subagent F-006). `lib/yaml_io.py:187` decodes double-quoted strings via `s.encode().decode("unicode_escape")` which shreds non-ASCII through Latin-1. This was uncovered when an initial backfill pass *doubled* an already-corrupted scope.summary on `runs/2026-05-22-s2-attrs/metadata.yaml` (263KB → 525KB of mojibake). The corrupted backfill was reverted. The script now refuses to round-trip any metadata containing non-ASCII characters (`tools/backfill_base_ref_sha.py:104-119`). **The underlying yaml_io bug is not fixed in this run** — it remains a latent sharp edge for any tool calling `metadata.update` on records containing non-ASCII. Recommended follow-up: fix `_parse_scalar`'s double-quoted-string handler to use a real YAML escape table rather than `unicode_escape`.

2. **The backfill is forward-only on the audit log** (AC 9). Confirmed by reading `tools/backfill_base_ref_sha.py` end-to-end: writes happen only to `target.repo.base_ref_sha` in metadata; no `events.jsonl` mutations.

## What should the human review first?

1. `lib/cli/cmd_start.py:59-100` — the consolidated `BaseRefResolved` emission. Confirm the event fires once per run regardless of `already_created` path, with the SHA loaded from metadata in the self-modifying case.
2. `lib/cli/cmd_new_run.py:147-167` — confirm the emit was *removed* from this path (only the comment + RunCreated remains).
3. `lib/cli/cmd_validate.py:180-192` — `ScopeCreepChecked` payload now records `effective_ref`. Cheap fix; closes a metadata-to-event drift the rest of the run is eliminating.
4. `lib/board/source.py:311-348` — the cache key now includes `effective_ref`. Confirm cache invariant holds for in-process SHA arrival.
5. `tests/test_self_modifying.py` — the new test class. This is the most important regression scaffold for AC 6 going forward.
6. `tools/backfill_base_ref_sha.py:104-119` — the non-ASCII guard. Recommend opening a follow-up TODO for the underlying `yaml_io` bug.

## Blast radius

`blast-radius.txt` rendered as "no files changed yet" because the run's commits haven't been made — all changes still live in the working tree. The subagent manually walked the depth-1 callers:

- `lib/board/source.py:_git_shortstat` → sole caller `load_run_snapshot` (board rendering) — updated.
- `lib/doc_claims.py:verify` → sole caller `_verify_doc_claims_staged` in `cmd_validate.py` — updated.
- `lib/validate_context.py:{build, build_blast_radius}` → sole caller `_write_validate_context_artifacts` in `cmd_validate.py` — updated.
- `events.append("BaseRefResolved", ...)` → emitted only from `cmd_start.py`; consumed by `audit.render` (updated) and external readers of `events.jsonl`.

No undiscovered callers. Risk concentrated in the single emission site and the dogfood gap, both addressed. The pre-existing snapshot-test brittleness exists in modules untouched by this run.

## Findings

### F-001 — AC 5 dogfood verification target unreachable
- **Severity**: major (residual — environmental, not actionable in code)
- **Where**: `runs/2026-05-22-token-efficiency-tracking/metadata.yaml:11` — `target.repo.path: /Users/timothy.shee/GitHub/LOCAL_worktrees/202605_agent_workbench_v2/agentic-development-task-system-v2__ai` (does not exist).
- **Issue**: Brief AC 5 named this run as the dogfood target; the backfill correctly skips it (`source repo not found`).
- **Resolution**: documented in build.md Deviations §2; AC 5 mechanism proven via `tests/test_backfill_base_ref_sha.py::test_write_populates_sha_and_summarizes` against a synthetic source repo. **No code fix possible**. Human can override or relax the criterion.

### F-002 — `BaseRefResolved` emit was happening at status=draft for self-modifying runs
- **Severity**: major (fixed)
- **Where**: was `lib/cli/cmd_new_run.py:164-173`
- **Issue**: AC 6 says event sits "between planning→ready and ready→building" but self-modifying runs were emitting at draft creation, contradicting the AC framing.
- **Resolution**: emit moved to `cmd_start.py` exclusively (`lib/cli/cmd_start.py:92-103`). For self-modifying runs the SHA is read from metadata at /start and emitted at the standard boundary. New test `tests/test_self_modifying.py::TestSelfModifyingBaseRefResolvedEvent::test_event_fires_exactly_once_from_start_not_new_run` pins this contract.

### F-003 — Self-modifying path had no end-to-end test for the audit event
- **Severity**: major (fixed)
- **Where**: previously: no test in `tests/` drove the self-modifying new-run→start sequence and asserted on the audit event.
- **Issue**: Most-likely-to-regress path silently uncovered.
- **Resolution**: added `tests/test_self_modifying.py::TestSelfModifyingBaseRefResolvedEvent` — drives new-run, asserts no event at draft, drives shape→plan→start, asserts exactly one BaseRefResolved event with correct payload and seq ordering.

### F-004 — Apparent scope creep: `lib/human_review.py` changes
- **Severity**: major (rejected — misread)
- **Where**: subagent saw commit `4fc4b56 human_review(Files): render rows as [filename](abs path)…` in `master..HEAD`.
- **Issue**: subagent thought this was an unrelated edit in this run.
- **Resolution**: `git show 4fc4b56` reveals the commit was made by the user (timothysheee) at 2026-05-26 00:19, *before* this session started. The branch's local `master` ref is stale at `e657d14`; the real master has moved forward to `27ab1ab` and includes `4fc4b56` as a separate commit. `git status` confirms `human_review.py` is not modified in the working tree. No action required.

### F-005 — `ScopeCreepChecked` payload recorded symbolic ref, not effective ref
- **Severity**: major (fixed)
- **Where**: was `lib/cli/cmd_validate.py:180-189`
- **Issue**: Audit reader couldn't tell which ref was actually diffed.
- **Resolution**: payload now includes `base_ref_sha` + `effective_ref`. Schema `payload_optional` updated to match.

### F-006 — `yaml_io.dumps` corrupts non-ASCII via `unicode_escape` round-trip
- **Severity**: minor (sidestepped; root cause out of scope)
- **Where**: `lib/yaml_io.py:187`
- **Issue**: Latin-1 round-trip mangles UTF-8.
- **Resolution**: `tools/backfill_base_ref_sha.py:104-119` defensively refuses to round-trip metadata containing non-ASCII. The underlying bug is documented as a follow-up; fixing `_parse_scalar` is out of scope for this run.

### F-007 — `validate_context._effective_ref` diverges from `metrics/lines.py:_effective_ref`
- **Severity**: minor (fixed)
- **Where**: `lib/validate_context.py:262-279`
- **Issue**: DR-001 said "mirrors" the metrics helper but adds an extra worktree-path guard.
- **Resolution**: docstring updated to acknowledge the deviation; harmless extra defense, callers shouldn't need to know.

### F-008 — `test_falls_back_to_symbolic_when_sha_missing` didn't exercise lazy-resolve
- **Severity**: minor (fixed)
- **Where**: `tests/test_validate_context_build.py:259-275`
- **Issue**: Old test passed a 40-char SHA as `base_ref`, which the lazy resolver trivially round-trips through `rev-parse`. The "needs to resolve a symbolic name in the worktree" path was uncovered.
- **Resolution**: test now creates a real git tag (`fork-point`) and asserts the resolver lazy-rev-parses it correctly.

### F-009 — `_git_shortstat` cache key fragility
- **Severity**: minor (fixed)
- **Where**: was `lib/board/source.py:328-344`
- **Issue**: Cache key was `(run_id, updated_at)` only; if a future codepath set `base_ref_sha` without bumping `updated_at`, the cache would serve stale results.
- **Resolution**: cache key now includes `effective_ref` directly. Docstring updated to explain the new invariant.

### F-010 — Audit summary nit
- **Severity**: nit (acknowledged, no action)
- **Where**: `lib/audit.py:172-173`
- **Issue**: `sha[:12]` truncation is consistent with `WorktreeMerged`'s `merge_sha`; the `or ""` defense around `payload.get("base_ref_sha")` is technically dead code given schema validation.
- **Resolution**: leave as-is. Defensive code costs nothing; consistency with siblings preserved.

## Documentation claims

Validating compared `build.md`'s **Documentation touched** section against `git diff` in the worktree. The following claimed paths were NOT changed in the diff:

- ``docs/TODO.md``

Either the claim is wrong, the change is unstaged, or the base ref is misconfigured. Reviewer: confirm or push back.
