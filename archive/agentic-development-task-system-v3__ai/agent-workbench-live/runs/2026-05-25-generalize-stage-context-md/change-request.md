# Change Request — 2026-05-25-generalize-stage-context-md

## Bounce 1 — 2026-05-26T03:30:00Z — timothysheee

**Scope:** Multiple (tests, implementation, docs)
**Severity:** Rework (partial redo)
**Plan/brief impact:** No, just rebuild — the brief's acceptance criteria stand; this bounce records a scope expansion (TODO §3 item 2a is pulled in) but the existing plan.md doesn't need re-planning. The rebuild treats this change-request as the authoritative delta.

### Specific changes requested

The human reviewer raised five concerns. Four of them require concrete code/test changes (this bounce); the fifth is qualitative confirmation to deliver in the next handoff.

#### 1. Deterministic E2E test for `build-context.md` writing

The current cmd_start integration tests use the **flat-layout** branch of `_write_build_context_artifacts`. The **staged-layout** branch (cmd_start.py:138–145) is exercised only by manual smoke. This is the most common production path (every new staged run hits it) and must have automated coverage.

**Acceptance:**
- `tests/test_e2e.py::TestE2EHappyPath::test_happy_path` gains an assertion after the `/start` step:
  ```python
  self.assertTrue((run_dir / "stages" / "4_building" / "build-context.md").exists())
  ```
- Optionally a complementary assertion on a few load-bearing strings in the rendered file (e.g. `## Acceptance criteria`, `## Worktree`) to catch regressions where the file exists but is empty.
- No LLM/agent logic in the test — purely deterministic file-existence + substring checks.

#### 2. Deterministic cross-stage contract test

The whole point of `build-context.md` is the cross-stage handoff: at `/start` the building-stage curated context exists, and at the *next* stage (`/validate --init`) the existing curated context is still present (the bounce-archive mechanism shouldn't remove it during normal flow). Today nothing tests that contract end-to-end.

**Acceptance:**
- A new test (in `test_e2e.py` or a new `test_cross_stage_context.py`) that drives `new-run → shape → plan → start → validate --init` against a stub-LLM fixture and asserts:
  - After `/start`: `stages/4_building/build-context.md` exists.
  - After `/validate --init`: both `stages/4_building/build-context.md` AND `stages/5_validating/validate-context.md` exist (the build-context.md should survive into the validating stage; it's already-archived-or-still-readable).
- Deterministic — no agent reasoning involved. The test asserts file presence at exact paths after specific CLI invocations.

#### 3. Land TODO §3 item 2a (`base_ref_sha` plumbing into `validate_context.py`)

This run's own `validate-context.md` had an empty `## Final diff` and `blast-radius.txt` showed `(no files changed yet)` because `base_ref="HEAD"` makes `git diff HEAD...HEAD` empty. F-003 in `review.md` flagged this; it's degraded curated context handed to the validator. The user pulled this into this run's scope: "Please validate and populate that file. Why would this ever not be present?"

**Acceptance (matches existing TODO §3 item 2a):**
- Add `base_ref_sha: str | None = None` kwarg to `validate_context.build` and `validate_context.build_blast_radius`.
- Inside those functions, prefer the SHA when present; fall back to symbolic `base_ref` only if SHA is missing. Mirror `lib/metrics/lines.py:_effective_ref`.
- Thread the SHA through `cmd_validate.py:_write_validate_context_artifacts` by reading `meta["target"]["repo"]["base_ref_sha"]` alongside `base_ref`.
- Unit test against a synthetic two-commit worktree (mirror the existing `_init_repo` helper in `tests/test_validate_context_build.py`): assert that with `base_ref_sha` set, `## Final diff` lists the worktree's real commit.
- After landing, re-run `/validate --init` on **this run** so the validate-context.md and blast-radius.txt for the rebuild pass actually populate.

#### 4. Verify the `meta`-reload assumption (ASM-001) and document or remove

ASM-001 in plan.md says the caller's `meta` is stale after `metadata.update`, so `_write_build_context_artifacts` reloads via `metadata.load(cfg, run_id)`. The assumption was never verified — could be a phantom worry. If `metadata.update` actually mutates the caller's dict, the reload is a wasted disk read; if it doesn't, the reload is load-bearing.

**Acceptance:**
- Inspect `lib/metadata.update` to determine whether it mutates the caller's dict or only the on-disk file.
- If **mutates**: remove the reload and add a one-line comment in `_write_build_context_artifacts` explaining why `meta` is trusted (e.g. `# meta is fresh — metadata.update mutates the passed dict in place`).
- If **does not mutate**: keep the reload and add a one-line comment naming the staleness reason (e.g. `# metadata.update writes to disk but does not mutate the caller's dict; base_ref_sha would be missing without this reload`).
- Either way the file should have a short comment that future readers don't have to re-derive the answer.

#### 5. Qualitative confirmation that the next stage reads ONLY the curated context

Not a code change — a verification deliverable in the rebuild handoff. The builder agent should produce, in `build.md`'s `Documentation touched` or `What changed` section (or as an explicit subsection), a short read-trace summary:

- "During the rebuild pass I read these files (file paths, not entire contents): X, Y, Z."
- Confirm whether `build-context.md` was the entry point and whether `brief.md` / `plan.md` were re-read or not.
- If they were re-read, name the reason (`build-context.md`'s Section X was insufficient because…) so the next iteration of the curated file can be tightened.

This is the human's qualitative check that the cross-stage contract is actually being honored in practice, not just documented.

### Acceptance for the rebuild as a whole

- All 4 code/test items above land. The existing 16 unit tests still pass; the 2 new E2E tests pass; `test_e2e.py::TestE2EHappyPath::test_happy_path` still passes with its added assertion.
- This run's own `validate-context.md` (in the rebuild pass) is non-degraded: `## Final diff` lists real commits; `blast-radius.txt` shows real changed files.
- `build.md` (rebuild pass) records the read-trace in item 5.
- `review.md` (rebuild pass) is allowed to recommend `approve` again only if all four items are visibly in the diff.

### References

- Handoff (HUMAN_REVIEW.md): `runs/2026-05-25-generalize-stage-context-md/HUMAN_REVIEW.md`
- Original review: `runs/2026-05-25-generalize-stage-context-md/review.md` (or `stages/5_validating/review.md` after the bounce archives it to `archive/5_validating/review-v1.md`)
- Original build: `stages/4_building/build.md` → archived to `archive/4_building/build-v1.md`
- QA report: `qa/report.md` → archived to `archive/5_validating/qa-v1/report.md`
- Follow-ups: `follow-ups.md` → archived to `archive/6_followups/follow-ups-v1.md`
- TODO §3 item 2a: `docs/TODO.md` § 3 (this bounce pulls it into scope).
