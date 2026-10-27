# Agent Workbench v6: proposal

Status: draft for review. Date: 2026-10-27.

v5 is the old workbench. It is frozen in `archive/agentic-development-task-system-v5__ai/`. This document proposes v6, the rebuild. The list of v5 features is in `docs/v5-feature-inventory.md`. The proof spike is in `spike/RESULTS.md` and `docs/v6-spike-plan.md`.

All size and time numbers are my estimates. I did not measure them.

## 1. Goal

v6 is a wrapper around Claude Code. You type `ag` in any repo. You get a normal Claude Code chat. The wrapper adds three things: a task list with order, live observability in a web UI, and a draft PR that carries video proof of every feature.

There are no stages. There is one chat. One rule in code decides if work is done: the proof gate.

## 2. Requirements

### 2.1 Kept from v5

| ID | Requirement | v5 source | v6 form |
| --- | --- | --- | --- |
| K1 | Web UI | `apps/web` | Smaller UI with three pages: Tasks, Session, PR proof. |
| K2 | Task ordering | task DAG, queue | A task list with `depends_on`. The chat, or you, add tasks. `ag` runs them in order. |
| K3 | Observability of what runs now | three channels, traces | Live feed of sessions, tool calls, cost, and state. Fed by Claude Code hooks. |
| K4 | Draft PR as the end state | deliver phase | Same. A PR is always a draft. |
| K5 | History | SQLite, FTS5 | SQLite for tasks, sessions, events, proof. Search stays optional. |

### 2.2 New

| ID | Requirement |
| --- | --- |
| N1 | The `ag` command opens in any repo and behaves like `claude`. |
| N2 | Every PR has full videos and a feature list. |
| N3 | One chat. No stages. No phase names. |

## 3. What v5 got wrong

| Problem in v5 | Cause |
| --- | --- |
| Slow and rigid | Nine fixed phases. Each phase has its own completion rule, routing rule and cache rule. |
| Hard to change | A new step touches the workflow, the phase table, the completion function and the hub file. |
| Many parts | Temporal, a daemon, a worker, 19 packages, a web server. |
| Weak QA | Four fixed executors guess how to test. One of them always passes. |
| Large hub file | `run-phase.ts` has 2,172 lines of special cases. |
| High token cost | Each phase starts a new session and rebuilds context. A retry replays the full context. |

## 4. The `ag` command

### 4.1 What you do

1. Add `ag` to your `PATH`.
2. Open a terminal in any git repo.
3. Type `ag`.

You see the same screen as `claude`. All Claude Code features work, because `ag` starts the real `claude` program.

### 4.2 What `ag` does at start

1. Find the repo root and the current branch.
2. Start the workbench daemon if it is not up. One daemon runs for each machine.
3. Register a session with the daemon.
4. Start `claude` with extra options:
   - `--append-system-prompt` with the playbook text (section 6).
   - `--mcp-config` for the `ag` tool server (section 7).
   - `--settings` with hooks that send events to the daemon (section 8).
5. Pass through every other argument. Example: `ag --resume` works like `claude --resume`.
6. On exit, tell the daemon that the session ended.

### 4.3 Other commands

| Command | Action |
| --- | --- |
| `ag` | Open the chat in the current repo. |
| `ag ui` | Open the web UI in the browser. |
| `ag tasks` | Print the task list and the order. |
| `ag run` | Run the next ready task without a chat (headless, `claude -p`). |
| `ag proof` | Run the proof gate on the current branch and print the table. |
| `ag doctor` | Check the setup: `claude`, Chromium, daemon. |

### 4.4 Rules

- `ag` never replaces `claude` settings. It adds to them.
- `ag` works with no setup in a repo. First use creates a `.ag/` folder. It holds the playbook and the start recipe.
- `ag` does not write to `.mcp.json` of the repo. It passes its own config on the command line.

## 5. One chat, no stages

v5 had nine named phases. v6 has none. The chat has one flow in plain words:

1. You say what you want.
2. The agent asks the `ag` server for the task list. It adds tasks if the work is big.
3. For each task, the agent writes the claims, builds the feature, and checks it with the repo lint, typecheck and test commands.
4. The agent calls `ag_prove`. This runs the gate.
5. If the gate fails, the agent fixes the code and calls `ag_prove` again.
6. The agent calls `ag_ship`. This opens the draft PR.

These steps are advice. The agent can reorder them. Only two rules are hard, and code enforces both:

