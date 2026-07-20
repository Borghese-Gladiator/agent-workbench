# LOG — full git history at time of v4 archival

Archived 2026-07-20. This file is a durable snapshot of `git log` for the
whole repo, taken the moment v4 (this directory) was frozen and moved into
`archive/`. It exists so the reasoning behind each iteration survives even
after the working tree is gone — read `../README.md` for the narrative
summary of why each version was replaced; read this file when you need the
raw commit-by-commit trail.

The repo's own commit history doesn't perfectly match the four `v1..v4`
archive folders — two prior iterations were built in **separate repos**
(`agent-workbench__ai`, `202605_agent_workbench_v2`) and their full git
histories were imported into this repo as subtrees on 2026-05-24 (see the
`import: ...` commits below), which is why their commits interleave with
this repo's own v1 commits by date rather than by ancestry. The rough
boundaries:

| Era | Commits (this log, top-to-bottom = newest-first) | Notes |
| --- | --- | --- |
| **v1** | `97e942d` (2026-04-23) → `7b36721`/`e7b8819` (2026-05-24) | Built directly in this repo. Renamed `agentic-development-task-system__ai` → `...-v1__ai` at the v2/v3 import point. |
| **v2 import** | `7fe965f` (2026-05-24) | Full history of the separate `agent-workbench__ai` repo (`202605_agent_workbench` @ `9691b1f`) imported in one commit. |
| **v3 import** | `ba303a8` (2026-05-24) | Full history of the separate `202605_agent_workbench_v2` repo (@ `f52f7dd`) imported in one commit, taking the `agentic-development-task-system-v3__ai` name. |
| **v1-v3 frozen** | `a14cb01` "archive all preexisting" (2026-06-02) | Single commit that `git mv`'d all three trees into `archive/`, mirroring what this archival does for v4. |
| **v4** | `52fe7a9` (2026-06-02) → `439eec6` (2026-07-20) | Built directly in this repo (fresh TS monorepo: core/store/worktree/agents/validation/delivery/client/mcp + daemon + web). Frozen into `archive/agentic-development-task-system-v4__ai` by the same pattern. |

## Full log (newest first)

