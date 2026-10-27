# Agent Workbench v5: feature inventory

This document lists every feature of the current workbench (v5). It is the input for `docs/v6-proposal.md`.

Sources: `AGENTS.md`, `docs/*.md`, package READMEs, the CLI command files, the daemon routes, and the worker `AGENTS.md`. Date: 2026-10-21.

## Size of v5

| Measure | Value |
| --- | --- |
| TypeScript, non-test | about 32,500 lines |
| TypeScript, test | about 21,900 lines |
| Packages under `packages/` | 19 |
| Apps and workers | `apps/cli`, `apps/daemon`, `apps/web`, `workers/temporal-worker` |
| Hub file `run-phase.ts` | 2,172 lines |
| Decision records | 10 (`docs/decisions/`) |
| Repo skills | 6 (`.claude/skills/`) |
| Processes at run time | Temporal server, worker, daemon (optional: Vite UI) |

## Status key

- **Live**: proven on a real repo in an earlier session.
- **Built**: code and tests exist. I did not find live proof in my notes.
- **Open**: in `docs/TODO.md`, with a draft PR.
- **Dead**: code exists. No caller uses it.

## 1. Repository onboarding

| ID | Feature | Status |
| --- | --- | --- |
| R1 | Register a Git repo (`awb repo add`). List, show, sync, remove. | Live |
| R2 | Trust flag per repo (`awb repo trust`). It replaced the old approval gate. | Live |
| R3 | Git inspection through the real `git` CLI: remotes, default branch, status, log, changed paths. | Live |
| R4 | Command discovery for install, format, lint, typecheck, test, build and start. Sources are CI files, Makefile, package.json, Python config. It marks ambiguous commands. It does not pick one. | Live |
| R5 | Unit detection for single-package and monorepo layouts. A fix removed an O(n²) read on a 620-package repo. | Live |
| R6 | Fact extraction from `CLAUDE.md`, `AGENTS.md`, README and decision records. | Built |
| R7 | Snapshots of a repo at a commit, saved in SQLite. | Live |
| R8 | Start command in three tiers: saved command, worktree discovery, inference. The inference result is not saved (known gap). | Live |
| R9 | Symbol and import map with tree-sitter (`packages/repository-map`). | Dead (TASK-130 deletes it) |

## 2. Project memory

| ID | Feature | Status |
| --- | --- | --- |
| M1 | Fact store with source paths and hashes. | Built |
| M2 | Retrieval by path, unit, directory, full text (FTS5), confidence and recency. | Built |
| M3 | Invalidation of facts when changed paths overlap their sources. | Built |
| M4 | Promotion and eviction policy (ADR-010). Supersede, never delete. | Built |
| M5 | `awb memory compile`, `sync` and `lint`. | Built |
| M6 | Run scratchpad. | Built |
| M7 | Memory facts go into the planner and builder context. | Built |

## 3. Task intake and control

| ID | Feature | Status |
| --- | --- | --- |
| T1 | Create a task from a prompt, with a base branch (`awb task create`). | Live |
| T2 | Task list, show, wait, watch, result, timeline and logs. | Live |
| T3 | Cancel, retry, remove and prune. | Live |
| T4 | Task DAG: parent and child tasks, a scheduler, and stacked draft PRs. | Live |
| T5 | Size classifier: Haiku (authoritative) plus a local Ollama shadow (observe only). | Built |
| T6 | Persistent tasks in SQLite, with a task summary projection and a `retry_of` link. | Live |
| T7 | Reconcile: repair a task whose workflow state and DB state differ. | Live |

## 4. Lifecycle (nine phases)

The workflow code runs these phases in a fixed order: specify, plan, program-design, implement, verify, exercise, challenge, deliver, release.

| ID | Phase | What it does | Status |
| --- | --- | --- | --- |
| L1 | specify | Builds a task contract: an objective and falsifiable claims. | Live |
| L2 | plan | A planner session and a separate critic session loop, with a bound. Output is slices that map to claims. | Live |
| L3 | program-design | For large tasks: a file tree and signatures, without bodies. | Built |
| L4 | implement | A builder session for each slice. It commits a real diff. | Live |
| L5 | verify | Runs the repo commands. It saves output as evidence. | Live |
| L6 | exercise | QA. See section 5. | Live |
| L7 | challenge | Adversarial review by a fresh read-only session. It records findings. | Live |
| L8 | deliver | Push the branch, open a draft PR, post an evidence table. | Live |
| L9 | release | Watch the PR for feedback, merge and close. | Built |

## 5. QA (exercise phase)

| ID | Feature | Status |
| --- | --- | --- |
| Q1 | Browser executor: Chromium, scripted steps, video, Playwright trace, console and network error capture. | Live |
| Q2 | CLI executor: run the repo command, check exit code and output. | Live |
| Q3 | HTTP API executor: one fixed `GET /` check. | Built (weak) |
| Q4 | Library executor: a script that imports the library. Node only. | Built |
| Q5 | `cli-default` fallback: runs `echo qa-ok`. It always passes. | Built (weak) |
| Q6 | Executor choice by repo shape (`selectQaMode`). | Built (weak) |
| Q7 | Assertion strength levels (liveness, state change, value match). | Built |
| Q8 | `deriveQaStatus`: the one place that decides pass or fail. A video alone never passes. | Built |
| Q9 | Dev-server start and readiness probe. A missing server no longer dead-ends QA. | Live |
| Q10 | QA media upload to the PR: a prerelease asset and a link in a PR comment. | Live |
| Q11 | A real agent session for QA (`qa-executor` role). | Open (TASK-131) |