- `ag_ship` fails if the gate did not pass at the current commit.
- The gate rejects tests that were weakened, skipped, or changed after it saved the commit (section 9.3).

## 6. The playbook

The playbook is one markdown file: `.ag/playbook.md`. A default file ships with `ag`. A repo can override it.

It holds:

- The six steps in section 5, written as instructions.
- The folder rules for proof tests (spike finding 7).
- The rule "do not change the test to match the app" (spike finding 3).
- The start recipe (section 10).

`ag` reads the file at start and passes it as the appended system prompt. To change how the agent works, edit the file. No code change.

The v5 proposal had a playbook with step fields (`session`, `tools`, `check`, `on_fail`). v6 drops them. The chat is one session. A fresh session is used in one place only: the test writer for the independence rule (section 9.3).

## 7. The `ag` tool server

A small MCP server that `ag` starts. It gives the chat these tools:

| Tool | Action |
| --- | --- |
| `ag_tasks` | List tasks, their status, and which are ready. |
| `ag_task_add` | Add a task with `title`, `claims`, and `depends_on`. |
| `ag_task_update` | Set the status: `todo`, `doing`, `done`, `blocked`. |
| `ag_start_app` | Run the start recipe. Return the URL, or "cannot start" with the reason. |
| `ag_prove` | Run the proof tests and the gate. Return the claim table. |
| `ag_ship` | Check the gate, upload videos, and open the draft PR. |

The chat uses Playwright Test Agents and the Playwright MCP for the proof tests. The `ag` server does not replace them.

## 8. Observability

### 8.1 Source of events

Claude Code hooks send each event to the daemon over a local HTTP call. The hooks used:

- `SessionStart`, `SessionEnd`
- `UserPromptSubmit`
- `PreToolUse`, `PostToolUse`
- `Stop`

The hook also sends the session id, the repo, the branch, and the task id if one is set.

### 8.2 What the UI shows

| View | Content |
| --- | --- |
| Live | Every open session: repo, branch, current task, last tool call, idle or busy. |
| Session | The event feed. Token and cost totals. Files changed. |
| Tasks | The ordered list. The ready, doing, blocked, and done groups. |
| PR proof | The claim table. A video player for each claim. Links to traces. |

### 8.3 Limit to check in phase 0

I did not test if a hook sees token counts. If it does not, read the usage from the session transcript file. Test this first.

## 9. Proof and PR

### 9.1 Claims

Each task has claims. A claim is one sentence that is true or false. Example: "A draw adds 1 to Draws." The agent writes the claims before it writes the code. You can edit them in the UI.

### 9.2 Tests and videos

For each claim, a Playwright test has the claim id at the start of its title. The proof config turns on video and trace for every test. The spike proved this design on the games repo.

For a repo that has no browser UI, the proof test is an API test. It records the request and the response as the trace. No video is possible. The PR says "API proof" for these claims.

Verified facts about Playwright (details in `docs/v6-spike-plan.md`):

- `npx playwright init-agents --loop=claude` writes the planner, generator and healer agents, a `.mcp.json` and a seed file.
- The agents use the `playwright-test` MCP server. It is not the same as `@playwright/mcp`.
- The JSON report gives a `video` and a `trace` path for each result.
- The healer may skip a test. The gate must reject skipped tests.

### 9.3 The gate

The gate is code, about 80 lines. It passes only when all of these are true for every claim:

1. At least one test has the claim id.
2. Every test with the id passed. None is skipped or marked `fixme`.
3. A video and a trace file exist for every result.
4. The saved commit equals `HEAD`, and the source is clean.
5. No test file changed after the gate saved the commit.
6. The test was not written by the session that wrote the code, or it passed on its first run. (Open question 3.)

The agent's own message is never proof.

### 9.4 The PR

`ag_ship` does these steps:

1. Run the gate. Stop if it fails.
2. Push the branch.
3. Upload every video to a prerelease asset (tag `ag-proof-<PR number>`). This is the v5 convention for large media.
4. Open a draft PR. Never undraft it.
5. Write the PR body with the sections below.

| Section | Content |
| --- | --- |
| Summary | What changed and why. |
| Features | One row for each claim: the sentence, PASS, a link to the video, a link to the trace. |
| How it was run | The start command, the commit, and the test command. |
| Not proven | Any claim with no video, and the reason. |

"Full videos" means one video for each claim, and one video for the full run of the feature, start to end. The second one is a single test that walks the whole flow.