```
2026-07-20 00:56  439eec6  archive: move v4 (agent-workbench) into archive/agentic-development-task-system-v4__ai
2026-07-20 00:46  7485645  docs: add CLAUDE.md agent guide
2026-07-20 00:46  92dc59d  chore: tidy repo layout, dedupe stage docs, drop shipped plans
2026-07-10 17:23  81e5a5a  Update docs/TODO.md
2026-07-06 21:33  0547408  feat(agents): OpenAI Codex agent harness — adapter + profile + sandbox policy mapping
2026-07-06 16:29  7452d25  feat(agents): external helper tools — klaviyo-local-seed injection for enterprise repos
2026-07-02 15:02  f8f13fc  fix(mcp): derive all closed-set inputs from core; surface missing fields
2026-07-02 03:01  8d94932  fix(mcp): derive create_project agentRuntime enum from AGENT_RUNTIMES
2026-07-02 02:10  45f01a1  feat(queue): atomic DAG creation — single-transaction create_queue_dag
2026-07-02 02:03  335e8dd  docs(plan): record shipped queue DAG + plan atomic DAG creation follow-up
2026-07-02 00:24  bec7dd7  feat(queue): multi-predecessor DAG (fan-in) + bulk `wb queue create`
2026-07-01 17:31  d074857  docs(queue): document the multi-task queue + dependency DAG
2026-07-01 11:36  af14cfb  chore(scenarios): add browser-games-platform recorder scenario
2026-06-30 15:46  c3e6f50  feat: pluggable agent runtimes — Pi adapter + RuntimeProfile + per-project runtimeConfig
2026-06-28 02:15  6fd2631  feat(lifecycle): split Verification into static_checks + feature_e2e
2026-06-29 20:40  5eec604  feat(web): show full worktree diff on Human Review gate
2026-06-29 16:34  9e36bb4  perf(delivery): async git so long rebase/squash never blocks the event loop
2026-06-29 20:24  bad888e  fix(worktree): drop wb/ namespace from task branch names
2026-06-29 20:23  b61c4c4  fix(worktree): drop wb commit prefix; site worktrees beside their project
2026-06-29 20:25  d829137  Update docs/TODO.md
2026-06-28 02:05  a1b7e04  fix(web): clarify Delete dialog worktree copy
2026-06-28 01:50  dd751ce  fix(delivery): re-stage + retry commit when a format hook mutates the tree
2026-06-28 01:37  039d2c8  feat(web): board cards lead with project, show dependency state
2026-06-28 00:52  f201d82  feat(queue): drive tasks from intake + diamond-DAG QA
2026-06-28 00:39  da658eb  feat(queue): multi-task scheduler with dependency DAG + priority
2026-06-26 23:29  205f145  Create docs/MANUAL_delete_tasks.md
2026-06-26 23:22  7f2a2f3  feat(demo): --attach mode records against the running daemon
2026-06-26 23:15  9ef1afe  chore(skills): remove redundant code-review slash skills
2026-06-26 23:08  8520a05  docs(skills): use repo Playwright for screenshots, add shot.mjs helper
2026-06-26 14:22  86a3c1f  feat(web): panels & sections UI treatment across pages
2026-06-26 14:33  80b7523  harden(daemon): resumable runs + boot reconciliation (kill orphan groups, auto-resume parked tasks)
2026-06-25 15:28  5a501be  test+lint: add rev to web Task fixtures, register 0012 in migrator test, tidy imports, drop debug log
2026-06-25 15:23  ab042cc  harden(daemon/store): loopback bind + shared-secret gate, transactional rev-guarded transitions
2026-06-26 23:02  14fa4fe  feat(mcp): add @workbench/mcp server and drive the demo through it
2026-06-26 14:13  56ddd2d  feat(brief,skills): derive task titles from briefs; template-driven PR descriptions
2026-06-26 14:13  6abd6fb  docs: add plan for embedding QA media artifacts in the review panel
2026-06-25 15:44  e84b8ba  feat(web): embed QA image/video artifacts directly in the review panel
2026-06-25 15:58  1077764  feat(observability): persist run latency + inter-event gap profiling
2026-06-25 15:30  e841cbe  refactor(agents): make Effort a string enum
2026-06-25 13:36  aa594c7  feat(agents): per-stage --effort + retune per-stage models
2026-06-25 13:19  d000afa  Update record.spec.ts
2026-06-25 13:18  6e0df88  Update playwright.config.ts
2026-06-25 13:18  461255a  Update TODO.md
2026-06-25 13:17  2db75dd  Create browser-games-shengji.json
2026-06-23 17:37  af4c676  fix(demo): show server-backed apps in the recorder instead of a white screen
2026-06-23 16:42  9a9f13b  Update run-demo
2026-06-23 16:42  de62ada  Update TODO.md
2026-06-23 16:41  8933ba6  feat(daemon/web): event-driven live task refresh over SSE
2026-06-23 16:33  44acc6e  feat(delivery): skip prep agent for merge_to_master + rebase-then-squash
2026-06-23 15:38  35d5fae  feat(drive): build-inside-existing-repo scenario (wipe:false) + browser-games-ttt
2026-06-23 03:27  0ac6457  perf(drive): ride the SSE run-complete signal instead of polling through it
2026-06-23 03:24  9382422  perf(drive): adaptive backoff polling instead of fixed 3-4s ticks
2026-06-23 02:28  d74da0d  refactor(scripts): one driver + JSON scenarios for all lifecycle runs
2026-06-23 14:43  2b2e1f9  feat(profiling): per-turn TTFT + token capture instrumentation
2026-06-22 15:49  22a91fb  docs(todo): add follow-ups (PR-desc skill, README-not-updated, CLI list-info)
2026-06-22 15:43  e0b1399  feat(profiling): capture true model-API latency + a model/tool-wait split tool
2026-06-19 04:53  8f8b943  feat(demo): --repo app|fender for enterprise + working fender validation cmds
2026-06-19 03:36  70eeab5  docs(todo): correct the ECONNRESET conclusion (unit flake was NOT git)
2026-06-19 03:32  396174c  docs(daemon): root-cause writeup + repro for the intermittent ECONNRESET
2026-06-19 03:32  0b8a929  test(daemon): fix two independent suite flakes (drifted naming + tight timeout)
2026-06-19 03:32  6c733d1  fix(validation): use async spawn instead of spawnSync (unblocks daemon loop)
2026-06-19 03:25  47dc3e1  perf(lifecycle): run single-reviewer self_review inline (no subagent)
2026-06-19 03:24  a91d2fa  perf: fix three workbench efficiency findings from live profiling
2026-06-19 03:24  f281c82  feat(profiling): per-stage metrics tooling + audit baseline
2026-06-19 03:17  310933f  Update TODO.md
2026-06-18 15:48  a790a7b  Update TODO.md - delete DONE
2026-06-18 15:26  1a59bd5  perf(lifecycle): per-stage model routing + parallel QA/self-review
2026-06-18 13:37  b77c9e3  feat(demo): add /run-demo skill + follow verification stage rename
2026-06-18 11:20  ce9fb82  feat(demo): make the enterprise scenario ticket-driven, not a fixed story
2026-06-18 10:42  db53096  fix(daemon): scope validation tests to the task's changed files
2026-06-16 18:32  3850790  feat(demo): record the workbench driving a task end-to-end
2026-06-18 13:51  aaa45ba  Update TODO.md
2026-06-18 02:45  cee0fdc  feat(timing): track task elapsed + per-stage + per-Claude-session durations
2026-06-18 02:23  ac5866c  fix(memory): clean summarizer output — no compliance banner, no preamble, no json fence
2026-06-18 02:01  f6bd2af  test(memory): add verify:memory script to judge summarizer output quality
2026-06-18 01:29  88cf7d2  feat(memory): per-project memory log written at closeout, read at discovery/planning
2026-06-18 02:01  7a7fb9e  feat(lifecycle): stop agent session + abandon task from any stage
2026-06-18 01:57  2128dce  feat(skills): write-readme as the final step of implementation on empty repos
2026-06-18 01:54  2ec7173  refactor(lifecycle): rename validation_demo stage id -> verification
2026-06-18 01:51  fab4f84  feat(lifecycle): merge discovery + options_plan_test into one stage
2026-06-18 01:42  53edaf8  docs(todo): update per-stage model pinning for merged discovery stage
2026-06-17 16:52  ee91b80  feat(agents): capture per-run token usage + surface per-stage cost
2026-06-17 15:03  9a939ea  Update TODO.md
2026-06-17 14:48  db933ec  docs(todo): delivery must re-stage + retry past format-on-commit hooks
2026-06-17 13:39  40c38e9  feat(agents): load repo env before tests on enterprise worktrees (direnv/venv)
2026-06-17 11:28  fc30dcf  fix(agents): scope output-quality prune clause + guard empty plan artifacts
2026-06-17 02:17  a3322d6  feat(agents): sharpen output-quality bar + operator-ask criteria
2026-06-17 01:53  379628d  feat(agents): cross-cutting output-quality bar (scale output to the work, not a template)
2026-06-17 01:36  ecc9ccb  fix(agents): stop duplicating structured-json in artifact bodies + threaded context
2026-06-17 01:27  f1f4d84  feat(agents): thread prior-artifact BODIES into stage prompts (fix turn explosion)
2026-06-17 01:06  db614e4  feat(agents): env-gated stage-prompt capture + IDs-only handoff evidence
2026-06-17 00:46  f21fc9f  docs(todo): root-cause the agent turn explosion + record per-stage model plan
2026-06-17 14:49  b772dfe  Update TODO.md
2026-06-17 02:46  78b0fb1  chore(docs): remove unreferenced streaming-panel e2e screenshots
2026-06-17 02:37  3de6e69  refactor(web): replace TaskDetail ⋯ overflow menu with an icon Delete button
2026-06-17 02:31  7889d83  feat(web): constrain live streaming panel to the current active stage
2026-06-17 02:21  0ee80cf  docs(todo): ECONNRESET instrumentation is a plan, not yet in tree
2026-06-17 01:16  0841cde  docs(todo): resolve "skipped all approval gates" — document two-layer gate mechanism
2026-06-17 00:53  8e03665  docs(todo): track ECONNRESET-kills-recorder bug (distinct from vitest flake)
2026-06-16 22:32  c119343  docs(todo): reorganize into DONE/TO DO/Backlog; mark PR-description skill done
2026-06-16 22:28  9f9d403  feat(agents): add pr-description skill, write real PR body at delivery_prep
2026-06-16 18:21  151c267  feat(agents): acceptance-criteria contract across the story-normalization boundary
2026-06-16 18:12  9c470b8  feat(agents): wire Linear + Sentry MCP servers for Klaviyo repos
2026-06-16 17:06  841531d  refactor(lifecycle): drop Baseline Evidence + Worktree Creation as stages
2026-06-16 17:06  db44b98  feat(agents): lock Task Brief out of code reading; allow external research only
2026-06-16 16:17  5b9cd9b  fix(web): render free-text input only for options-less questions
2026-06-16 16:09  e035eff  refactor(lifecycle): drop worktree_creation as a stage
2026-06-16 15:32  17d75fb  feat(web): separate "All projects" from the project list in the board filter
2026-06-16 14:47  31b14a1  feat(enterprise): enforce canonical [klaviyo] app/fender names on seed
2026-06-16 13:09  713eeb2  feat(qa): QA-with-video on the lifecycle via a shared Playwright harness
2026-06-16 02:18  fe88a7a  fix(daemon): resume the planning session on plan rejection AND bounce
2026-06-16 10:50  8797cfb  feat(enterprise): seed app/fender projects + deepen review skills
2026-06-16 03:27  91bfb60  fix(daemon): guard detached agent runs against unhandled rejections
2026-06-16 03:18  4d98acb  docs: mark easy bugs done + record proven test-flake root cause
2026-06-16 03:17  0eb7b5b  fix: easy bug batch — branch naming, PR body, artifact-first streaming UX
2026-06-16 02:23  71fa59f  fix(review): scope self-review re-runs to prior findings, not a fresh full-scope pass
2026-06-16 02:54  0bc00f6  Update TODO.md
2026-06-15 22:41  093bfe1  docs: prune transient/redundant docs
2026-06-15 22:35  40a59b9  docs: triage misc bugs + add Q1 bounce convergence controls to TODO
2026-06-15 22:35  b3ca072  fix(daemon): resume the implementation session on a human-review bounce
2026-06-15 14:38  b284de5  fix(agents): derive stage system-prompt prohibition from the allowlist
2026-06-15 13:02  62c1355  docs: document @workbench/client + wb CLI and the self-target guard
2026-06-15 12:39  c1d8479  feat: self-target worktree guard + @workbench/client + wb-drive skill
2026-06-13 02:16  8cbfa96  Update TODO.md
2026-06-12 20:30  b11cff0  fix(router): detect the app profile by content, not path — worktrees lost their skills
2026-06-12 19:49  4987562  fix(delivery): squash-merge in the base-owning checkout + park on failed publish
2026-06-12 19:46  5ec8250  wb: Add write-app / write-fender implementation skills (enterprise code-writing) + programmatic enforcement
2026-06-12 19:30  d95e782  fix(agents): raise per-stage turn budget 30 -> 100 (+ WORKBENCH_MAX_TURNS)
2026-06-12 19:15  722f685  fix(agents): deny escape tools on read-only stages + stall watchdog
2026-06-12 17:35  44311d8  Create architecture.md
2026-06-12 16:44  5fd205b  fix(cost): persist agent run cost and show it on Task View
2026-06-12 16:35  0a39499  fix(web): version-number repeated artifacts (V1/V2) on Task View
2026-06-12 16:33  a8d0233  fix(brief): reject auto-regenerates via session resume + returns to gate
2026-06-12 16:29  f9129a7  feat(delivery): real squash-merge / draft-PR publish + agent conflict resolution
2026-06-12 15:24  9c6d8ca  feat(web): collapse project build commands + auto-detect from repo
2026-06-12 16:29  5039f9a  fix(discovery): skip explore agent run on a brand-new / empty repo
2026-06-12 14:26  a18cdae  chore: remove stale root-level plan/scratch docs
2026-06-12 13:37  f3197b6  feat(stream): live Claude session terminal with gap-free SSE streaming
2026-06-12 12:33  5ab2e59  feat(web): Linear-style gate-centric task board + Linear retheme
2026-06-12 12:17  21a770e  feat(delivery): typed per-project delivery policy, decoupled from worktree mode
2026-06-12 11:13  50fd6b6  feat(lifecycle): real baseline + Verification + skippable worktree + real implementation agent
2026-06-11 14:12  5a24ec7  Update TODO.md
2026-06-11 13:56  06675a5  refactor(web): attribute artifacts to stages via owning StageRun
2026-06-10 19:12  6564ab3  Update TODO.md
2026-06-10 11:56  b0e75ac  feat(web): collapsible sidebar + nest Task View artifacts under stages
2026-06-10 13:09  8a2a330  fix(web): give bounce actions unique React keys in ApprovalGate
2026-06-10 13:07  966f5a0  chore: change default daemon port 4317 → 4417
2026-06-09 17:09  238ca6a  Update TODO.md
2026-06-09 16:55  5538180  fix(web): render Task View artifacts as formatted, editable markdown
2026-06-09 15:57  cd0ceb5  chore: apply Biome lint/format fixes across monorepo
2026-06-09 15:04  fd48402  docs: prune shipped plan docs; add vision.md; trim testing-strategy
2026-06-09 14:57  9ec9d56  fix(daemon): route lifecycle stages through real agent for claude projects
2026-06-09 00:22  aaea913  fix(daemon,web): validate repoPath at create; route mock projects to stub worktree
2026-06-09 01:40  6d8b9fa  feat(skills): author app/fender review + TDD planning skills with compliance enforcement
2026-06-09 00:21  9a606c6  chore: add Biome linting + formatting (config + scripts only)
2026-06-08 23:30  e28b052  chore: add Docker Compose provisioning (daemon + web + seed)
2026-06-08 22:09  f38d1fd  docs(readme): document e2e/proof commands; reflect real validation + delivery
2026-06-08 23:30  f5bd2b0  feat(agents,daemon,skills): review & QA skills wired to lifecycle stages
2026-06-09 01:32  afe0418  feat(daemon): tee structured logs to a daily JSON file for time/runId queries
2026-06-08 23:37  2382fae  feat(daemon): structured logging (Pino) with runId-scoped agent-run tracing
2026-06-08 21:40  1c28c65  chore: fix gitignore anchor for e2e .env-paths.json
2026-06-08 17:41  d799d5a  fix(web,daemon): Task View artifact UX + forward reviewer feedback at all gates
2026-06-08 17:43  1eb7646  chore: add test:e2e and test:all root scripts
2026-06-08 15:18  e34c699  fix(e2e): walkthrough drives gates via auto-advance, not removed routes
2026-06-07 03:15  3ebd38c  feat(proof): pnpm proof — end-to-end run-artifact bundle with a PASS/FAIL verdict
2026-06-07 02:53  5bfb86d  test(daemon): consolidate Tier-3 lifecycle smoke; delete redundant manual scripts
2026-06-07 02:43  59bb339  feat(delivery): real GitDeliveryAdapter — commit, push, open a PR
2026-06-07 02:26  a44fb44  feat(validation): real CommandValidationRunner wired into the lifecycle
2026-06-05 12:23  1058b9d  docs: add UI refactor plan (Tailwind + shadcn/ui)
2026-06-08 18:00  1a7a814  chore: gitignore Playwright MCP session dumps
2026-06-08 18:00  5822351  docs: update TODO with migration note, token-saving utils, workflow spec
2026-06-07 02:54  832df01  Update TODO.md - delete completed items
2026-06-07 02:44  206bb27  feat(web): redesign sidebar with Linear-style craft
2026-06-07 02:26  45c1fc7  feat(web,daemon): Task View QoL + Projects description
2026-06-07 02:16  835f04b  feat(web): link Project Name to project-filtered Task Board
2026-06-07 01:15  ba76651  Merge branch 'main' into plan/ui-redesign-v2
2026-06-07 00:48  e6b6003  feat(agents): interactive question gate, streaming runs, and live run UI
2026-06-07 00:35  a55a346  fix(web,daemon): close 3 dg-review correctness bugs
2026-06-06 21:01  8abd3b2  test(web): Playwright e2e walkthrough (video+trace) + fix tall-dialog overflow
2026-06-06 16:25  35d6c7e  feat(web): phase 5 — 3-region resizable Task Detail rewrite
2026-06-06 16:22  b2b36dd  feat(web): phase 4 — Token Usage recent-runs table (skeleton)
2026-06-06 16:21  8360a49  feat(web): phase 3 — Board project filter + shared CreateTaskDialog
2026-06-06 16:19  6a08d17  feat(web): phase 2 — config-only Projects registry + create modal
2026-06-06 16:06  0c7687a  feat(daemon): AgentRun persistence + background executor + SSE stream
2026-06-06 16:04  4f2d0ed  feat(web): phase 1 — zoned sidebar shell + contextual top bar
2026-06-06 15:13  a01b470  feat(agents): add streaming stage-agent adapter (stream-json NDJSON)
2026-06-06 02:02  baa91aa  Merge branch 'worktree-tailwind-shadcn-frontend': Tailwind v4 + shadcn/ui frontend
2026-06-06 02:00  4d76528  fix(web): refresh task detail before re-enabling actions
2026-06-06 01:55  c966823  create TODO.md
2026-06-06 01:35  5f015ca  feat(web): rewrite frontend with Tailwind v4 + shadcn/ui
2026-06-06 01:15  f0b39a1  fix: attribute agent-run logs to the stage the agent ran
2026-06-06 00:28  0875f31  Merge branch 'worktree-kysely-migrations': Kysely migrations + typed store
2026-06-06 00:23  dc411a2  Merge main into kysely-migrations; reconcile with Workspace→Worktree rename
2026-06-06 00:18  23348cf  build: gitignore .claude worktrees and local settings
2026-06-06 00:13  8e74af4  refactor: rename "Workspace" concept to "Worktree" throughout
2026-06-06 00:06  98c4f42  refactor(store): port all queries to Kysely, drop bespoke SQL + mappers
2026-06-06 00:00  8137363  feat(store): add Kysely + versioned sync migrations
2026-06-04 16:42  5e10e96  feat: real Claude adapter via the `claude` CLI (no API key)
2026-06-04 11:51  74c6a72  feat: Agent Runtime Adapter skeleton + mock adapter
2026-06-03 14:41  06bda8c  build: add fix-sqlite-binding script and wire into npm lifecycle hooks
2026-06-02 14:32  672d4d5  feat: Workspace Manager — real local git worktrees per task
2026-06-02 13:57  52fe7a9  feat: increment 1 — local-first Agent Workbench control plane + dashboard
2026-06-02 00:08  a14cb01  archive all preexisting
2026-05-27 18:15  6e08fd7  Merge branch 'agent/generalize-stage-context-md-followups' into master (agent-workbench run 2026-05-27-generalize-stage-context-md-followups, accepted_by=timothy.shee)
2026-05-27 18:14  4d2d543  docs(TODO): §7 subagent cost — rewrite post-investigation; Path B requirements
2026-05-27 18:13  1b2b058  runs: 2026-05-27-generalize-stage-context-md-followups (complete)
2026-05-27 18:11  c278a7f  docs(TODO): drop §6 (canonicalize repo_name — landed) and renumber
2026-05-27 18:08  aa4c7ab  Merge branch 'agent/canonicalize-repo-name-by-git-toplevel' into master (agent-workbench run 2026-05-27-canonicalize-repo-name-by-git-toplevel, accepted_by=timothy.shee)
2026-05-27 18:04  33c1c87  Merge branch 'agent/schema-level-validation-for-metadata-yaml' into master (agent-workbench run 2026-05-27-schema-level-validation-for-metadata-yaml, accepted_by=timothy.shee)
2026-05-27 18:03  4aea04c  runs: post-merge artifacts for reconcile-master-metadata-after-cmd-complete
2026-05-27 17:57  70deccc  runs: 2026-05-27-canonicalize-repo-name-by-git-toplevel (complete)
2026-05-27 17:54  bc33efa  TODO §13: fix handoff-rendering failure cluster (Candidates A + E + C + half-B)
2026-05-27 17:49  57aee95  metadata: schema-level validation on load (TODO §7)
2026-05-27 17:25  cdfefcc  fix(cmd_validate): write followups-context.md on default-mode validate too
2026-05-27 17:25  640a3b4  Merge branch 'agent/reconcile-master-metadata-after-cmd-complete' into master (agent-workbench run 2026-05-27-reconcile-master-metadata-after-cmd-complete, accepted_by=timothy.shee)
2026-05-27 17:19  0ba15c2  Update TODO.md
2026-05-27 17:06  53771ad  runs: 2026-05-27-reconcile-master-metadata-after-cmd-complete (complete)
2026-05-27 15:36  33d4002  context-md generators: ship shape/plan/followups (TODO §5 close)
2026-05-27 15:22  9c8aa7d  canonicalize repo_name by git toplevel (TODO §6)
2026-05-27 15:00  a2cf32e  draft: new CLI + slash command so clarifying questions actually fire
2026-05-27 14:58  8b2bbbc  TODO §1 (Y scope): read-layer carve-out + one-shot reconciliation
2026-05-27 13:53  bc1febd  rm plan.md (session planning artifact)
2026-05-27 13:52  0ba5683  slash-commands: auto-chain /plan -> /start (collapse the `ready` agent gate)
2026-05-27 13:40  5afa0fb  stop-banner: drop duplicate bare path; keep only clickable file:// URL
2026-05-27 11:50  807eb63  docs(TODO): add §12 — cross-run dependencies (`depends_on` + upstream artifact reads for coordinated multi-run work)
2026-05-27 11:44  1bc3f78  docs(TODO): add §2 — create worktree at /new-run for non-self-modifying runs too (collapse draft/worktree asymmetry); renumber prior §2–§10 to §3–§11
2026-05-27 11:09  a9e83a8  docs(TODO): add §1 — reconcile master-side metadata.yaml after cmd_complete (kill stale-human_review ghosts); renumber prior §1–§9 to §2–§10
2026-05-27 02:05  5f86f65  cmd_complete: auto-remove worktree + branch after successful merge
2026-05-27 01:38  3c2b87e  board: 390× snapshot perf + diff-update cards (TODO §5)
2026-05-27 00:53  6ff9f7a  docs(TODO): add §1 — /build slash command (close building-stage curated-entry enforcement gap); demote prior §1 (*-context.md cross-stage contract) to §13 with build-context.md marked shipped
2026-05-27 00:50  6bb2cee  Merge branch 'agent/generalize-stage-context-md' into master (agent-workbench run 2026-05-25-generalize-stage-context-md, accepted_by=timothysheee)
2026-05-27 00:50  8a0ad54  runs: 2026-05-25-generalize-stage-context-md (complete)
2026-05-27 00:50  381552d  Merge master into agent/generalize-stage-context-md
2026-05-27 00:40  d4c246a  runs: 2026-05-25-generalize-stage-context-md (complete)
2026-05-27 00:40  ee4bcba  runs: 2026-05-25-generalize-stage-context-md (in_review)
2026-05-27 00:39  901cae4  feat(build-context): generalize the *-context.md cross-stage contract to the building stage
2026-05-27 00:39  bf5f320  docs/TODO: drop §6 (board freshness) — shipped in 2026-05-26-board-freshness-across-worktrees
2026-05-27 00:37  dcb6a8a  Merge branch 'agent/board-freshness-across-worktrees' into master (agent-workbench run 2026-05-26-board-freshness-across-worktrees, accepted_by=timothy.shee)
2026-05-27 00:36  fea9e16  docs(TODO): add §12 — investigate handoff-rendering failure cluster
2026-05-27 00:33  df3e58b  board-freshness: TTL on _WORKTREE_CACHE + multi-root watchdog + periodic re-scan (TODO §6)
2026-05-26 23:57  71c98c4  stop-banner: print HUMAN_REVIEW.md as a clickable file:// URL
2026-05-26 22:21  305e1c7  docs(TODO): rewrite §8 — restrictive policy for publishing stage only
2026-05-26 22:16  698c348  docs(TODO): rewrite §7 — GitHub PR delivery with minimal lifecycle fork
2026-05-26 19:07  d2c6086  docs(TODO): add §11 — canonicalize repo_name to git toplevel so same repo gets one worktree parent dir
2026-05-26 19:07  dd3e3eb  docs(TODO): retire §2 (lifecycle papercuts) and §3 (base_ref_sha plumbing) — both shipped 2026-05-26
2026-05-26 18:15  816481c  Merge branch 'agent/lifecycle-papercuts-lock-ready-banner' into master (agent-workbench run 2026-05-25-lifecycle-papercuts-lock-ready-banner, accepted_by=timothysheee)
2026-05-26 00:55  d1d24b1  Merge branch 'agent/base-ref-sha-plumbing-across-remaining-con' into master (agent-workbench run 2026-05-25-base-ref-sha-plumbing-across-remaining-con, accepted_by=timothy.shee)
2026-05-26 00:55  d0a89e2  runs: 2026-05-25-base-ref-sha-plumbing-across-remaining-con (complete)
2026-05-26 00:55  d38d116  base_ref_sha: thread SHA through remaining consumers + audit event + backfill (TODO §3)
2026-05-26 00:39  e4c5f45  stop-banner: persist rendered banner to producing stage's dir
2026-05-26 00:29  586cdef  runs: 2026-05-25-lifecycle-papercuts-lock-ready-banner (complete)
2026-05-26 00:19  053dcf8  human_review(Files): render rows as [filename](abs path) instead of bare backticked absolute paths
2026-05-26 00:05  83f4533  fix(workbench): close TODO §2 lifecycle papercuts — gitignore runs/<id>/.lock and switch ready banner to slash-form
2026-05-25 23:55  3aac748  docs(slash-commands): auto-chain /new-run → /shape → /plan; keep /start and /complete|bounce|abandon as the only human gates
2026-05-25 23:50  e96052e  docs(TODO): add §9 board snapshot perf — O(N²) metadata.run_dir, repeated YAML parses, uncached git subprocesses, with cProfile evidence + confirmation steps
2026-05-25 23:08  d3a86f6  docs(architecture): add Classification section mapping picks vs alternatives across the 5-axis multi-agent taxonomy (arXiv:2604.18071); README pointer
2026-05-25 23:06  f756e34  docs(TODO): fold adversarial reviewer subagent into §7 PR-flow as pre-PR step; tighten §1 acceptance
2026-05-25 20:01  ed9226f  docs(TODO): add §1–§4 for lifecycle papercuts, base_ref_sha plumbing, metadata schema validation, and test gaps; renumber board freshness § → §5
2026-05-25 19:28  05210ac  runs: 2026-05-25-shengji-browser-game (complete)
2026-05-25 19:18  63b1cb5  docs(TODO): close §1 (per-worktree run dir shipped); renumber §2 → §1
2026-05-25 18:09  67a31fa  docs(TODO): add §2 — board freshness across worktrees after TODO §1
2026-05-25 13:31  a3913df  Merge branch 'agent/each-worktree-owns-its-own-run-dir' into master (agent-workbench run 2026-05-25-each-worktree-owns-its-own-run-dir, accepted_by=timothysheee)
2026-05-25 13:31  6680cb7  runs: 2026-05-25-each-worktree-owns-its-own-run-dir (complete)
2026-05-25 13:30  37b8426  runs: 2026-05-25-each-worktree-owns-its-own-run-dir (complete)
2026-05-25 13:30  5c4ba68  fix(runs): is_self_modifying now handles the worktree case via git common dir
2026-05-25 13:29  713ebc7  runs: 2026-05-25-each-worktree-owns-its-own-run-dir (complete)
2026-05-25 13:26  4625523  runs: 2026-05-25-structured-human-review-handoff (complete; backfilled merge ref)
2026-05-25 13:25  36ff2ef  Merge branch 'agent/structured-human-review-handoff' into master (agent-workbench run 2026-05-25-structured-human-review-handoff, accepted_by=timothysheee)
2026-05-25 13:25  a8f6f1c  runs: 2026-05-25-structured-human-review-handoff (artifacts through followups)
2026-05-25 05:01  a1adcf2  feat(workbench): worktree owns its run dir (TODO §1)
2026-05-25 04:41  d2f8e54  feat(stop-banner): structured human_review handoff body
2026-05-25 03:40  cc0712e  runs: 2026-05-24-fix-generated-lines-base-ref-head (complete; backfilled merge ref; +TODO §1)
2026-05-25 01:23  d71dd9f  Merge branch 'agent/fix-generated-lines-base-ref-head' into master (agent-workbench run 2026-05-24-fix-generated-lines-base-ref-head, accepted_by=timothysheee)
2026-05-24 23:31  e072a75  runs: 2026-05-24-token-efficiency-pass-2 (complete; backfilled merge ref; +1 follow-up)
2026-05-24 23:29  fcacba5  Merge branch 'agent/token-efficiency-pass-2' into master (agent-workbench run 2026-05-24-token-efficiency-pass-2, accepted_by=timothysheee)
2026-05-24 23:22  f1cfb64  runs: 2026-05-24-token-efficiency-pass-2 (artifacts through followups)
2026-05-24 23:17  d956112  runs: 2026-05-24-fix-generated-lines-base-ref-head (artifacts through followups)
2026-05-24 22:23  80a73a8  feat(metrics): pass-2 — bucket cache_read/cache_creation; fix correlator; validate-context.md + blast-radius
2026-05-24 22:14  55af6b4  docs(TODO/LOG): close TODO §2 + backfill dogfood run's completion_ref
2026-05-24 22:10  3a92351  Merge branch 'agent/cli-stop-banner-on-agent-stopping-transitions' into master
2026-05-24 22:06  ba8a7ad  runs: 2026-05-24-cli-stop-banner-on-agent-stopping-transitions (through followups)
2026-05-24 22:01  53e62b0  docs(TODO): add §4 — structured human_review handoff output
2026-05-24 21:32  7c36fbe  banner: stop banner on agent-stopping CLI transitions (TODO §2)
2026-05-24 21:31  5f79b50  metrics(lines): resolve base_ref to SHA at /start; lazy fallback for old runs
2026-05-24 21:15  6d21c40  docs(TODO): add §2 — CLI stop banner on agent-stopping transitions
2026-05-24 19:34  09104ee  docs(TODO/LOG): close TODO §1 + backfill dogfood run's completion_ref
2026-05-24 19:31  112d6e2  Merge branch 'agent/auto-merge-on-complete' into master
2026-05-24 19:31  e43678d  runs: 2026-05-24-auto-merge-on-complete (complete; legacy local-branch ref)
2026-05-24 19:30  07b1b4a  runs: 2026-05-24-auto-merge-on-complete (artifacts through followups)
2026-05-24 19:24  bfb2abc  feat(complete): auto-merge worktree branch on human_review -> done
2026-05-24 19:02  3406926  docs: dedupe CLAUDE.md against AGENTS.md
2026-05-24 18:59  a864f82  feat(workbench): allow worktrees_dir to be absolute or ~-prefixed
2026-05-24 18:38  ba303a8  import: agentic-development-task-system-v3__ai from 202605_agent_workbench_v2@f52f7dd (agentic-development-task-system-v2__ai)
2026-05-24 18:38  7fe965f  import: agentic-development-task-system-v2__ai from 202605_agent_workbench@9691b1f (agent-workbench__ai)
2026-05-24 18:38  e7b8819  remove: stale agentic-development-task-system-v2__ai dir (prep for V2/V3 import)
2026-05-24 18:37  7b36721  rename: agentic-development-task-system__ai → ...-v1__ai
2026-05-24 18:30  f52f7dd  docs(AGENTS): tighten two-file contract section
2026-05-24 18:27  1708f35  docs: reconcile lifecycle.md with code; pick Option A for §1
2026-05-24 18:21  eb82110  docs: reconcile TODO/LOG after §1 orphan-merge cleanup
2026-05-24 18:15  36ff7de  merge: agent/token-efficiency-tracking into 202605_agent_workbench_v2 (TODO §1)
2026-05-24 18:15  5f5710b  merge: agent/audit-unit-tests-for-duplication into 202605_agent_workbench_v2 (TODO §1)
2026-05-24 18:10  3785d15  merge: agent/context-graph into 202605_agent_workbench_v2 (TODO §1)
2026-05-24 17:24  5a801d6  docs(TODO): add §1 merge unmerged worktree branches; §2 lifecycle merge gap
2026-05-22 23:07  c5b4604  docs+chore: renumber TODO after Human Review polish merge; check in run dir
2026-05-22 23:05  083488a  merge: Human Review polish (TODO §2) into 202605_agent_workbench_v2
2026-05-22 23:05  a813ae6  wip: snapshot in-flight dogfood runs + token efficiency pass-2 scaffolding
2026-05-22 23:03  24e1e19  Create README.md
2026-05-22 22:48  6030dd0  feat(agent-workbench-v2): pass 3 — Files list flattening + Testing rename/split
2026-05-22 22:08  b4681e2  fix(metrics): bounce — clarify pre-acceptance metrics, explain cache_read, fix bucket formatting
2026-05-22 22:05  4421f6a  feat(agent-workbench-v2): pass 2 — reviewer-facing HUMAN_REVIEW polish
2026-05-22 20:07  caf410f  fix(metrics): search both worktree and repo project slugs for transcripts
2026-05-22 20:00  3e9d868  feat(agent-workbench): per-run token efficiency tracking (TODO §3)
2026-05-22 19:55  bd789ef  docs: backfill commit SHA for Human Review polish
2026-05-22 19:54  db66f6e  feat(agent-workbench-v2): Human Review polish (TODO §2)
2026-05-22 19:33  6a43875  fix: TODO.md - delete completed work
2026-05-22 19:26  f6cb88e  chore(agent-workbench-v2): mark 2026-05-22-context-graph done
2026-05-22 19:25  0780d8e  trim(agent-workbench-v2): drop meta/repo-discovery + meta/risk-and-approval
2026-05-22 19:17  7e33aeb  fix: AGENTS.MD - no plans in root directory
2026-05-22 19:17  0301f46  Delete plan.md
2026-05-22 19:16  8774143  fix: TODO.md - remove not useful tasks
2026-05-22 16:46  d7855a6  revert(agent-workbench-v2): drop per-command Context: imports
2026-05-22 06:09  cd9d440  docs(agent-workbench-v2): fill commit SHA into TODO §3 + LOG entry for c542c5d
2026-05-22 06:09  c542c5d  test(agent-workbench-v2): audit unit tests for duplication (TODO §3)
2026-05-22 05:49  5d902e5  docs(agent-workbench-v2): fill commit SHA in TODO/LOG for context graph
2026-05-22 05:49  f1b90f2  feat(agent-workbench-v2): context graph library (TODO §1)
2026-05-22 05:19  8264b3b  test(agent-workbench-v2): automatic E2E testing (TODO §1)
2026-05-22 05:18  1e969ce  docs(agent-workbench-v2): refresh TODO §1 Context Graph with composable context library plan
2026-05-22 04:55  0d6decc  feat(agent-workbench-v2): live board UX polish (TODO §1)
2026-05-22 04:15  013cdec  docs(agent-workbench-v2): reconcile TODO + LOG for §1-§2; add repo-root AGENTS.md
2026-05-22 04:05  ba0224e  test(agent-workbench-v2): regression test for human_review followups breakdown
2026-05-22 04:01  e4c2cae  dogfood(agent-workbench-v2): §2 card-attributes run + human_review breakdown fix
2026-05-22 03:55  340926a  feat(agent-workbench-v2): live board card attributes (TODO §2)
2026-05-22 03:34  8f1d115  docs(agent-workbench-v2): TODO §2 + §3 — card attributes + UX polish
2026-05-22 03:12  552b1df  dogfood(agent-workbench-v2): Shogi rules-core run to exercise the live board
2026-05-22 03:06  b5f1331  docs(agent-workbench-v2): drop TODO §2 summary — already covered by HUMAN_REVIEW.md + audit.md
2026-05-22 02:49  c58ce4d  feat(agent-workbench-v2): live task board TUI (TODO §1)
2026-05-21 05:31  62fb382  docs(agent-workbench-v2): TODO §1 — live task board (Textual TUI on top of runs/)
2026-05-21 05:30  cbebae7  feat(agent-workbench-v2): task board (TODO §1, MVP)
2026-05-21 03:53  9f3bc94  feat(agent-workbench-v2): numbered stage dirs + dogfood follow-ups
2026-05-21 03:20  8f06908  chore: gitignore session-local tmp/ scratch
2026-05-21 03:17  365643a  chore(agent-workbench-v2): record first dogfood run; queue numbered stage dirs
2026-05-21 03:15  beb627e  Merge: date-prefix worktree directory names (TODO §1)
2026-05-21 02:51  b5f3da5  feat(agent-workbench-v2): date-prefix worktree directory names (TODO §1)
2026-05-21 02:42  4b3ff84  docs(agent-workbench-v2): polish /new-run slash command contract
2026-05-20 19:12  20a5d11  feat(agent-workbench-v2): renovate task workflow, pass 4 (TODO §1g)
2026-05-20 18:07  9719bab  feat(agent-workbench-v2): renovate task workflow, pass 3 (TODO §1f)
2026-05-20 16:15  13da0ff  feat(agent-workbench-v2): renovate task workflow, pass 2 (TODO §1d + §1e)
2026-05-20 16:08  230423b  feat(agent-workbench-v2): renovate task workflow, pass 1 (TODO §1a/§1b/§1c)
2026-05-18 15:09  1a27321  docs(agent-workbench-v2): close out V1 in LOG.md, reset TODO.md for next round
2026-05-18 15:05  a5521d7  feat(agent-workbench-v2): /bounce gathers structured feedback as change-request.md
2026-05-18 12:29  f358baf  docs+chore: merge QUICKSTART into README, add gitignore, persist first run
2026-05-18 02:38  f93be16  feat(agent-workbench-v2): implement V1 — CLI, libs, slash commands, tests
2026-05-18 01:50  0f63feb  docs(agent-workbench-v2): initial architecture, lifecycle, schemas, TODO
2026-04-23 16:36  97e942d  Create agentic-development-task-system__ai
```
