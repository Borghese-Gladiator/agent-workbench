# Workbench efficiency audit — findings to fix & verify

Source: live `claude`-runtime run building a Reversi web UI (task `task_wCjLi3jHgJ`,
project `wb-reversi`, 2026-06-18). Raw metrics in `profiling-reversi-live-run.md`.

The run produced a tiny deliverable — one new file (`reversi/server.py`), one new
test file (`tests/test_server.py`), one ~1-line `pyproject.toml` edit — yet cost
**$3.67, 14m 48s wall-clock, 55 model turns, 1.3M cache-read tokens**. That ratio
of cost-to-output is the symptom. The findings below are the diagnosed causes,
each with a concrete acceptance check so we can audit whether it's been fixed.

## Fixes applied (2026-06-19)

Three changes shipped against the findings. They are PROMPT/ENV changes, not
metric changes — verify by re-running a task and re-reading `wb task profile`
against the baseline in `profiling-reversi-live-run.md`.

1. **`WORKBENCH_AGENT=1` on every spawned claude** (`95a7645`). Half of
   verification's 18 errored calls + implementation denials were agents
   trial-and-erroring against a user-level interactive `block-compound-bash`
   hook. Workbench agents are non-interactive, so the hook now no-ops for them
   (hook reads the env var; lives in `~/.claude/hooks/`, outside the repo).
   → Addresses the compound-command share of Finding 3's thrashing + the errored
   calls. Expected: errored-calls and Bash-denial counts drop toward 0.

2. **Concrete per-file plan handoff** (`fd6df1c`). discovery now must emit a
   `## Changes` section (one `### <path> — create|modify|delete` + concrete brief
   per file, applyable without opening the file); implementation is told the plan
   is authoritative — apply directly, do NOT re-survey or re-read covered files.
   → Addresses Findings 1 + 2 (per-file briefs = the handoff; "don't re-read" =
   the working-memory fix). Expected: implementation turn count + cross-stage
   repeated reads of plan-covered files drop; work ratio rises.

3. **QA skill hardening** (`92636ec`). The QA agent's non-compound errors were it
   fighting its own harness (started its own server → port collision; hand-rolled
   `playwright test` → "Project chromium not found"). Skill now forbids starting
   any server (recon by reading) and mandates the exact harness command.
   → Addresses Finding 3's verification-specific friction. Expected: verification
   errored calls + batch-ratio thrashing drop.

NOT fixed / deliberately unchanged: forward stages still cold-start (no session
resume) — we chose the "precise plan" handoff (Option B) over resume; cache_read
volume itself (healthy); verification being slow from the real browser.

---

## Background: why cache_read is large (NOT a bug by itself)

cache_read is **per-turn within a stage**, not "re-reading the same prompt across
stages." Every model turn re-sends the whole conversation so far (system + stage
prompt + every prior tool call and its result); the cached prefix is counted as
cache_read. So cache_read grows ~quadratically with **turn count** and with **how
much junk accumulates in context** (every file read, every bash log stays resident
and is re-sent every subsequent turn).

| Stage | turns | cache_read | cache_read/turn |
|---|--:|--:|--:|
| task_brief | 2 | 23K | ~12K |
| discovery | 7 | 85K | ~12K |
| **implementation** | **19** | **557K** | **~29K** |
| verification | 12 | 350K | ~29K |
| agent_self_review | 6 | 155K | ~26K |
| delivery_prep | 9 | 145K | ~16K |

Caching is *healthy* (85.7% cache-read share) — without it these tokens would be
full-price fresh input. The lever is **fewer turns + less context accumulation**,
not "turn off caching." Verification's volume is acceptable (browser/QA recon).
**Implementation's is not** — see Finding 1.

---

## Finding 1 — Implementation re-explores instead of executing the plan

**Evidence (implementation run `arun_UPW0KQA2Z5`, 19 turns, 18 tool calls):**
the tool sequence shows only ~3 real writes; the rest is re-discovery the
discovery stage already did, plus duplicate surveys:

- `Bash: pwd; ls reversi/ tests/; cat pyproject.toml` (combined)
- **then immediately** `Bash: pwd` / `Bash: ls reversi/ tests/` / `Bash: cat pyproject.toml` AGAIN (duplicate)
- `Read pyproject`, `cat reversi/__init__.py` — content discovery already had
- two `python - <<PY` engine-API probes to discover real signatures by experiment
- two Edit→pytest debug rounds