## 10. Start recipe

The spike showed that the agent cannot guess how to start a large app. The recipe fixes this.

- The file is `.ag/run.md`. It holds the start command, the URL, the login steps, and the stop command.
- On the first run in a repo, the agent finds the recipe and saves it. It asks you only if it cannot find one. This also closes the v5 gap where an inferred start command was not saved.
- If the app cannot start, `ag_start_app` says so. The gate then reports "no proof". The PR does not claim video proof.

Known cases:

| Repo | Start | Note |
| --- | --- | --- |
| Browser games | One Vite command. | Proven in the spike. |
| fender | Needs the `app` stack and a seeded login. | Use the `klaviyo-local-seed` recipes. Do not start Docker or Tilt without your consent. |
| `app` | `make up` through Tilt. | Run it in the background. The repo rules forbid foreground runs. |
| k-repo | One service with `pants run` or `docker compose`. | API proof only. |

## 11. Architecture

```
terminal: ag
   |
   +-- claude (the real program)
   |      +-- playbook (system prompt)
   |      +-- ag MCP server  --+
   |      +-- hooks -----------+--> daemon (one per machine)
   |                                  +-- SQLite
   |                                  +-- web UI (Vite build, served by daemon)
   +-- Playwright MCP / Test Agents
```

| Part | Choice |
| --- | --- |
| Language | TypeScript, one Node process for the daemon. |
| Store | SQLite. Tables: tasks, sessions, events, claims, proofs. |
| UI | React and Vite. Three pages. Reuse the v5 shadcn kit and tokens. |
| Workflow engine | None. v5 used Temporal. v6 removes it. |
| Sandbox | None. `ag` is native and trusted, the same as v5. It is not a sandbox. |
| Location | The repo root. v5 is in `archive/`. |

The daemon is back, but it is small. It exists only for the UI and the event feed. A crash loses no work, because the chat is a normal Claude Code session. `ag --resume` restores it.

## 12. Feature disposition

Status words: **Keep** (same behavior), **Simplify** (same goal, less code), **Replace** (an existing tool does it), **Drop** (not in v6).

| v5 IDs | v6 decision |
| --- | --- |
| R1, R2 | **Keep.** A `repos` table and a trust flag. |
| R3 | **Keep.** Use `git` CLI helpers. |
| R4, R8 | **Simplify.** The start recipe (section 10) and a saved `commands.json` in `.ag/`. |
| R5, R6, R7, R9 | **Drop.** The agent reads the repo. |
| M1 to M7 | **Simplify.** One file, `.ag/memory.md`, per repo. The agent reads it at start. No FTS5 until the file is too large. |
| T1, T2, T3 | **Keep.** The chat plus `ag tasks`. |
| T4 | **Keep.** `depends_on` in the task list (K2). |
| T5 | **Drop.** The agent judges the size. |
| T6, T7 | **Keep.** SQLite is the only store. |
| L1 to L3 | **Replace.** The agent writes claims in the chat. A plan is optional. |
| L4, L5 | **Keep.** Build and check, as advice in the playbook. |
| L6, Q1 to Q6, Q9 | **Replace.** `ag_prove` with Playwright Test Agents. API tests cover repos with no browser UI. |
| L7 | **Keep (optional).** An advice line in the playbook: review the diff in a fresh read-only session before `ag_ship`. |
| L8, E5, E6 | **Keep.** `ag_ship` and the PR body table. |
| L9, E7 | **Drop.** Read PR comments in the chat when you ask. |
| Q7, Q8, C1, C5, C6 | **Simplify.** The gate. |
| Q10 | **Keep.** Upload video as a prerelease asset. About 100 lines. |
| Q11 | **Replace.** The chat is the QA agent. |
| C2, C3, C4, C7, C10 | **Drop.** One chat has no loop routing. `/compact` and a budget flag in `claude` cover the rest. |
| C8 | **Drop.** The agent reports risk in the PR summary. |
| C9 | **Keep.** Draft PR is the only end state. |
| A1 to A2, A6 to A7 | **Drop.** `ag` uses `claude`. |
| A3 to A5 | **Defer.** Codex through a second wrapper only if needed. |
| A8 | **Simplify.** Claude Code permission rules in `--settings`. |
| A9 to A11 | **Drop.** Claude Code provides model choice, resume and skills. |
| W1, W3, W4 | **Keep.** The chat uses `git worktree` for parallel tasks. About 300 lines. |
| W2 | **Simplify.** The agent picks a free port. |
| W5, W6 | **Drop** the digest. **Keep** the `native-trusted` rule. |
| E1 to E3 | **Drop.** Plain files in `.ag/proof/`. The gate ties evidence to the commit. No waivers. |
| E4 | **Keep (small).** A secret scan before upload. |
| E8, E9 | **Drop.** |
| O1, O2, O5 | **Keep.** Events from hooks (section 8). |
| O3, O6 to O8 | **Drop.** |
| O4 | **Defer.** OpenTelemetry only if you use a collector. |
| P1 | **Simplify.** `ag doctor`. |
| P2, P3 | **Drop.** The problem does not exist without Temporal and a worker. |
| P4 | **Keep.** The Live view in the UI and `ag tasks`. |
| P5, P6 | **Simplify.** One config file. |
| U1 | **Keep, smaller.** Three pages (section 8.2). |
| S1 to S4 | **Simplify.** Rewrite `run-workbench-task` as the playbook. Keep the worktree skills. |
| S5 | **Simplify.** Keep a few decision records. |

