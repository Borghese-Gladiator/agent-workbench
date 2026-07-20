# Design spec — split Verification into `static_checks` + `feature_e2e`

Status: **IMPLEMENTED**. Branch: `worktree-verification-stage-split`.

## Resolved decisions (the 4 open questions)

1. **Self-review** stays its own `agent_self_review` stage and runs regardless of
   `skipE2e`. The cold self-review is launched (awaited) from `static_checks` so
   it overlaps `feature_e2e` and the `self_review` artifact deterministically
   exists before advancing.
2. **Verdict format**: the QA harness already emits the Playwright JSON reporter
   to `QA_OUTPUT_DIR/results.json`. `produceDemoEvidence` now parses it via
   `readPlaywrightVerdict` and gates on `unexpected === 0 && expected > 0`.
3. **No baseline for `feature_e2e`** — any fail/zero-run parks.
4. **`e2eCommand`** left as-is (used only on the mock path); not repurposed.

## Sub-step labels

`STAGE_LABELS`: `static_checks` = "Static Checks", `feature_e2e` = "Project E2E".
`STAGE_GROUP_LABELS` maps both to "Verification" for the rail rollup
(`stageGroupLabel`). The TaskDetail rail groups consecutive same-group-label
stages into one expandable "Verification" node whose sub-steps are the two stages
(each with its own nested artifacts/assets).

## Migration

`0015_split_verification_into_static_and_e2e`: adds `tasks.skip_e2e` and renames
existing `verification` stage rows -> `static_checks` across
tasks/stage_runs/agent_runs.

---

## ORIGINAL PROPOSAL (kept for context)

## Motivation

Today the `verification` stage does two structurally different things in one
stage function (`service.ts:runVerification`):

1. **Static half** — runs the repo's `typecheck`/`test`/`lint` as real shell
   commands, scoped to changed files, and gates on the real exit code. It can
   auto-park on a *new* failure (`service.ts:1237-1251`).
2. **Agent QA half** — launches a Claude subagent that is *asked* to write a
   feature-specific E2E spec and run it via the QA harness
   (`produceDemoEvidence`, `service.ts:1389`). Its only gate is
   `if (outcome.status !== 'succeeded') return false` (`service.ts:1459`) —
   i.e. **"did the agent finish its turn,"** not **"did the tests pass."**

Consequence (audited 2026-06-27): six Browser Games tasks shipped a broken
`main`. The agent QA half accepted a *fabricated* "VERDICT: PASS, 8/8 scenarios"
report (with `.webm` paths that never existed and an unexpanded
`QA_SPEC_DIR/walkthrough.spec.ts`) because the agent's turn completed cleanly.
Nothing ever read a real Playwright verdict. See memory
`validation-gate-cant-fail-audit`.

Two independent problems, which this split addresses:

- **A — wrong verdict source.** The E2E gate must read a machine-readable test
  result, not the agent's prose / completion status.
- **B — entangled lifecycle.** Static and E2E share one stage, one park
  decision, one timing row, one resume. They should be separate stages so each
  parks/retries/times independently, while still appearing as one "Verification"
  group in the UI.

Plus a new product requirement:

- **C — optional skip.** The human must be able to **opt out of the E2E stage at
  the Human Plan Approval gate** (after Discovery + Plan), e.g. for a non-UI or
  trivial change where booting browsers is wasteful.

---

## Finding (1): how the UI groups stages — answer

**The lifecycle rail does NOT group by label; it renders one row per stage id.**

- `apps/web/src/pages/TaskDetail.tsx:695` — `STAGES.map((stage, i) => …)` renders
  one `<li>` per stage, titled `STAGE_LABELS[stage]` (line 735). No grouping.
- `LifecycleDotStrip` (TaskDetail.tsx:660, `stages={STAGES}`) — same: one dot per
  stage id.
- `apps/web/src/pages/Board.tsx:78` — the Board **does** group by explicit
  per-column `stages: [...]` arrays (`in_progress` already lists
  `['implementation','verification','agent_self_review']`). Multiple stages → one
  column is already supported here.

**Implication for "roll up to Verification":**

- **Board** — free: add `static_checks` + `feature_e2e` to the `in_progress`
  column's `stages` array; drop/keep `verification` as the migration dictates.