## 6. Control policy (deterministic)

| ID | Feature | Status |
| --- | --- | --- |
| C1 | `evaluatePhaseCompletion`: a pure function. Only it decides that a phase is done. | Live |
| C2 | Loop routing table: repair and replan route to a target phase. | Live |
| C3 | Failure fingerprint and no-progress detection. | Live |
| C4 | Budgets for tokens, time and attempts. | Built |
| C5 | Invalidation cascade: a change to the contract, plan, SHA or QA scenario makes later evidence stale. | Built |
| C6 | Evidence freshness: exact match on SHA, environment digest and versions. | Built |
| C7 | Slice diff cap guardrail. | Built |
| C8 | Policy predicates for risk (new dependency, auth change and others). They label unmet criteria. They do not stop the run. | Built |
| C9 | Autonomy: no human gate. A run always ends at a draft PR. Unmet claims go in the PR body. | Live |
| C10 | Stuck-phase detection and heartbeat liveness. | Live |

## 7. Agent runtimes

| ID | Feature | Status |
| --- | --- | --- |
| A1 | Adapter interface: create session, execute, interrupt, dispose. | Live |
| A2 | Claude adapter (Agent SDK). | Live |
| A3 | Codex adapter. | Live |
| A4 | Pi adapter (with Ollama). | Live |
| A5 | OpenCode adapter. | Built |
| A6 | Runtime profile: one record per runtime. It replaced string checks. | Live |
| A7 | Mock adapter. All deterministic tests use it. | Live |
| A8 | Capability broker: a tool allowlist for each of 8 roles. | Live |
| A9 | Model routing by phase. | Built |
| A10 | Session resume, watchdog and transport error handling. | Live |
| A11 | Skill text injected into the stage prompt. | Live |

## 8. Workspace and execution

| ID | Feature | Status |
| --- | --- | --- |
| W1 | One Git worktree and branch for each task. | Live |
| W2 | Port allocation. | Built |
| W3 | Dependency install in a fresh worktree. | Live |
| W4 | Command runner: allowlisted environment, timeout, kills the whole process tree. | Live |
| W5 | Environment digest. | Built |
| W6 | Execution profile: `native-trusted` only. It is not a sandbox. | Live |

## 9. Evidence and delivery

| ID | Feature | Status |
| --- | --- | --- |
| E1 | Content-addressed artifact store with retention and garbage collection. | Built |
| E2 | Evidence records tied to SHA, contract version and plan version. | Live |
| E3 | Waivers: human approved and scoped to one SHA. | Built |
| E4 | Pre-upload checks: hash, size, secret scan. | Built |
| E5 | Push and draft PR. Always a draft. | Live |
| E6 | Evidence matrix comment on the PR. | Live |
| E7 | PR feedback classification (six classes). | Built |
| E8 | Review findings lifecycle: resolve, invalidate, waive. | Live |
| E9 | Advisory maintainability review. | Built |

## 10. Observability

| ID | Feature | Status |
| --- | --- | --- |
| O1 | Semantic events saved in SQLite. A WebSocket stream and a catch-up route. | Live |
| O2 | Token and runtime breakdown. Twelve runtime attribution buckets. | Live |
| O3 | Measured context composition. | Built |
| O4 | OpenTelemetry traces, metrics and JSON logs. One trace for each run. Off unless an endpoint is set. | Live |
| O5 | Phase and session durations, with a read-back CLI. | Live |
| O6 | Execution tree and timeline routes. | Built |
| O7 | Decay metrics (diff size, finding density). | Built |
| O8 | Token cost scripts in `scripts/`. | Built |

## 11. Operations

| ID | Feature | Status |
| --- | --- | --- |
| P1 | `awb up`, `down`, `restart`, `status`, `logs`, `doctor`. | Live |
| P2 | Isolated stack (`awb up --isolated`) for runs beside other stacks. | Live |
| P3 | Recovery from a network partition. | Live |
| P4 | `awb fleet` and `awb fleet rollup`: one row for each task. | Live |
| P5 | `awb config`, `init`, `reset`, shell completion. | Built |
| P6 | Single SQLite writer rule (the daemon). | Live |

## 12. Web UI (`apps/web`)

Pages: Overview, Repositories, Repository detail, Tasks, Task board, Task detail (live status), Evidence viewer, Settings. It uses Tailwind and shadcn. The UI shows unmet criteria as a read-only banner. It has no approval queue.

| ID | Feature | Status |
| --- | --- | --- |
| U1 | The pages above. | Live |

## 13. Skills and docs

| ID | Feature | Status |
| --- | --- | --- |
| S1 | `run-workbench-task`: the one entry point to run work. | Live |
| S2 | `grill-me`: red-team a plan. | Live |
| S3 | `build-ui`: greenfield UI. | Live |
| S4 | `create-worktree`, `close-worktree`, `close-pr`. | Live |
| S5 | Docs audit script and 10 decision records. | Built |

## Known weak points

1. QA can pass through the `cli-default` fallback (Q5). TASK-131 addresses this.
2. `run-phase.ts` collects special cases. It grew from 806 to 2,172 lines.
3. Ten tasks at one time overload the machine. The safe limit is five.
4. Worktree environment faults cause false verification failures.
5. `native-trusted` gives no isolation from hostile code.
6. Dead code: `repository-map` (TASK-130).

## Open backlog

| Task | Subject | PR |
| --- | --- | --- |
| TASK-129 | Add `knip` for dead-code checks. | #50 |
| TASK-130 | Delete `packages/repository-map`. | #51 |
| TASK-131 | A real QA agent session. | #52 |