## 13. Size budget

| Part | Lines (estimate) |
| --- | --- |
| `ag` CLI and launcher | 400 |
| Daemon, routes, SQLite | 900 |
| `ag` MCP server | 500 |
| Hooks receiver and event store | 300 |
| Gate and ship | 500 |
| Web UI | 2,000 |
| Playbook and recipes | 300 (text) |
| **Total** | **about 5,000** |

v5 has about 32,500 lines of non-test TypeScript. About 5,000 is far below half. Real code usually grows. Plan for 6,000 to 8,000.

Tests: one focused test file for each part. Run the gate against saved Playwright reports.

## 14. Build order

| Phase | Output | Test that proves it |
| --- | --- | --- |
| 0 | Check hooks, token data, and `--append-system-prompt` with `claude`. | A script prints events from one session. |
| 1 | `ag` launcher. Daemon with session registry. | `ag` opens in two repos. Both show in `ag ui`. |
| 2 | Hooks and live feed. | A tool call in the chat shows in the UI in under 2 seconds. |
| 3 | Task list, order, and `ag_*` task tools. | Three tasks with `depends_on` run in the right order. |
| 4 | `ag_prove` and the gate. | The spike cases: pass, planted bug, and independence. |
| 5 | `ag_ship` and the PR body. | A draft PR with a video link for every claim. |
| 6 | UI polish and the PR proof page. | You review a PR from the UI only. |

Each phase ends with a demo. Stop after any phase if the result is not good.

The proof spike is done. Phase 4 starts from `spike/gate.mjs`.

## 15. Acceptance test for the whole version

1. In a clean clone of the games repo, type `ag`.
2. Ask: "Add a scoreboard to Tic-Tac-Toe."
3. Do nothing else.
4. Result: a draft PR with a feature list, a video for each claim, and one full-run video.
5. The UI showed the task list and the live feed during the run.
6. A planted bug makes the PR fail to open.

## 16. Risks

| Risk | Effect | Reduction |
| --- | --- | --- |
| A Claude Code update changes flags or hooks. | `ag` breaks. | Pin a tested version. `ag doctor` checks it. |
| The agent ignores the playbook. | No claims, no proof. | `ag_ship` is the only way to open a PR. The gate blocks it. |
| The healer weakens a test. | False pass. | Gate rules 2 and 5. |
| Large apps do not start. | No video. | Section 10. The PR states "Not proven". |
| Video files are large. | Slow upload. | Compress on upload. Keep short clips for each claim. |
| One chat grows too long. | Quality drops. | Use `/compact`. Use one chat for each task when the list is long. |
| The agent can run `gh pr create` by hand. | A PR with no gate. | Deny `gh pr create` in `--settings`. A pre-push hook in the repo checks for the gate file. |
| `native-trusted` is not a sandbox. | Hostile code has full access. | Same as v5. State it in the README. |

## 17. Open questions

1. Does the hook payload contain token counts? (Phase 0.)
2. Should `ag run` (headless) ship in the first version, or only the chat?
3. Gate rule 6: how strict? A strict rule needs a second session to write the tests, which costs more.
4. Where does the daemon keep data: one folder in the home directory, or one for each repo?
5. Do you want the name `ag`? It clashes with The Silver Searcher, a common search program. If you have it installed, the new command hides it.