- **Lifecycle rail (TaskDetail) + dot strip** — NOT free. If both new stages get
  `STAGE_LABELS = 'Verification'`, the rail renders **two rows both titled
  "Verification."** A small grouping change is required: collapse *consecutive*
  stages that share a label into one expandable rail node (children = the union
  of both stages' artifacts/runs). This is the only nontrivial UI change.

---

## Finding: blast radius of the `verification` literal

23 non-test references to `'verification'` (grep, apps + packages, excl.
dist/tests). Grouped:

**Lifecycle / state machine (must change):**
- `packages/core/src/lifecycle.ts:18` — `STAGES` list + `STAGE_LABELS`.
- `packages/core/src/transitions.ts:106,111` — `completeImplementation` →
  `verification`; `completeValidation` expects `verification`.
- `packages/core/src/artifacts.ts:55,57,58` — `baseline_evidence`,
  `validation_report`, `demo_evidence` all map to `verification` (the
  ARTIFACT_KIND_STAGE map → drives `artifactsByStage`).

**Daemon (must change):**
- `apps/daemon/src/service.ts` — `718` (per-stage branch), `1010/1336/1391`
  (`stageRunForStage(..,'verification')`), `1417` (run stage tag), `1428-1436`
  (context/tools/model/effort/skill/feedback lookups keyed by stage), and the
  `stageWork` map (`1920`).

**Agents (must change — per-stage policy keyed by stage id):**
- `packages/agents/src/index.ts:28`, `packages/agents/src/claude.ts:1174`
  (STRUCTURE_REQUIRED_STAGES etc.) — both new stages need entries.

**UI (must change):**
- `apps/web/src/pages/TaskDetail.tsx:410` (`setSelectedStage('verification')`),
  `705` (QA assets hardcoded to `stage === 'verification'`),
  `apps/web/src/pages/Board.tsx:78`.

**Migration (precedent + required):**
- `packages/store/src/migrations.ts:315` — there is ALREADY a migration that
  renamed `validation_demo` → `verification`. Same mechanism applies: rename
  existing `verification` stage rows to `static_checks` (the static half is the
  one that always runs), and backfill nothing for `feature_e2e` on historical
  tasks.

---

## Finding (2) cont.: precedent for the optional skip (C)

The brief gate already threads an optional boolean option through an approval
action, exactly the shape we need:

- `apps/daemon/src/app.ts:582` — `approve-brief` accepts `{ skipWorktree }` and
  calls `approveBrief(id, comment, { skipWorktree })`.
- `service.ts:456-474` — persists the decision as `task.worktreeMode = 'direct'`
  (a task column), later read by the lifecycle (`service.ts:1683,1691`) to change
  behavior.

The E2E skip mirrors this 1:1: `approve-plan` accepts `{ skipE2e }`, persisted as
a task flag, read by the lifecycle to route past `feature_e2e`.

---

## Proposed design

### Stage list (lifecycle.ts)

```
... 'implementation',
    'static_checks',   // was the static half of 'verification'
    'feature_e2e',     // was the agent-QA half; now gates on a real verdict
    'agent_self_review', ...
```

`STAGE_LABELS`:
```
static_checks: 'Verification',
feature_e2e:   'Verification',   // both roll up to one UI group
```

Both are auto-advanceable (neither is a human gate), so `isAutoAdvanceable`
needs no change.

### Transitions (transitions.ts)

```
completeImplementation : implementation     -> static_checks
completeStaticChecks   : static_checks      -> feature_e2e        (skip → agent_self_review)
completeFeatureE2e     : feature_e2e        -> agent_self_review
completeSelfReview     : agent_self_review  -> human_review        (unchanged)
```

When `task.skipE2e` is set, `completeStaticChecks` returns
`{ stage: 'agent_self_review' }` directly (with a `note: 'e2e skipped at plan approval'`).

### stageWork wiring (service.ts:1920)

```
static_checks: (id) => this.runStaticChecks(id),
feature_e2e:   (id) => this.runFeatureE2e(id),
```

- `runStaticChecks` = the current static half (lines ~1206-1251): run
  typecheck/test/lint scoped to changed files → `validation_report` +
  `baseline_evidence`; park on a *new* failure. Unchanged logic, new home.
- `runFeatureE2e` = the current agent-QA half (`produceDemoEvidence` +
  `runColdSelfReview` fork stays here OR self-review moves wholly to its own
  stage — see open question), with the **verdict fix (A)** below. If
  `task.skipE2e`, this stage's work is a no-op that immediately advances.

### Verdict fix (A) — the core correctness change

`produceDemoEvidence` must gate on the harness result, not agent completion. The
QA harness (`apps/web/qa-harness`) must emit a machine-readable verdict — a
`results.json` (Playwright JSON reporter) or a sentinel exit code — into
`QA_OUTPUT_DIR`. Then:

```
const ok = outcome.status === 'succeeded'
        && verdict.exists                 // harness actually produced a result
        && verdict.failed === 0
        && verdict.passed  >  0;          // guards "ran nothing, narrated PASS"
if (!ok) return false;   // → feature_e2e parks (advanceUntilGate stops)
```

`verdict.passed > 0` is the specific guard against the fabrication we observed
(zero specs run, prose says PASS).

### Optional skip (C)

1. **API**: `app.ts:585` → `action('approve-plan', (id, b) => svc.approvePlan(id, b.comment, { skipE2e: Boolean(b.skipE2e) }))`.
2. **Persist**: add `skipE2e` (bool) to the task row (migration), set in
   `approvePlan`, mirroring `worktreeMode`.
3. **Route**: `completeStaticChecks` reads `task.skipE2e` → skip to
   `agent_self_review`.
4. **UI**: the Human Plan Approval panel gets a "Skip E2E tests" checkbox whose
   value is posted with the approve-plan action (mirror the existing
   skip-worktree checkbox on the brief gate).
5. **Audit**: store the skip on the approval record / as a stage note so the
   timeline shows E2E was deliberately skipped (not silently absent).

### UI rollup (from Finding 1)

- Board: add both stages to the `in_progress` column array.
- TaskDetail rail + dot strip: group consecutive same-label stages into one node.
  When `skipE2e`, render the `feature_e2e` node as "Skipped" rather than pending.
- TaskDetail:705: replace `stage === 'verification'` asset attachment with
  `stage === 'feature_e2e'` (the QA assets belong to the E2E stage now).

---

## Migration

Mirror `migrations.ts:315`:
- Rename existing `stage = 'verification'` rows → `'static_checks'` (the
  always-runs half) across `tasks` + `stage_runs` (+ any stage-tagged tables).
- Re-map artifact→stage: `validation_report`/`baseline_evidence` → `static_checks`;
  `demo_evidence` → `feature_e2e` (artifacts.ts).
- Add `tasks.skip_e2e` boolean column, default false.

---

## Open questions (need a decision before implementation)

1. **Self-review placement.** Today `runColdSelfReview` is forked alongside the
   QA agent inside `verification`. Does it stay inside `feature_e2e`, move to its
   own `agent_self_review` stage entirely, or run after `static_checks`
   regardless of the E2E skip? (Recommendation: self-review should NOT be skipped
   with E2E — it reviews the diff, which exists either way — so run it in/under
   `agent_self_review`, independent of `skipE2e`.)
2. **Harness verdict format.** Playwright JSON reporter (`results.json`) vs a
   wrapper exit code. JSON gives pass/fail counts (needed for the
   `passed > 0` guard); recommend JSON.
3. **Pre-existing E2E failures.** The static half has a baseline mechanism (don't
   park on failures that already existed on the base branch). Does `feature_e2e`
   need the same? For a *feature-specific* spec the agent just wrote, there is no
   baseline — so any failure is new. Recommend: no baseline for `feature_e2e`;
   any fail/zero-run parks.
4. **`e2eCommand` project field.** Currently a no-op on the claude runtime
   (only runs on mock). Either remove it from the claude path entirely or
   repurpose it as the command the harness runs. Decide as part of (2).

---

## What this spec does NOT do

No code changed. This is the plan only. The hard dependency for the correctness
win is the harness emitting a machine-readable verdict (A/finding 2); the stage
split (B) and the skip (C) are lifecycle/UI plumbing with clear precedents
(`validation_demo→verification` migration; `skipWorktree` option).
