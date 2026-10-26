# LOG — full git history at time of v5 archival

Archived 2026-10-26. This file is a durable snapshot of `git log` for the whole
repo, taken when v5 (this directory) was frozen and moved into `archive/`. Read
`../README.md` for the narrative of why each version was replaced. Read this file
for the raw commit trail.

v5 was built directly in this repo after v4 was archived (`439eec6`, 2026-07-20).
It is a TypeScript monorepo with a daemon, a Temporal worker, a web UI, and about
19 packages. The sections below start at the v4 archive commit.

| Era | Commits | Notes |
| --- | --- | --- |
| **v1-v4 frozen** | `b9163cf` (2026-07-20) | Initial commit of this repo with all four archives. |
| **v5** | `4c48aba` (2026-07-20) → `57e24b3` (2026-09-18) | Temporal-driven phase lifecycle, `awb` CLI, daemon, worker, web UI. |

## Full log (newest first)

```
2026-09-18 06:44  57e24b3  Update docs/TODO.md
2026-09-18 06:21  0c262b7  Group AA: remove every human gate, loop to a draft PR (TASK-104/105/106/107) (#44)
2026-09-15 10:24  ea1107d  Group R (research): markitdown adopted, design.md required, sandbox deferred (#49)
2026-09-15 10:23  40ce75c  Group R: a cross-task batch rollup, and Group AD's stale checkboxes (TASK-121) (#48)
2026-09-15 10:05  d4229c7  Group R (memory): give project memory a lifecycle and a run scratchpad (#47)
2026-09-15 10:04  9305438  Group AB: survive a network partition and make recovery legible (TASK-111) (#46)
2026-09-15 10:03  b7ef340  Group J: a missing dev server no longer dead-ends QA (TASK-73) (#45)
2026-09-05 19:20  350c51b  docs(skills): one front door for every workbench task run (#43)
2026-09-05 17:06  afc5868  Group AD (monitoring): live task phase/condition, workflow liveness reconcile, deterministic boot (TASK-123/126/127) (#41)
2026-09-05 16:54  b03974b  Group AD (observability): real phase and session durations + a read-back CLI (TASK-124/125/128) (#42)
2026-09-04 16:49  b31b6fd  docs(todo): delete the groups that shipped
2026-09-04 03:06  10e7e53  docs(todo): Group AD — observability + monitoring integrity defects
2026-09-01 15:39  45f95b5  chore(hooks): add a pre-push build and test gate
2026-08-28 04:26  a4f27cf  docs(skills): lead with claude runtime + re-root triage paths at DATA_DIR
2026-09-01 17:08  d5e702f  TASK-105: phase heartbeat liveness + Activity failure classification (#39)
2026-09-01 15:38  10cdb4a  Group O: operational control-plane UI redesign (TASK-80/81/83/84/85/86/87) (#33)
2026-09-01 15:34  0eb5d98  Group H: eval writeups + fan-in DAG edge (TASK-61/62/79/102) (#32)
2026-09-01 15:29  5a03dcf  Group P: runtime/QA/token gaps (TASK-89..98,101,103 + grill-me) (#34)
2026-09-01 15:26  2875eef  Group AC: dogfooding-at-scale resilience (TASK-112/113/114/115) (#37)
2026-08-28 04:59  f6c0100  Group M-verify: verify observability + per-package test glob (TASK-104/105/106 verify block) (#35)
2026-08-28 04:58  5d997b9  docs(research): TASK-100 external references adopt/steal/decline writeup (#29)
2026-08-28 04:58  40d8fd1  feat(skills): add dogfood skill — always-isolated stack for self-hosting (TASK-88) (#36)
2026-08-21 20:53  3648872  feat(fleet): agent-legible fleet-status view for monitoring tasks (#38)
2026-08-21 20:53  ae31baf  TASK-99: build-ui skill for greenfield UIs (Group Q) (#28)
2026-08-18 13:14  a4e604c  feat(observability): land Group AB — path drift, measured context composition, wired logger (#30)
2026-08-18 01:39  041e295  docs(todo): TASK-111 network-partition resilience + Group AC dogfooding-at-scale (TASK-112..115)
2026-08-17 16:40  6734a20  docs(todo): autonomy pivot (Group AA) + observability gaps (Group AB) at front; delete superseded TASK-82
2026-08-17 16:37  f587f6a  docs(skills): add close-pr skill — merge a worktree's PR and reconcile local main
2026-08-17 16:36  4f79943  feat(skills): run-workbench-task-simple + Group M dogfood findings (TASK-76/77)
2026-08-17 15:50  a0e4254  docs(todo): TASK-102 — task DAG fan-in (scheduling-only edge for "wait for A AND B")
2026-08-17 16:14  4e3dd9c  feat(repository): emit command/testing facts from discovery so the planner sees repo commands (#27)
2026-08-17 15:48  320b2dd  Stacked-PR task DAG orchestration + Group I delivery (TASK-71/72) + dogfood fixes (#23)
2026-08-17 15:42  435d07a  feat(quality-gates): exercise gate rejects no-op / off-target candidates (TASK-63)
2026-08-16 15:15  ad27b12  Group K: repo discovery scaling + cross-ecosystem dependency graph, and start-command reuse (#24)
2026-08-15 18:52  331c21b  docs(todo): add evaluation, UI control-plane, runtime/QA/token, skills & research backlog
2026-08-15 17:18  0f324f0  fix(exercise): route QA evidence deficiencies to qa-inconclusive, not repeated-failure-no-progress (TASK-75)
2026-08-11 11:33  6090be8  feat(workspace): human-readable worktree directory names (TASK-78)
2026-08-11 11:10  4635e12  Update docs/TODO.md - delete old, add new
2026-08-09 04:12  faef916  Merge pull request #20 from Borghese-Gladiator/timothyshee/group-h
2026-08-09 03:54  12f2cbd  refactor(config): single-source the runtime-shape defaulting (TASK-70 follow-up)
2026-08-09 03:52  10f6c9c  feat(exercise): comprehensive cross-ecosystem run/start-command resolution
2026-08-09 02:19  d218b79  docs(TODO): mark Group H (TASK-65..70) done; fold in TASK-69/70 entries
2026-08-09 02:17  05558b5  feat(cli): stale-dist resilience + warm-stack runtime-env visibility (TASK-69/70)
2026-08-09 02:12  2826186  feat(exercise): worktree start-command + robust/verbose dev-server + L-size cap override (TASK-65/66/68)
2026-08-08 18:05  9c7e717  fix(program-design): stop bodyless-check false-positives on valid TS shapes (TASK-67)
2026-08-09 03:00  5f0ddfe  Merge pull request #19 from Borghese-Gladiator/timothyshee/up-verbose-fix
2026-08-08 18:04  0c39139  fix(cli): stop orphaning the UI dev server + add --verbose to up/ui up
2026-08-08 18:04  05412eb  docs: add TASK-69/70 + harden run-workbench-task skill for greenfield/no-remote
2026-08-08 17:48  ed4836e  docs(TODO): add TASK-65..68 — greenfield/full-MVP gate friction
2026-08-08 15:27  32946ba  docs(pr-style): document the posted-message signature
2026-08-08 15:21  ec898f2  feat(github): prepend a Claude Code signature to posted GitHub messages
2026-08-08 15:29  bb98f70  refactor(config): readonly RuntimeConfig + honest isolation docs
2026-08-08 16:02  1fb3db0  Merge pull request #15 from Borghese-Gladiator/timothyshee/group-g-legibility-dx
2026-08-08 15:28  af5ec16  docs(skill): implement-feature stops at commit+report, not close-worktree
2026-08-08 15:13  51c3c39  Merge pull request #16 from Borghese-Gladiator/timothyshee/task-59-multistack
2026-08-08 15:12  b9c8808  docs(skill): rewrite implement-feature around self-hosted delegate-and-verify
2026-08-08 07:21  2431270  Merge pull request #17 from Borghese-Gladiator/timothyshee/task64-ui-tailwind
2026-08-08 07:02  68961b0  fix(web): finish Tailwind migration + build shell (TASK-64)
2026-08-08 06:43  d4a2119  feat(cli): parameterize + self-isolate the runtime stack for concurrent worktrees
2026-08-08 06:35  66fd444  Update TODO.md - add task
2026-08-08 06:28  3b0221b  fix(opencode): confine to worktree via --dir + env model override + TASK-63
2026-08-08 02:45  3016ac5  docs(legibility): activities map + de-stale worker README + feature-impl skill
2026-08-08 02:37  b44b23b  Update TODO.md - delete completed tasks
2026-08-08 01:12  28de9af  chore: strip TASK provenance tags and low-value comments from live code
2026-08-08 02:40  674a5e3  Merge pull request #14 from Borghese-Gladiator/timothyshee/group-a-opencode
2026-08-08 00:45  2f9a259  feat(opencode): capability-scoped agent — deny ungranted tools via generated agent
2026-08-08 00:36  3297feb  Merge pull request #13 from Borghese-Gladiator/timothyshee/group-a-codex
2026-08-08 00:19  dcc505d  Merge pull request #7 from Borghese-Gladiator/timothyshee/group-b-planning
2026-08-08 00:05  3e23b27  docs(TODO): file TASK-62 — evaluate a local shadow classifier as a Haiku replacement
2026-08-07 23:49  2e2f789  refactor(sizing): colocate the Haiku + Ollama classifiers as sibling functions
2026-08-07 23:41  4681ed1  refactor(sizing): model-first size classifier (Haiku) + local Ollama shadow
2026-08-08 00:12  e3b7f9a  Merge pull request #9 from Borghese-Gladiator/timothyshee/group-e-token-memory-graph
2026-08-07 06:56  137b34c  feat(workflow): route structural loop-backs to program-design on L runs (TASK-60)
2026-08-07 06:37  6bf05d9  docs(TODO): file TASK-60 (route architecture loop-backs to program-design) + TASK-61 (evaluate L+program-design)
2026-08-04 02:03  43d3406  fix(implement): synthesize a single-shot plan for S tasks; add edge-case coverage
2026-08-04 00:09  7127256  feat(planning): Group B — phase-sizing router, program-design phase, velocity guardrail
2026-08-08 00:07  d13cdfe  Merge pull request #6 from Borghese-Gladiator/timothyshee/group-c-quality-gates
2026-08-07 23:59  9400a35  feat(codex): capability-driven sandbox — read-only vs workspace-write per role
2026-08-07 23:51  a61962e  Merge pull request #10 from Borghese-Gladiator/timothyshee/group-a-pi
2026-08-07 22:01  fa49ddb  fix(quality-gates): route TASK-53 maintainability session through RuntimeProfile
2026-08-07 16:32  4054ad6  refactor(quality-gates): drop successCriteria, keep problemStatement (TASK-54)
2026-08-04 15:34  f6f1117  refactor(qa): drop WebSocket transport inspection from QA (TASK-42)
2026-08-04 02:23  a01a0f5  test(quality-gates): end-to-end proof real QA drives the exercise gate (TASK-42)
2026-08-04 00:00  6c682ba  docs(TODO): mark Group C (TASK-42/53/54) done + note TASK-54 scope decision
2026-08-03 23:59  ceac032  feat(quality-gates): advisory maintainability review, non-blocking (TASK-53)
2026-08-03 23:52  c45d2f9  feat(quality-gates): QA interaction-correctness gate, not just liveness (TASK-42)
2026-08-03 23:42  353bad1  feat(quality-gates): reviewer-alignment gate before implementation (TASK-54)
2026-08-07 21:53  6e26b2a  feat(memory): wire the project-memory loop end to end + review fixes
2026-08-07 06:06  77c2256  feat: Group E — token cost, memory KB, graph-plane ADR
2026-08-07 06:38  0bd88de  feat(pi): full-parity Pi runtime — structural tool boundary, model routing, doc tier
2026-08-07 23:23  a0df239  fix: two TASK-38 left-behinds — decay emit + agentProvider enum route through the runtime set
2026-08-07 16:22  3d4c914  docs(README): add mermaid runtime + lifecycle diagrams
2026-08-07 16:17  a1825e7  docs(skill): close-worktree detects an already-merged branch before landing
2026-08-07 16:10  6427f4a  docs(README): reframe from status report to repo explainer
2026-08-07 16:07  0334b26  docs: replace dead 'product spec §N' references with live code anchors
2026-08-07 06:50  8fe3317  Merge pull request #5 from Borghese-Gladiator/timothyshee/group-d-pr-quality
2026-08-07 06:47  4c71030  chore(proof): remove throwaway TASK-58 proof media + generator
2026-08-07 06:42  04cf224  fix(qa): clean up the ffmpeg palette-PNG intermediate after GIF transcode
2026-08-07 06:40  e0428d1  Merge pull request #4 from Borghese-Gladiator/timothyshee/group-f-observability-web
2026-08-07 06:39  6f81292  chore(proof): TASK-58 real GIF/WEBM QA media + re-runnable generator
2026-08-07 06:25  8557134  Merge pull request #8 from Borghese-Gladiator/timothyshee/group-a-foundation
2026-08-07 06:24  f1357c3  fix(agent-gateway): accumulate OpenCode per-step output tokens
2026-08-04 02:31  94a8e3b  fix(cli): boot from a worktree — active-node binary + workspace-marker repoRoot
2026-08-03 23:45  0538c56  feat(observability,web): Group F — live timeline backfill/reconnect, live task list, run decay metrics
2026-08-03 23:44  d7d7e1d  feat(runtime): profile-driven phase gate + Codex/Pi/OpenCode adapters
2026-08-03 23:24  2be75fc  feat(github,qa): Group D — clean PR titles/branches + inline QA-recording GIF
2026-08-03 22:20  1b3929d  feat(web): widen GET /api/tasks; drop per-task status fan-out on Tasks page
2026-08-03 16:56  d3dbe12  fix(web): wire Tasks page to the real /api/tasks (was rendering stub data)
2026-08-03 16:56  3a37bf4  docs(TODO): salvage President-dogfood findings from todo-president-followups
2026-08-03 16:52  36e6c92  docs(TODO): drop completed tasks + regroup by implementation theme
2026-08-03 22:44  8623b22  Merge pull request #1 from Borghese-Gladiator/timothyshee/level2-self-edit
2026-08-03 22:36  456dc15  docs(skill): tighten create-worktree self-run note to the skill's scope
2026-08-03 22:19  5a3f50c  fix(daemon): exclude test files from build tsconfig
2026-08-03 22:19  ddb7696  feat(runtime): run-from-dist so the workbench can safely edit its own code
2026-08-03 08:48  24fb77c  docs(TODO): add TASK-51..56 from "Why Software Factories Fail"
2026-08-03 16:50  e2f3d2e  Merge pull request #3 from Borghese-Gladiator/timothyshee/shadcn-port
2026-08-03 15:43  e06cee2  chore(web): remove proof screenshots from branch
2026-08-03 14:26  d051a5c  proof(web): port v4 shadcn/ui + Linear theme, rebuild Tasks page on it
2026-08-03 01:14  b49581e  fix(hooks): always run docs audit on pre-commit (rename could evade trigger)
2026-08-03 01:13  bb4a08a  chore(hooks): pre-commit runs docs audit; auto-install via prepare
2026-08-03 00:55  befd643  chore(docs): fix docs↔reality drift + add re-runnable audit script
2026-08-02 22:42  174de82  chore(repo): AI-parsing structure adjustments (root CLAUDE.md, scripts/, ignores)
2026-08-03 01:10  3fcfbbb  docs(TODO): triage idea backlog into TASK-38..50 + graph-plane framing
2026-07-29 14:45  662806f  feat(cli): bare `awb` via tsx wrapper + PATH symlink
2026-07-29 11:05  9def24b  docs: fix verify cheat-sheet (f-string bug, port labels, live-trace prereqs)
2026-07-29 10:40  02bae11  docs: add TASK-36/37 verification cheat-sheet
2026-07-28 13:14  c2ba16b  feat(observability,cli): one-trace-per-run + awb task remove (TASK-36/37)
2026-07-27 16:47  bd1e6d7  docs(TODO): add TASK-36 (one-trace-per-run) + TASK-37 (task delete CLI)
2026-07-27 16:05  871d5f0  fix(cli): don't publish the collector's gRPC 4317 port (collision)
2026-07-27 13:30  3e1219e  docs(observability): add docs/observability.md + mark TASK-31/32/34/35 done
2026-07-27 13:27  8493bf8  feat(observability): control-plane events + OpenTelemetry (TASK-34)
2026-07-27 13:14  5c602af  feat(resilience): pin builder cwd + durable agent-session resume (TASK-31/32)
2026-07-27 15:10  1c84e75  docs(skill): rename drive-task -> run-workbench-task, require repo path
2026-07-27 12:01  a7dbdb5  docs(TODO): add P1 retry-resilience backlog (TASK-31/32/34/35) + ADR-008
2026-07-27 12:00  76f4f1e  Update run-lifecycle
2026-07-27 11:39  c0e0b6e  feat(cli): rework awb to the runtime/UI command spec
2026-07-24 15:58  cdde22f  docs(TODO): delete completed P1 Durability & observability section
2026-07-23 15:03  f909a4e  docs(TODO): mark P1 Durability & observability section DONE
2026-07-23 09:28  ef27c94  feat(lifecycle): wire QA/feedback, promote discovery to a workflow, continue-as-new (TASK-25/26)
2026-07-23 05:12  bbee540  feat(security): enforce capability scope on the agent session via disallowedTools (TASK-24)
2026-07-23 05:04  9967f44  feat(observability): reconnect catch-up route + Web UI WebSocket (TASK-23)
2026-07-23 05:01  1ca4b64  feat(observability): §27 runtime-attribution + by-model tokens/cost (TASK-22, part 2)
2026-07-23 04:48  c327175  feat(observability): wire real semantic-event sink + live stream (TASK-22, part 1)
2026-07-23 04:42  27cd690  feat(durability): persist run-state to SQLite via daemon; worker read-only (TASK-27/21)
2026-07-23 02:47  cbedc66  docs(TODO): mark TASK-7 done — QA-media upload confirmed live on PR #4
2026-07-23 00:49  4974f44  fix(github): reliable QA-media upload into the PR (TASK-7)
2026-07-23 00:45  37833d9  docs(TODO): delete completed P0 Tame-run-phase section (TASK-28/29/30)
2026-07-23 00:43  5eab061  refactor(worker): tame run-phase.ts — driver + handlers, one strategy, store seam
2026-07-23 00:42  2c605bf  Update docs/TODO.md - delete done tasks
2026-07-23 00:39  b19b9de  feat(skills): add worktree lifecycle skills (create + close)
2026-07-23 00:26  3e89e71  docs(TODO): record confirmed root cause for TASK-7 QA-media upload
2026-07-23 00:24  40ef127  test(worker): prove the QA-media undefined-URL guard (extract postQaMediaBriefs)
2026-07-23 00:16  d67970b  Update docs/TODO.md
2026-07-22 23:48  49868f5  fix(github,workspace): PR title keeps scope; branch name is sane, not a doubled UUID
2026-07-22 23:27  11cba66  feat(github): short PR title + real body template, drop evidence-matrix comment
2026-07-22 23:10  d24e13a  docs(TODO): record game-count shakeout run — full pipeline e2e + TASK-20/7 findings
2026-07-21 15:27  8d7f13f  feat: President-readiness fixes — TASK-14 (context), TASK-19 (slices), TASK-4 (browser QA)
2026-07-21 11:50  bd0d427  docs(TODO): add TASK-19 (planner over-decomposition) + President dogfood assessment
2026-07-21 11:00  5e78c00  docs(TODO): live-run status + record TASK-15/16/17/18 findings
2026-07-21 10:49  fbfccad  fix(worker): prepare installs worktree dependencies (verify no longer fails on missing deps)
2026-07-21 08:14  8ed538c  test(cli): make approval-flag tests independent of a running daemon
2026-07-21 07:43  35ebd27  fix(worker): map every contract claim to a slice so plan converges
2026-07-21 07:25  0e7430e  docs(TODO): mark TASK-2/3/11 live-confirmed with evidence
2026-07-21 07:07  a22cf0b  fix(worker): verify must inherit a real env so discovered commands resolve (TASK-3)
2026-07-21 05:50  e894fc9  fix(worker): planner inspects target repo + completed no-edit slice succeeds
2026-07-21 05:45  adfc31a  docs(TODO): record live-run findings — TASK-8/9 confirmed, add TASK-13 builder-tools
2026-07-21 05:41  04f1d79  fix(agent-gateway): map capabilities to SDK tools + headless permission mode
2026-07-21 05:33  c5818fb  feat(workflow,worker): aggregate per-phase token/runtime usage (TASK-11)
2026-07-21 05:27  a47e9cc  fix: unblock plan phase (qa-scenario coverage) + persist agent events (TASK-1)
2026-07-21 05:20  4283bc9  feat(repository): discover root + workspace-package commands (TASK-8)
2026-07-21 05:16  2d34604  fix(cli): rename approval --version flags and strip pnpm-injected -- (TASK-9, TASK-10)
2026-07-21 05:09  49e0242  docs: backlog of live-run failures, validation gaps, and the dogfood
2026-07-21 05:08  dd14d85  feat: make runPhase do real work + real delivery, behind AWB_AGENT_RUNTIME=claude
2026-07-21 05:08  43639cc  feat(cli): one-command stack boot, remembered ids, and a drive-task skill
2026-07-20 14:37  aaf8452  fix: worker's workflowsPath resolution, add real `dev` scripts to every app
2026-07-20 14:00  c29ba7c  docs: Milestone 11 — agent-legibility audit
2026-07-20 13:55  bf9b1bc  feat: Milestone 10 — remaining dashboard pages, task list route
2026-07-20 13:45  9196ae8  feat: wire the real runPhase Activity to drive all 9 lifecycle phases
2026-07-20 13:43  2ab9c0f  feat: Milestone 10 (part 1) — Fastify daemon, CLI daemon/task commands, web UI shell
2026-07-20 13:14  853e3cf  feat: Milestone 9 — GitHub delivery
2026-07-20 13:09  fee0f1b  feat: Milestone 8 — QA and adversarial review
2026-07-20 13:03  db1cc31  docs: fix stale package references in testing.md and security.md
2026-07-20 12:59  baf2e7d  feat: Milestone 7 — verification and evidence
2026-07-20 12:55  463f257  feat: Milestone 6 — planning and implementation loop
2026-07-20 12:48  fd195ea  docs(agent-gateway): flag the SDK's tools-vs-allowedTools naming trap
2026-07-20 12:48  4d8254b  feat: Milestone 5 — agent gateway, plus policy package and doc fixes
2026-07-20 12:37  be2ff62  feat: Milestone 4 — workspace, execution, and capability broker
2026-07-20 11:13  73b4cc0  feat: Milestone 3 — Temporal lifecycle
2026-07-20 10:20  4d69ab3  docs: agent-legibility pass — root AGENTS.md, ADRs, dependency graph, per-package READMEs
2026-07-20 03:59  cb59e90  feat: Milestone 2 — repository intelligence
2026-07-20 03:48  96f4d0e  feat: Milestone 1 foundation — monorepo, domain schemas, database, artifact store, CLI
2026-07-20 02:53  4c48aba  docs(archive): add v4 FEATURES.md — full shipped feature inventory
2026-07-20 02:14  b9163cf  Initial commit: archive of agentic dev-task system v1-v4
```
