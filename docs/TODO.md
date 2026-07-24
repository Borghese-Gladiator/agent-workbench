# Backlog
Prioritized List of Things to Fix

Each task: what's wrong / what to do, where, and how we'll know it's done.
Status legend: `[ ]` open · `[~]` in progress · `[x]` done

---

## Live shakeout run — game-count UI feature (2026-07-22)

Drove a trivial UI feature ("show N games available in the portal header") on
`wip-browser-games`, claude runtime + `AWB_QA_MODE=browser`. **The full pipeline
ran end-to-end, first try, in ~7.5 min** (plan→implement→verify→exercise→
challenge→release; implement only ~100s — TASK-19's fewer-slices bias landed):
- Builder wrote a correct, clean, **test-backed** change (reused `enabledGames`,
  added `Portal.test.jsx` + wired vitest). candidate `7cde5fa`.
- **Browser QA fired inside the live pipeline** and produced real PNG + WebM
  video + Playwright trace zip (first live proof — TASK-4 confirmed e2e).
- **Adversarial reviewer reviewed the real diff** (ran Bash to inspect files)
  and converged with no blocking findings — TASK-14 confirmed live.
- Evidence-matrix PR comment correct: build/unit-test/qa-video all `passed`.

Two problems the run exposed: **TASK-20** ("stop before release" isn't
enforceable — release pushed a real draft PR #2 before the external watch could
stop it) and a **TASK-7 regression** (the qa-video/trace upload comments say
`undefined` instead of a real download URL; since fixed and confirmed live).

---

## P2 — The capstone

### [ ] TASK-12: Full President dogfood → real Draft PR with QA artifacts
The originally-requested end-to-end goal: use the workbench (claude runtime) to
implement the **President** card game in `Borghese-Gladiator/wip-browser-games`,
matching the poker/sheng-ji structure — a pure engine
(`packages/engines/president/src/engine.js` + Vitest), a React client
(`games/president/`, `useGameSocket("president")`), and a Playwright e2e — ending
in a **real Draft PR** carrying the workbench's QA artifacts (engine unit-test
run + browser-QA video/trace).
**Prerequisites:** TASK-1 (plan converges), TASK-2–7 (each real phase proven),
TASK-8 (real commands discovered so verify/QA are real). President also needs
server-side `useGameSocket` wiring, so it's an interactive run (answer the
contract gate; possibly reject a too-coarse plan).
**Done when:** a real Draft PR for President exists on the repo with real QA
evidence, reached via the workbench with no fake artifacts, and we stop at the
pr-readiness gate (no auto-merge).

**Assessment (2026-07-21) — would this work today? Partially; not unattended.**
What now works, proven on the README run: the mechanical spine
(specify→plan→implement→verify with a real worktree, real builder edits/commits,
real candidate SHA, real discovered test/build after prepare installs deps, real
usage aggregation). President is a bigger *code* task than a README, but the same
machinery applies, so the spine should hold.
The real risks are NOT in the plumbing anymore, they are:
1. **Convergence/quality of a hard multi-file task.** President is a real engine
   + React client + server `useGameSocket` wiring + Playwright e2e across several
   packages. The builder runs each plan slice as an *independent, cold* session
   (see TASK-19) with no shared memory, a 10k-token / 60s per-slice budget, and a
   diff-based success signal. A cross-cutting feature that needs coordinated
   edits across engine/client/server is exactly where cold per-slice sessions and
   tight budgets tend to stall or produce a partial, non-wiring-complete change.
   Expect iteration, not a clean first pass.
2. **The critic + adversarial reviewer are no-ops (TASK-14).** They never see the
   plan/diff, so nothing catches an under-wired or subtly-wrong implementation —
   the run can "pass" challenge with a broken feature. For President's
   correctness that matters a lot.
3. **Browser QA (TASK-4) is unproven live** and President's "done" REQUIRES a
   real qa-video/trace. It needs a discoverable dev-server start command
   (`resolveStartCommand`) and the server to actually come up in the worktree;
   that path has only been fixture-tested.
4. **Runtime.** At ~1–2h for a README (TASK-19), a multi-slice President run is
   plausibly many hours — needs supervision and probably a plan reject or two.
5. **Release opens a REAL draft PR + pushes** to the target remote (no dry-run
   guard) — must be run with a human present, never unattended.
**Bottom line:** the pipeline will very likely *drive* President through the
phases and produce a branch + commits, but reaching a *correct, QA-evidenced*
Draft PR in one shot is unlikely without (a) TASK-14 so review actually guards
quality, (b) TASK-4 proven so browser QA is real, and (c) TASK-19 so iteration is
tractable. Best run interactively, prepared to reject a too-coarse plan and to
repair after review.

**Update (2026-07-21):** the three named prerequisites are now addressed —
TASK-14 (critic/reviewer now receive their inputs via the contextPayload
preamble), TASK-4 (browser QA validated end-to-end; produces real video/trace),
TASK-19 (planner biased to fewest slices). Remaining risk is inherent difficulty:
President is a real multi-package feature and the builder still runs each slice as
a cold session, so cross-cutting engine/client/server wiring may need a repair
loop or two — but the review step can now actually catch an under-wired result.
Still: run it interactively (answer the contract gate, be ready to reject a coarse
plan) and remember release pushes a REAL PR, so a human must be present.
