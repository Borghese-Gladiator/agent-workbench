# Brief

## Goal

Make `generated_lines` (and `accepted_lines`) report a non-zero count for runs that use the default `base_ref: HEAD`. Today, `lib/metrics/lines.py:count_generated()` runs `git log --numstat <base_ref>..HEAD` and the workbench config defaults `base_ref` to the literal string `"HEAD"`, which is then stored verbatim in `metadata.target.repo.base_ref`. The dotted range `HEAD..HEAD` resolves to "no commits", so every run that uses the default reports zero lines authored — regardless of how many commits the builder actually landed.

Fix: capture a resolved SHA for the symbolic `base_ref` at `/start` time and persist it as an additive field on the run metadata; use that SHA in the metrics path; fall back to a lazy `git rev-parse` resolver inside the worktree for existing runs that predate the field.

## User-facing behavior

- Running `/start` on a run whose `base_ref` is `"HEAD"` (or any other symbolic ref) resolves that ref against the source repo and persists the 40-character SHA alongside the symbolic name in `metadata.yaml`. The symbolic name stays readable; the SHA is what the metrics layer uses.
- Running `agent-workbench metrics <run-id>` on a finished run reports a non-zero `generated_lines` whenever the builder landed at least one commit on the worktree branch.
- For pre-existing runs whose `metadata.yaml` was written before this fix (no SHA field present), the metrics layer transparently resolves `base_ref` inside the worktree via `git rev-parse` and proceeds. No `metadata.yaml` rewrite happens.
- The `metrics --record` / `metrics --rebuild` paths produce the same corrected numbers without any per-run shell ceremony.

## Acceptance criteria

- A new run created with the default `base_ref: HEAD` reports a non-zero `generated_lines` once any commits land on the worktree branch.
- The token-efficiency pass-1 dogfood run (`2026-05-22-token-efficiency-tracking`) reports a non-zero `generated_lines` after the fix lands, either by re-running `metrics --rebuild` on the existing run or via the lazy resolver path. (3 commits, ~2.4k inserted lines — final number is whatever the code computes; the acceptance is "not zero".)
- `tests/test_metrics_lines.py` has a regression test that pins the symbolic-ref behavior: a tmp repo with one commit + a run-metadata-style `base_ref="HEAD"` + a resolved SHA yields a non-zero count.
- New runs persist `metadata.target.repo.base_ref_sha` after `/start`. Existing runs with no such field still produce correct numbers via the lazy resolver fallback.
- `metadata.target.repo.base_ref` is **not** rewritten on existing runs. The symbolic form remains visible.
- `schemas/run-metadata.yaml` adds `base_ref_sha` as an optional field. Older `metadata.yaml` files (without the field) continue to validate.

## Non-goals

- Changing the default `base_ref` (still `HEAD`).
- Inferring the base via `git merge-base` instead of capturing it at `/start`.
- Supporting non-git worktrees.
- Rewriting any existing `metadata.yaml` files to add `base_ref_sha` retroactively. The lazy resolver is the migration story — no in-place edits.
- Changing the meaning of `generated_lines` / `accepted_lines` (still `+` lines per `git numstat`).
- Adding new CLI flags or surfaces. The fix is invisible at the CLI surface — only the numbers change.

## Good examples

- Brand-new run on `/start`: `metadata.target.repo.base_ref` stays `"HEAD"`, a new `metadata.target.repo.base_ref_sha` field is written holding the full 40-char SHA that `HEAD` pointed at in the source repo at the time of `git worktree add`. `lib/metrics/lines.py:count_generated()` (called later by `metrics`) uses the SHA as the left-hand side of the `git log --numstat <sha>..HEAD` range.
- Pre-existing run (no `base_ref_sha` field): `count_generated` notices the field is absent, calls `git rev-parse <base_ref>` inside the worktree path, and uses the result. The fallback comment in the code reads roughly "if base_ref_sha is missing, resolve base_ref inside the worktree (lazy migration for pre-existing runs)".
- `tests/test_metrics_lines.py` gains a parameterized case that: (1) builds a tmp git repo, (2) records the initial-commit SHA, (3) lands one more commit, (4) calls `count_generated` with `base_ref="HEAD"` + `base_ref_sha=<initial-commit-sha>` and asserts the count is the number of `+` lines from the second commit. A second case with no `base_ref_sha` exercises the lazy-resolver path against the same tmp repo.

## Bad examples

- Rewriting `metadata.target.repo.base_ref` from `"HEAD"` to the SHA. This loses the symbolic information; the brief explicitly chooses the additive `base_ref_sha` field.
- A separate one-shot backfill script that walks every `runs/*/metadata.yaml` and rewrites it. Not in scope — the lazy resolver in `lines.py` is the migration story.
- Resolving the SHA at `metrics` time only (skipping the `/start` capture). The `/start` time is when the worktree branch actually points at the right base; resolving later inside the worktree still works for the lazy path but should not be the only path for new runs — there's no reason a new run shouldn't have the SHA recorded.
- Making the new field required in the schema. Older `metadata.yaml` files would stop validating; this violates "additive only".
- Changing `agent-workbench.yaml`'s default `base_ref` away from `HEAD`. Out of scope.

## Constraints