Root cause is **two structural choices**, both confirmed in code:

1. **Implementation cold-starts a fresh session.** `produceStageArtifact`
   (`apps/daemon/src/service.ts:210`) is called for implementation with
   `resume: undefined` — it does NOT resume discovery's session. Everything
   discovery explored (every file it opened) is gone; implementation rebuilds it.
2. **The plan handed over is PROSE ONLY.** `renderPriorContext`
   (`packages/agents/src/index.ts:624`) inlines the execution_plan body but calls
   `stripStructuredJson` and is explicitly "PROSE only." Implementation gets the
   plan's narrative ("the engine has a `Game` class…") but **not exact signatures,
   line anchors, or code**, so it must re-read files to get the precise content it
   needs to `Edit`.

**Fix direction (user's ask):** the plan should carry **exact code / exact file
lines — like a git diff to apply**. Implementation should *apply* the diff and
then verify it accomplishes the goal, not re-derive what to write.

**Acceptance checks:**
- [ ] The execution_plan artifact contains an applyable change set (per-file,
      exact content or unified-diff hunks with line anchors), not just prose.
- [ ] Implementation stage applies that change set and runs verification; on a
      small task it does NOT re-`ls`/`cat`/`Read` files the plan already covered.
- [ ] Implementation turn count for a 1–3 file change drops to ≤ ~6 (was 19).
- [ ] Implementation cache_read for such a task drops materially (was 557K).

---

## Finding 2 — No working-memory handoff between stages

**The user's expectation:** "I thought we have a ton of code for that."

**What actually exists:** the handoff is artifact-based and lossy, not a working
memory:
- `renderPriorContext` inlines upstream artifact **bodies as prose** (JSON stripped) — `packages/agents/src/index.ts:624`.
- `renderProjectMemory` inlines durable notes from **earlier completed tasks** — `:650`.
- Each forward stage runs as a **fresh Claude session** (`resume` only used for
  rejection bounce / delivery_conflict, not the happy forward path).

**So there is NO carry-forward of a stage's working set** — the concrete facts a
stage discovered (exact file contents, signatures, command outputs, the verified
API) are NOT passed to the next stage. The next stage gets a prose summary and
re-derives the specifics from scratch in a cold session. That is the gap behind
Finding 1's re-exploration.

**Fix direction:** give stages a real working-memory handoff — either (a) resume
the prior session so the explored context is already cached/resident, or (b) have
each stage emit a structured "verified facts" record (exact signatures, file
contents touched, command results) that the next stage consumes instead of
re-discovering. (a) and the Finding-1 diff approach are complementary.

**Acceptance checks:**
- [ ] A downstream stage can access the exact facts an upstream stage verified
      (signatures, file contents, command results) WITHOUT re-running the tools
      that produced them.
- [ ] Confirm whether forward stages should `--resume` the prior session vs.
      cold-start; document the decision and implement it.
- [ ] Repeated-read metric (same file Read in both discovery and implementation)
      trends to ~0 for files the upstream stage already opened.

---

## Finding 3 — Early-turn thrashing repeats in every stage

**The user's expectation:** "only the very beginning ones need to" survey the repo.

**What happens:** because every stage is a cold session (Finding 2), EACH stage
re-orients from zero — re-running `pwd` / `ls` / `cat pyproject.toml` /
re-reading the same files. Worse, within the implementation run the SAME survey
ran twice back-to-back (combined `pwd; ls; cat` then three separate repeats).
None of this is forbidden by the stage instruction (implementation says "do NOT
re-plan or re-scope" but nothing about "the repo is already mapped").

**Fix direction:** the repo survey should happen ONCE (discovery), be captured as
a durable fact, and downstream stages should be told the layout is known — don't
re-survey. The duplicate-within-a-turn survey suggests the prompt isn't steering
the model to trust prior context at all.

**Acceptance checks:**
- [ ] `pwd`/`ls`/`cat pyproject`-style orientation commands appear in discovery
      only, not repeated in implementation / verification / self_review /
      delivery_prep.
- [ ] No duplicate identical survey commands within a single run.
- [ ] Stage instructions explicitly state the repo layout is already established
      and forbid re-surveying when prior context covers it.

---

## Cross-cutting: these are exactly what the 6 NEW profiling metrics catch

The metrics this branch exists to add — tool-call count per turn, repeated reads
of the same file, files-read / commands-run counts, tool-result bytes — would
have flagged all three findings automatically ("implementation: 19 turns, 4
redundant re-reads, repo surveyed 2×"). Building those metrics IS the audit
instrument for verifying the fixes above. Track them per-stage and assert the
acceptance checks against them.

---

## Direction chosen (2026-06-18) — "plan exhaustively, execute mechanically", measure first

After brainstorming three families of fix, we picked a worldview and a sequencing:

**Worldview: Option B — the plan becomes a precise, applyable artifact.** Discovery
must pin down the exact change (per-file diffs / signatures / line anchors), and
implementation *applies + verifies* rather than re-deriving what to write. We are
NOT (for now) resuming sessions (Option A) — we judged a clean precise plan to be
better than carrying discovery's whole transcript, and resume is in tension with
human plan-gate editing. Option C (structured "verified facts" handoff) is parked
as the general mechanism if B needs to scale to large tasks.

**Sequencing: measure before committing the fix.** We build the 6 new profiling
metrics first, get hard numbers on this exact task, and run a small A-vs-B
experiment — THEN implement. This is deliberate because B's main risk is that it
**relocates** implementation's 19 turns into discovery rather than eliminating
them. We refuse to assert "fixed" without the before/after numbers proving the
TOTAL (discovery + implementation) dropped, not just the implementation half.

### Design refinements (2026-06-19) — resolved the open questions

The plan artifact is **NOT a full git diff**. It is a **list of files + a concrete
per-file brief of the change** for each. Lighter than a diff, but concrete enough
that implementation does not need to re-read files to learn what to write.

> **Code check done:** the discovery instruction (`packages/agents/src/index.ts:520`)
> currently asks only for "an ordered change list." It does NOT ask for a
> file-by-file structure with a per-file brief. The Reversi plan happened to
> organize by file, but each entry was prose *intent*, not a concrete per-file
> change brief — which is why implementation still opened the engine to learn the
> real API. **This is the fix for Finding 1/4: make the discovery prompt require
> `files[] = { path, action, brief }` explicitly.**

1. **Apply failures — not a real risk.** We run on a worktree. If a structured
   change can't be applied cleanly, implementation applies it **manually**. Manual
   apply IS the fallback; no diff-apply machinery needed.
2. **Cost relocating to discovery — acceptable, even desired.** Discovery SHOULD
   spend more if that buys the most straightforward implementation. The bad outcome
   was never "discovery is expensive"; it was "two stages both rediscover." We do
   NOT want discovery enumerating options — we want it to commit to one and pin it.
3. **Exploratory tasks (e.g. "debug this flaky thing").** Root-causing belongs in
   DISCOVERY (find the bug, decide the change), and reproduction/validation belongs
   in QA/verification — NOT implementation. Implementation should never run debug
   probes to figure out what to write. So there is no separate "exploratory plan"
   mode to gate on: discovery does the finding, the plan states the change.
4. **Gate review surface.** A `files[] + per-file brief` plan is already
   human-reviewable at `human_plan_approval`; confirm the gate CLI/UI renders the
   file list clearly. (Lower stakes than a full diff.)

### Measurement plan (do this BEFORE the B implementation)

- [ ] Implement the 6 new per-stage metrics (tool-call count, repeated reads,
      files-read, commands-run, tool-result bytes, retry/permission waits).
- [ ] Re-run THIS Reversi task instrumented; record the baseline numbers
      (expect ≈ implementation: 19 turns, repo surveyed 2×, N redundant re-reads).
- [ ] Throwaway experiment: (a) resume discovery→impl, (b) feed impl a
      hand-written exact diff. Compare turns + cost + did-it-work for each vs.
      baseline. This is the data that confirms or kills B before we build it.
- [ ] Decide gating signal (Q3) from what the experiment shows about small vs.
      large tasks.

---

## What is NOT a problem (don't "fix")

- **Verification being slow (7m 17s).** That's real-browser Playwright boot +
  video/trace recording. Acceptable.
- **Prompt caching / high cache_read share.** Healthy. Reducing turns reduces it
  as a side effect; don't disable caching.
- **Delivery parking on push failure.** Correct behavior — `wb-reversi` has no git
  remote, so `git push origin` failed and the task parked at the delivery gate
  rather than falsely completing. Environmental, working as designed.