- Additive schema changes only. `schemas/run-metadata.yaml` must remain backwards-compatible — pre-existing `metadata.yaml` files (which lack `base_ref_sha`) must continue to validate. Mark the new field optional.
- `lib/metrics/lines.py` is the **single** consumer that needs to switch to the resolved SHA. Both `count_generated()` and `count_accepted()` take `base_ref`; both must prefer the resolved SHA when present, otherwise fall back to symbolic + lazy `git rev-parse` inside the worktree.
- `cmd_start.py` already runs `git worktree add` against the source repo; the SHA resolution must happen against the source repo (not the worktree, which doesn't exist yet at that point in the flow) before the worktree is created. If `git rev-parse <base_ref>` fails on the source repo, surface a clean error and abort `/start` rather than silently writing an empty SHA.
- Lazy resolver path must not crash on edge cases: missing worktree path, deleted worktree, ambiguous ref. On any failure, fall back to the original symbolic `base_ref` (which is what the code does today) — i.e. the lazy resolver is a strict improvement, never a regression.
- No new CLI flags, no new commands, no new env vars.
- Don't touch the prices/buckets/writer modules — this is purely a `lib/metrics/lines.py` + `lib/cli/cmd_start.py` + `schemas/run-metadata.yaml` change with a regression test.

## Assumptions

- ASM-1: The source repo passed via `--repo-path` to `/new-run` (and carried forward to `/start`) is a normal git repo where `git rev-parse <base_ref>` succeeds for symbolic refs like `HEAD`, `main`, `master`, branch names, or short SHAs. No special handling for shallow clones, detached-HEAD-with-no-commits, or bare repos.
- ASM-2: `cmd_start.py` already has enough context to know the source repo's path at the moment it would resolve the SHA — i.e. it doesn't need a new arg or a new metadata field to find it. (To verify in `/plan` against the actual code.)
- ASM-3: `metadata.target.repo.base_ref` is read from `metadata.yaml` by the metrics path via the existing `run-metadata` loader (probably `lib/run_metadata.py` or similar — to confirm during planning). Adding a sibling `base_ref_sha` field doesn't require a new loader; it's a passive read on the same dict.
- ASM-4: The lazy resolver runs inside the worktree path stored on the run, not the original source repo. The worktree branch shares history with `base_ref` in the source repo (because `git worktree add` was given that ref), so `git rev-parse <base_ref>` resolves correctly inside the worktree as long as `base_ref` is a symbolic name like `HEAD` or `main`. For a commit-SHA `base_ref`, `rev-parse` is a no-op.
- ASM-5: The pass-1 dogfood run's worktree (`2026-05-22-token-efficiency-tracking`) still exists on disk; the lazy resolver can be exercised against it to verify the acceptance criterion. If the worktree has been pruned, the run still validates but the dogfood-recompute step is best-effort.
- ASM-6: Existing fixture-based E2E tests (`tests/e2e/...`) drive `/start` end-to-end; adding a SHA capture there shouldn't break snapshots unless they pin the literal `base_ref` field. To check during planning whether snapshots include `metadata.yaml` payloads.
- ASM-7: Pass-1 metrics tests use a tmp repo with at most a few commits, so any new tmp-repo case stays cheap.

## Suggested QA scenarios

- **QA-1 — Default-base-ref happy path.** Spin up a tmp git repo with one initial commit. Create a run with `base_ref="HEAD"`. Run `/start` (which performs the SHA capture). Land a follow-up commit on the worktree branch with N inserted lines. Run `agent-workbench metrics <id> --rebuild`. Assert `generated_lines == N`.
- **QA-2 — Pre-existing run without `base_ref_sha`.** Construct a `metadata.yaml` by hand with `base_ref="HEAD"` and no `base_ref_sha`. Land one commit. Call `count_generated` directly and assert it resolves the SHA lazily and returns the non-zero count. Verify `metadata.yaml` is **not** modified by the read path.
- **QA-3 — Already-an-SHA base_ref is a no-op.** Construct a `metadata.yaml` with `base_ref="<a-real-sha>"` and no `base_ref_sha`. The lazy resolver's `git rev-parse <real-sha>` returns the same SHA. Count is correct. No surprises.
- **QA-4 — Existing runs still validate.** Run `schemas/run-metadata.yaml`'s validator against every `runs/*/metadata.yaml` currently in the repo. All must continue to pass without modification.
- **QA-5 — Dogfood-run recompute.** Run `agent-workbench metrics 2026-05-22-token-efficiency-tracking --rebuild`. Assert `generated_lines` is now non-zero. (Best-effort — depends on ASM-5.)
- **QA-6 — Symbolic-but-missing ref fallback.** A run with `base_ref="some-deleted-branch"` and no `base_ref_sha`. The lazy resolver's `git rev-parse` fails; the function returns the same 0 it returned before this fix (no crash, no regression). Confirms the lazy resolver is a strict improvement.
- **QA-7 — `count_accepted` parallel.** Same idea applied to `count_accepted`: a run whose `completion_ref` is a real merge SHA and whose `base_ref="HEAD"` + new `base_ref_sha` produces a non-zero `accepted_lines` instead of zero.
- **QA-8 — Full test suite green.** Run the entire `tests/` suite; nothing other than the new test case should change. Two pre-existing date-baked snapshot failures on master are acceptable per the LOG.md history.
