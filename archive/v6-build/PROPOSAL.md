# Agent Workbench v6: proposal
Status: draft for review. Date: 2026-10-28.

v5 is the old workbench. It is frozen in `archive/agentic-development-task-system-v5__ai/`. Its features, and the v6 decision for each one, are in that folder's `FEATURES.md`. Why v5 was archived is in `archive/README.md`. The proof spike is in the appendix of this file.

## 1. Idea

Type `awb` in any repo and ask for a feature. You get a normal Claude Code chat. The agent splits the work into a stack of tasks. A normal task is a stack of one. Each task writes claims, builds the code, proves each claim with a Playwright video, and opens a draft PR only if the proof gate passes. Later, the chat reads the task history and manages it for you.

There are no stages and no human gates. One rule in code decides if work is done: the proof gate. The agent's own message is never proof.

v6 has three use cases. All three use one data model.

| Use case | What you do | What happens |
| --- | --- | --- |
| 1. Normal task | In `awb`, ask for a feature. | The chat makes a stack of one task on the current branch. It builds, proves and ships the feature in the same chat. |
| 2. Big feature | In `awb`, ask for a feature too large for one session. | The chat makes a stack of many tasks and starts the run. The daemon runs each task in a fresh session. Each task proves itself and opens its own draft PR. The PRs stack. |
| 3. Manage tasks | In `awb`, ask: "What failed this week? Retry the leaderboard task. Drop the old stack." | The chat reads the task history, explains it, and runs the changes. You do not type `awb` commands yourself. |

### 1.1 Requirements

These are the things v6 must do. Sections 3 and 4 give the design for each.

**All use cases**

- `awb` starts in any git repo and behaves like `claude`. All Claude Code features work.
- You describe the work in plain words. There is no form, no task file and no stage name.
- The first use in a repo sets itself up. The agent finds the lint, typecheck, test and start commands and saves them in `.awb/`. It asks you only when it cannot find them.
- Several sessions can run at the same time, in different repos or on different branches.
- You can see every session live in the web UI: repo, branch, task, last tool call, cost.

**Normal task**

- The agent writes the claims before the code. A claim is one sentence that a browser test can prove false. You can edit the claims.
- The agent works on its own branch and runs the repo lint, typecheck and unit tests before it asks for proof.
- Each claim has a Playwright test with a video and a trace. One more video shows the full feature from start to end. A repo with no browser UI uses an API test, and the PR says "API proof".
- The proof tests and the evidence never enter the target repo.
- The gate is code. If it fails, the agent fixes the code and runs the gate again. You do not step in.
- The PR is always a draft, and it opens only when the gate passes. A claim with no proof is listed under "Not proven", never as passed.

**Big feature**

- The chat decides if the work needs a stack of many tasks. No rule in code forces it.
- Tasks run one at a time, in stack order. Each task is a fresh session that starts from the branch of the task below it.
- A task starts only when the task below it opened its PR. If a task fails, the stack stops there.
- The last task proves the whole feature from start to end.
- The run lives in the daemon, so it continues when you close the chat.

**Manage tasks**

- The chat can list stacks and tasks across all repos, by repo, status and age.
- The chat can audit one task: its claims, each attempt with its gate result, the reason for a failure, the cost, and the PR state.
- The chat can retry a failed task. A retry is a fresh session with the claims and the last gate result, not the old chat history.
- The chat can change or remove tasks that have not started.
- Only code sets a task status. The PR state (merged, closed) comes from GitHub.

**Operation**

- One small daemon. No Temporal and no worker.
- A crash loses no chat work. `awb --resume` restores the chat.
- `awb` is prod and `awb-dev` is dev. They share nothing, so the workbench can build and prove changes to itself.
- `awb` is native and trusted. It is not a sandbox.

**Not in v6**

- A phase machine or stage names.
- A human approval gate. The gate is code.
- A task DAG, or parallel tasks inside one stack.
- An MCP tool server for the workbench.
- Merging a PR. You do that on GitHub.
- A sandbox.

## 2. Usage

The text that `awb` and the agent print is an example. The commands and the order are the design. In every case, the agent runs the `awb` commands. You only type in the chat.

### 2.1 One-time setup

```
npm i -g awb            # or: add the awb binary to PATH
awb doctor              # checks claude, Chromium, daemon
```

If `awb doctor` finds a problem, it prints the command that fixes it. Example: `npx playwright install chromium`.

### 2.2 Use case 1: normal task

| Step | You do | The system does |
| --- | --- | --- |
| 1 | `cd ~/games && awb` | Starts the daemon if it is not up. Starts `claude` with the playbook and the hooks. You see the normal Claude Code screen. |
| 2 | Type: `Add a scoreboard to Tic-Tac-Toe. It counts X wins, O wins and draws.` | The agent reads the repo. On the first use, it finds the lint, test and start commands and saves them in `.awb/run.md`. |
| 3 | Nothing. | The agent creates the branch `awb/tictactoe-scoreboard`. It runs `awb stack set` with one task: the title and claims C1 to C6. The daemon binds the task to the branch. |
| 4 | Nothing. (Optional: open `awb ui` to edit the claims.) | The agent writes the code. It runs lint, typecheck and unit tests, and fixes any failure. |
| 5 | Nothing. | The agent starts the app with the command in `.awb/run.md`, so that it can see the real page. |
| 6 | Nothing. | A fresh test session reads only the claims and the running app. It writes one Playwright test for each claim, and one full-flow test. |
| 7 | Nothing. | The agent runs `awb prove`. The daemon starts a clean app at the commit, runs the tests and runs the gate. The command prints the claim table. |
| 8 | Nothing. | If a claim fails, the agent fixes the code and runs `awb prove` again. This repeats until all claims pass, or the agent stops and reports the failed claims. |
| 9 | Nothing. | The agent runs `awb ship`. The gate runs again. Videos upload. A draft PR opens. The task becomes `done`. |
| 10 | Read the PR. Merge it on GitHub if it is good. | Nothing. The workbench never merges and never undrafts. PR sync marks the task `merged` later. |

What you see at the end:

```
$ awb ship
Gate: 6/6 claims PASS at 3f9c2a1 (clean)
Uploaded 7 videos to release awb-proof-51
Draft PR: https://github.com/<owner>/games/pull/51
```

The PR body for this example:

| Section | Example content |
| --- | --- |
| Summary | "Adds a session scoreboard to Tic-Tac-Toe." |
| Features | C1 to C6, each with PASS, a video link and a trace link. One extra row: the full-flow video. |
| How it was run | `npm run dev`, commit `3f9c2a1`, `npx playwright test`. |
| Not proven | "None." |
| Test code | The seven spec files, collapsed. The diff has only the feature code. |

If a claim still fails after the retries, `awb ship` refuses to open a PR. The chat prints the claim table and the reason for each failure. The branch stays on disk. You can reply in the chat to give a hint. The agent then fixes the code and runs `awb prove` again.

### 2.3 Use case 2: big feature

For a request such as "Add accounts and a leaderboard", the chat decides that one session is not enough. It runs `awb stack set` with four tasks:

1. Accounts: sign up and log in.
2. Save each game result to the account.
3. Leaderboard page.
4. Full flow: sign up, play, see the score on the leaderboard.

You can edit the stack in `awb ui`, or ask the chat to change it. Then the chat runs `awb run`, and you can close the chat. For each task, the runner:

1. Makes a worktree on a new branch from the branch of the task below.
2. Starts `claude -p` with the playbook, the task claims, and the titles of the tasks below.
3. Waits for the session to end. The session follows the steps of use case 1, from step 4 to step 9.
4. Checks the task. If it is `done`, the runner starts the next task. If not, it marks the task `failed` and stops the stack.

You get four stacked draft PRs. If task 2 fails, tasks 3 and 4 do not start. You watch the run in the Live view.

### 2.4 Use case 3: manage tasks

| You type | The agent runs | You get |
| --- | --- | --- |
| "What failed this week?" | `awb tasks --status failed --since 7d --json`, then `awb show` on each failed task. | A short list. Each failed task has the claims that failed, the reason, and the cost. |
| "Why did the leaderboard task fail?" | `awb show <task>` | The gate table of each attempt, and the path to the transcript. |
| "Retry it." | `awb retry <task>` | A new attempt in a fresh session. The stack continues if it passes. |
| "Drop the old accounts stack." | `awb task rm <ids>` on the waiting tasks. | The removed ids. Started tasks stay in the history. |
| "Which PRs are still open?" | `awb tasks --status done --json` | The tasks whose PR is still open. Merged PRs show as `merged`. |

You can type any `awb` command yourself. The design does not need you to.

## 3. Architecture

### 3.1 Layers

```
Layer 1  daemon    owns all state and every hard rule
                   SQLite, the gate, the runner, the shipper, PR sync
                        ^  HTTP
Layer 2  clients   awb CLI   (you and the agent)
                   web UI   (you)
                   hooks    (a passive event feed)
                        ^  Bash
Layer 3  agent     Claude Code and the playbook. It runs the awb CLI.
```

The hard rules live in layer 1. It does not matter who calls. The daemon refuses a PR without a passing gate, from you, the agent or the UI.

The agent uses the CLI, not MCP tools:

- You and the agent use one interface. There is one thing to build and test.
- The CLI works in the chat, in headless `claude -p`, and in any other runtime. In v5, tools tied to one runtime caused bugs.
- Every command prints JSON with `--json`, so the agent gets structured results.

### 3.2 Data flow

```
 YOU
  |                                   |
  | type in terminal                  | browser
  v                                   v
+--------------------------+    +-------------+
| awb  (chat)              |    | web UI      |
|  claude + playbook       |    | Live        |
|  agent runs awb CLI -----+-+  | Session     |
|  hooks ------------------+ |  | Stacks      |
+--------------------------+ |  | PR proof    |
                             |  +------+------+
 awb CLI (you or the agent)  |         |
  stack set, task rm, run,   |         |
  retry, prove, ship,        |         |
  tasks, show                |         |
            |                |         |
            v  HTTP          v events  v HTTP and live updates
+---------------------------------------------------------+
| daemon (one for each AWB_HOME)                          |
|                                                         |
|  API ----> store (SQLite)                               |
|             stacks, tasks, attempts, sessions,          |
|             events, gate results, PRs                   |
|                                                         |
|  runner -> starts `claude -p` for each task in a        |
|            worktree, then checks the task at the end    |
|  proof --> starts the app, starts the test writer if    |
|            there are no tests, runs the tests           |
|  gate ---> reads the proof files, writes the result     |
|  shipper > runs the gate, pushes, uploads the videos,   |
|            opens the draft PR                           |
|  PR sync > reads the PR state from GitHub               |
+---------+-------------+------------+--------------------+
          |             | starts     |
          |             v            |
          |   test writer            |
          |    claude -p, cwd = the  |
          |    task folder, Playwright agents,
          |    playwright-test MCP. It uses the app
          |    through the URL. It cannot see the repo.
          |             |            |
          v             v writes     v
  $AWB_HOME/tasks/<id>/       GitHub
   claims.md                   branches
   proof-tests/                draft PRs
   proof/ (videos, traces,     prerelease video assets
           report, hashes)
```

### 3.3 Commands

| Command | Use | Returns |
| --- | --- | --- |
| `awb` | Open the chat in the current repo. | The Claude Code screen. |
| `awb stack set` | Create a stack, or replace the waiting tasks of a stack. It takes JSON on stdin (section 3.5). | The changes and the new stack version. |
| `awb task rm <id...>` | Remove one or many waiting tasks. | The removed ids. |
| `awb run [stack]` | Start the runner on a stack. | A run id, at once. The run continues if the chat closes. |
| `awb retry <task>` | Start a new attempt on a failed task. | The new attempt id. |
| `awb prove` | Run the gate for the task on the current branch. | The claim table. Each failed claim has the reason and the video and trace paths. |
| `awb ship` | Run the gate again. If it passes, open the draft PR. | The PR URL, or the refusal and the claim table. |
| `awb tasks` | List stacks and tasks across all repos. Filters: `--repo`, `--status`, `--since`. | One line for each task. |
| `awb show <task>` | Audit one task. | The claims, every attempt with its gate table, the failure reason, the cost, the transcript path and the PR state. |
| `awb ui` | Open the web UI. | The browser page. |
| `awb doctor` | Check the setup: `claude`, Chromium, daemon. | What to fix. |

A task has one branch. `awb prove` and `awb ship` find the task from the current branch, so the agent never passes a task id to them.

### 3.4 Data model and status

```
Stack     one for each request. A normal task is a stack of one.
  Task      title, claims, position, status, branch, PR
    Attempt   one for each try: the first run and each retry
      Session   the claude session id, cost, tokens
        Event     from hooks: prompts, tool calls, stop
      Gate result   the claim table at a commit
```

Code sets every status. The agent has no command to set one.

| Status | Set by | When |
| --- | --- | --- |
| `waiting` | `awb stack set` | The task is created. |
| `doing` | The runner, or the chat for a stack of one | A session starts the task. |
| `done` | The shipper | `awb ship` opens the PR. |
| `failed` | The runner | The session ends without a PR. The last gate result gives the reason. |
| `merged`, `closed` | PR sync | GitHub reports the PR state. |

### 3.5 Replace a stack

The agent changes a stack with `awb stack set`. It sends the full stack that it wants. The daemon compares it with the current stack and makes the changes in one transaction. An agent writes a whole list well, and it keeps track of ids and positions badly.

- **Waiting tasks only.** The new stack can add, change, move or remove waiting tasks. If it changes or removes a task that has started, the daemon refuses the whole command.
- **The result shows the changes.** The command returns the tasks that it added, removed, changed and moved. The agent sees a task that it removed by mistake.
- **Version check.** Each stack has a version number. The command sends the version that the agent read. If you edited the stack in the UI after that, the daemon refuses the command, and the agent must read the stack again.

`awb task rm` stays for the simple case: remove these tasks, by id.

### 3.6 The stack

One session has a limit. Its context fills up and its quality drops. The stack lets v6 build a feature larger than one session can hold. It cuts the feature into tasks that each fit in one fresh session.

- **Who makes it.** The chat decides. The playbook gives advice on when to split. A normal task is a stack of one.
- **A task.** It has a `title` and `claims`. Nothing more. The position in the stack is the order.
- **Order.** Tasks run one at a time, from the bottom of the stack up.
- **Branches.** Each task branches from the branch of the task below it, so the PRs stack. The first task branches from the default branch.
- **Context.** Each task gets the playbook, its own claims, and the titles of the tasks below it. It reads their code from its branch. It does not get their chat history.
- **Failure.** If a session ends without a PR, the runner marks the task `failed` and the stack stops. When a retry opens its PR, the stack continues.

A stack is simpler than a DAG and avoids two v5 problems: the host load from many tasks at once, and conflicts between parallel tasks that edit the same files. The cost is speed. A stack of ten tasks takes ten times as long as one task.

### 3.7 How `awb` starts `claude`

1. Find the repo root and the current branch.
2. Start the daemon if it is not up. One daemon runs for each `AWB_HOME` (section 5).
3. Register a session with the daemon.
4. Start `claude` with extra options:
   - `--append-system-prompt` with the playbook text.
   - `--settings` with the hooks and the permission rules (section 3.10).
   - `AWB_HOME` in the environment, so that the `awb` commands that the agent runs reach the same daemon.
5. Pass through every other argument. Example: `awb --resume` works like `claude --resume`.
6. On exit, tell the daemon that the session ended.

The runner starts each stack task the same way, with `claude -p` in place of the chat.

Rules for the target repo:

- `awb` never replaces `claude` settings. It adds to them.
- `awb` does not write to the `.mcp.json` of the repo.
- `awb` adds only two files to the repo: `.awb/playbook.md` and `.awb/run.md`. It adds no proof tests, no evidence, no Playwright install and no Playwright agent files.

### 3.8 Playbook and start recipe

**The playbook** is one markdown file: `.awb/playbook.md`. A default file ships with `awb`. A repo can override it. `awb` passes it as the appended system prompt. To change how the agent works, edit the file. No code change. It holds:

- The steps of use case 1, written as instructions. They are advice. The agent can reorder them.
- When to split work into a stack of many tasks.
- The `awb` commands and when to use each one.
- The folder rules for proof tests (spike finding 7).
- The rule "do not change the test to match the app" (spike finding 3).

**The start recipe** is `.awb/run.md`. The spike showed that an agent cannot guess how to start a large app. The recipe holds the start command, the URL, the login steps and the stop command.

- On the first use in a repo, the agent finds the recipe and saves it. It asks you only if it cannot find one. This closes the v5 gap where an inferred start command was not saved.
- The agent uses the recipe from Bash to look at the app while it writes tests. `awb prove` uses it to start a clean app for the proof run.
- If the app cannot start, `awb prove` says so. The PR does not claim video proof.

| Repo | Start | Note |
| --- | --- | --- |
| Browser games | One Vite command. | Proven in the spike. |
| fender | Needs the `app` stack and a seeded login. | Use the `klaviyo-local-seed` recipes. Do not start Docker or Tilt without your consent. |
| `app` | `make up` through Tilt. | Run it in the background. The repo rules forbid foreground runs. |
| k-repo | One service with `pants run` or `docker compose`. | API proof only. |

### 3.9 Observability

Claude Code hooks send each event to the daemon over a local HTTP call: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse` and `Stop`. Each event carries the session id, the repo, the branch, and the task id if one is set.

| View | Content |
| --- | --- |
| Live | Every open session: repo, branch, current task, last tool call, idle or busy. |
| Session | The event feed. Token and cost totals. Files changed. |
| Stacks | Each stack in order. Each task shows its status, its attempts and its PR. You can edit waiting tasks. |
| PR proof | The claim table. A video player for each claim. Links to traces. |

I did not test if a hook sees token counts. If it does not, the daemon reads the usage from the session transcript file. Phase 0 checks this.

### 3.10 What the agent can bypass

The agent has a shell, and the SQLite file is a normal file in `$AWB_HOME`. An MCP tool server would not change this, because the agent would still have Bash. Three facts limit the damage:

- **`awb ship` does not trust stored results.** It runs the gate again from the files on disk: `report.json`, the video and trace files, the commit and the test hash. A fake row in the database does not open a PR.
- **Deny rules block the direct paths.** The `awb` settings deny `gh pr create` and deny writes to `$AWB_HOME` from the agent's file tools.
- **A determined agent can still cheat.** It can forge the proof files from Bash. This is the "not a sandbox" risk. v6 states it and does not solve it.

### 3.11 Technology choices

| Part | Choice |
| --- | --- |
| Language | TypeScript. One Node process for the daemon. |
| Store | SQLite in `$AWB_HOME`. Tables: stacks, tasks, attempts, sessions, events, gate results, PRs. |
| Agent interface | The `awb` CLI with `--json`. No MCP tool server. |
| Proof | `@playwright/test`, shipped as a dependency of `awb`. Playwright Test Agents write the tests. |
| UI | React and Vite. Four views. Reuse the v5 shadcn kit and tokens. |
| Workflow engine | None. v5 used Temporal. The runner is a loop in the daemon. |
| Sandbox | None. `awb` is native and trusted, the same as v5. |
| Location | The repo root. v5 is in `archive/`. |

A daemon crash loses no chat work, because the chat is a normal Claude Code session, and `awb --resume` restores it. A running stack stops when the daemon stops. On start, the daemon marks a task that was `doing` as `failed`, and the chat can retry it.

Size target: about 5,000 lines (CLI 600, daemon and store 900, runner and PR sync 400, hooks 300, gate and ship 500, UI 2,000, plus 300 lines of playbook text). Real code usually grows, so plan for 6,000 to 8,000. v5 has about 32,500 lines of non-test TypeScript. Tests: one focused test file for each part. The gate tests run against saved Playwright reports.

## 4. Proof

### 4.1 Claims

Each task has claims. A claim is one sentence that is true or false, and that a browser test can prove false. Example: "A draw adds 1 to Draws." The agent writes the claims before it writes the code. Claims should name the labels that a user sees, such as "X wins" or "Reset scores", so that a test can find them. You can edit claims in the UI.

### 4.2 Tests and videos

For each claim, a Playwright test has the claim id at the start of its title. The proof config turns on video and trace for every test. The spike proved this design on the games repo.

The proof tests and the evidence never go into the target repo. The PR has only the feature code. They live in the task folder:

```
$AWB_HOME/tasks/<task id>/
  claims.md
  proof-tests/        the Playwright spec files
  proof/              report.json, videos, traces, sha.txt, test-hash.txt
  playwright.config.ts
```

- `awb` ships `@playwright/test` as its own dependency. The proof config sits in the task folder. Its `testDir` is `proof-tests/` and its `baseURL` comes from the start recipe.
- The target repo needs no Playwright install, no config and no `.mcp.json` edit. The daemon passes the Playwright agents (`--agents`) and the `playwright-test` MCP server (`--mcp-config --strict-mcp-config`, with `--headless`) on the `claude` command line of the test writer. Phase 0 check 1 proved this (section 6.3).
- The spike committed `proof-tests/` and `playwright.proof.config.js` to the games repo (PR #50). v6 does not. If a repo wants lasting browser tests, the agent adds them to that repo's own e2e suite, as normal feature work.
- For a repo with no browser UI, the proof test is an API test. It records the request and the response as the trace. No video is possible. The PR says "API proof" for these claims.
- "Full videos" means one video for each claim, and one video for the full feature from start to end. The second one is a single test that walks the whole flow.

The test writer is a fresh session that did not write the code. It reads only the claims and the running app. Spike experiment 3 shows why: a session that knows the code tends to write tests that agree with the code. Open question 2 asks if a cheaper rule is enough.

The daemon starts the test writer with `claude -p`. Its working folder is the real path of the task folder, and it gets no `--add-dir`. This is necessary: the Playwright save tools write only inside the working folder of `claude` (section 6.3, fact 1). It also keeps the source out of view, which is stronger than a deny rule alone. The test writer reaches the app through the URL from the start recipe. It does not need the repo.

Verified facts about Playwright (details in the appendix):

- `npx playwright init-agents --loop=claude` writes the planner, generator and healer agents, a `.mcp.json` and a seed file.
- The agents use the `playwright-test` MCP server. It is not the same as `@playwright/mcp`.
- The JSON report gives a `video` and a `trace` path for each result.
- The healer may skip a test. The gate must reject skipped tests.

### 4.3 The gate

The gate is code, about 80 lines. It starts from the spike script in the appendix. `awb prove` first starts a clean app at the saved commit, from the start recipe. Then it runs the tests and checks the results. The gate passes only when all of these are true for every claim:

1. At least one test has the claim id.
2. Every test with the id passed. None is skipped or marked `fixme`.
3. A video and a trace file exist for every result.
4. The saved commit equals `HEAD`, and the source is clean.
5. No test file changed after the run started. At the start of the run, the gate saves a hash of every file in `proof-tests/` to `proof/test-hash.txt`. The tests are not in git, so the gate checks the hash, not `git diff`.
6. The test was not written by the session that wrote the code, or it passed on its first run. (Open question 2.)

The agent's own message is never proof. In the spike, the final message of a session was wrong twice. The gate and a real test run were right.

### 4.4 The PR

`awb ship` is the only way to open a PR. It does these steps:

1. Run the gate. Stop if it fails.
2. Run a secret scan on everything that it will upload.
3. Push the branch.
4. Upload every video to a prerelease asset (tag `awb-proof-<PR number>`). This is the v5 convention for large media.
5. Open a draft PR. Never undraft it.
6. Write the PR body with the sections below.
7. Set the task to `done`.

| Section | Content |
| --- | --- |
| Summary | What changed and why. |
| Features | One row for each claim: the sentence, PASS, a link to the video, a link to the trace. |
| How it was run | The start command, the commit, and the test command. |
| Not proven | Any claim with no video, and the reason. |
| Test code | The proof spec files, in a collapsed block. They are not in the diff. |

## 5. Prod and dev

`awb` is prod. `awb-dev` is dev. Both run the same code. They differ only in `AWB_HOME`.

| | Prod | Dev |
| --- | --- | --- |
| Command | `awb` | `awb-dev` |
| `AWB_HOME` | `~/.awb` (default) | `~/.awb-dev` |
| Code | A pinned, tested install on `PATH`. | The build in a worktree that you are changing. |
| Data | The real history: stacks, tasks, proofs, PRs. | Test data. You can delete it. |

Define the dev command as a shell alias:

```
alias awb-dev='AWB_HOME=~/.awb-dev node ~/GitHub/agent-workbench-wt/<change>/packages/cli/dist/awb.js'
```

Rules:

1. Each `AWB_HOME` has one daemon. The daemon picks a free port and writes it to `$AWB_HOME/daemon.json`. The CLI reads that file. No port is hard-coded.
2. `awb` passes `AWB_HOME` to its hooks and to the shell of the agent. A session always reports to the instance that started it.
3. The first line of `awb` output names the active `AWB_HOME`.
4. State lives in `$AWB_HOME`: the database, the proof tests and the evidence. Files that git should version live in the repo (`.awb/playbook.md`, `.awb/run.md`). The database is never inside a worktree. All worktrees of a repo share one database. Each row has `repo`, `worktree` and `branch` columns.

To fix the workbench with the workbench, prod builds the change in a worktree. The start recipe for the workbench repo starts a dev instance with a throwaway `AWB_HOME=$(mktemp -d)`. The Playwright tests drive that instance. The proof lands in the prod database.

v5 had no such isolation. Fixed ports and a port-only health check broke any second stack.

## 6. Build order and acceptance test

### 6.1 Build order

| Phase | Output | Test that proves it |
| --- | --- | --- |
| 0 | Check hooks, token data, `--append-system-prompt`, and Playwright agent files passed on the command line, with `claude`. | A script prints events from one session. |
| 1 | `awb` launcher. Daemon with session registry. | `awb` opens in two repos. Both show in `awb ui`. |
| 2 | Hooks and live feed. | A tool call in the chat shows in the UI in under 2 seconds. |
| 3 | `awb stack set` for a stack of one, `awb prove` and the gate. | The spike cases: pass, planted bug, and independence. |
| 4 | `awb ship`, the PR body and PR sync. | A draft PR with a video link for every claim. Merging it on GitHub sets the task to `merged`. |
| 5 | Stacks of many, the runner, `awb run` and `awb retry`. | A stack of three tasks gives three stacked draft PRs in order. A planted bug in task 2 stops task 3. A retry after the fix continues the stack. |
| 6 | `awb tasks`, `awb show`, `awb task rm`, and stack replace with the version check. | In the chat, "what failed?" lists the planted failure from phase 5 with its reason. No `awb` command is typed by hand. |
| 7 | UI polish and the PR proof page. | You review a PR from the UI only. |

Each phase ends with a demo. Stop after any phase if the result is not good. Run the second spike on fender before phase 3.

### 6.2 Acceptance test for the whole version

1. In a clean clone of the games repo, type `awb`.
2. Ask: "Add a scoreboard to Tic-Tac-Toe."
3. Do nothing else.
4. Result: a draft PR with a feature list, a video for each claim, and one full-run video.
5. The UI showed the task and the live feed during the run.
6. A planted bug makes the PR fail to open.
7. Ask for a feature of three parts. Result: three stacked draft PRs, each with its own proof.
8. Ask: "What did you do today, and what failed?" Result: the chat lists every task, its status and its PR, from the daemon.

### 6.3 Phase 0 results

Run on 2026-10-28 with `claude` 2.1.312 and `@playwright/test` 1.61.1. The scripts are in `spikes/phase0/`. Each check ran in a scratch clone of the games repo, and `git status` was clean after each one.

| Check | Result | Evidence |
|---|---|---|
| 1. Playwright agents from the command line | **Pass**, after a design change | The generator wrote `proof-tests/c1.spec.ts` with `generator_write_test`. The test passed. `report.json` lists the video and the trace. The session used no file outside the task folder. 79 s, 0.41 USD. |
| 2. Token counts in hooks | **Pass**, from the transcript | No hook payload has token fields. Every payload has `transcript_path`. That file has `message.usage` on each assistant row: `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`. One message can have more than one row, so remove duplicate rows by `message.id` before you add the numbers. |
| 3. Headless session runs CLI commands to the end | **Pass** | The stub log shows `prove`, then `ship`, on the task branch. The session stopped by itself. 34 s, 0.10 USD. |

Facts that change the design:

1. **The test writer must start in the task folder, not in the repo.** The `playwright-test` MCP server takes its root from the first MCP root that `claude` reports, which is the working folder of `claude`. The `-c` config path does not change it. `generator_write_test` and `planner_save_plan` accept only a relative path inside that root and inside the config's `testDir`. If `claude` runs in the repo and `testDir` is in `$AWB_HOME`, no path can match both, and every save fails. Section 4.2 now has this rule.
2. **Use real paths.** On macOS, `/var` is a link to `/private/var`. `claude` reports the real path, and the server compares paths as text. The daemon must give the test writer the real path of the task folder (`realpath`), or every save fails again.
3. **Start the MCP server with `--headless`.** It opens a visible browser by default.
4. **Limit the test-writer session.** When the save failed, the agent tried 14 to 17 paths and ran for about 7 minutes. `claude` 2.1.312 has no `--max-turns`. Use `--max-budget-usd`, and the runner's own timeout.
5. **The agent files map to `--agents` JSON.** The front matter (`name`, `description`, `tools`, `model`) and the body (`prompt`) convert one to one. `--plugin-dir` is not needed.
6. **Send the prompt on stdin.** `--allowedTools` takes many values, so a prompt after it becomes a tool name, and `claude -p` waits for input.
7. **The user's global git hooks can stop a task.** In check 3, a global `core.hooksPath` hook failed in a repo without lefthook. The agent stopped and asked, which is correct. `awb doctor` should check that a test commit works in the repo.

### 6.4 Fender spike results (part)

Run on 2026-10-29 with `spikes/fender/run.sh`, against the `app` stack and the fender dev server. The stack stopped during the test-writer step, so the proof run did not happen. The user does not plan to start the stack again, so this result is final for v6.

| Step | Result | Time |
|---|---|---|
| `seed doctor` | Pass | 73 s |
| `seed scenario full` and `verify` (user, company, "Local Seed Dashboard") | Pass | 180 s |
| Login with `global-setup.ts`, `storageState` saved | Pass | 10 s |
| Test writer, cwd = task folder | C1 written and checked on the live app. C2 written, not checked: the server went down. C3 not started. 7 turns, 0.97 USD. | 32 min |
| Proof run | Not run: the server refused connections. | none |
| fender `git status` | Unchanged | |

Facts that change the design:

1. **The URL is `https://local-klaviyo.com:4000`, not `:8080`.** Port 8080 is the Django server. Its page loads the fender JS from `https://localhost:4000`, which Chromium blocks (`ERR_BLOCKED_BY_ORB`), so the page shows "Something went wrong". The recipe must name port 4000, and the proof config must set `ignoreHTTPSErrors` for the local certificate.
2. **The login belongs in the recipe.** A `globalSetup` file that fills the login form and saves `storageState` worked at the first try. `.awb/run.md` needs a login section, and `prove.ts` needs to write it into the task folder. This is not built yet.
3. **The test writer is slow on fender.** One claim took about 15 minutes, because each page load on the dev server is slow. The `--max-budget-usd` limit does not stop a slow session. The runner needs a wall-clock timeout for the test writer.
4. **The test writer reports honestly when the app goes down.** It stopped, wrote what it had checked and what it had not, and did not invent a pass.
5. **Use exact labels.** `getByLabel(/password/i)` matches the password field and the "Show password" button.

## 7. Risks and open questions

### 7.1 Risks

| Risk | Effect | Reduction |
| --- | --- | --- |
| A Claude Code update changes flags or hooks. | `awb` breaks. | Pin a tested version. `awb doctor` checks it. |
| The agent ignores the playbook. | No claims, no proof. | `awb ship` is the only way to open a PR. The gate blocks it. |
| The healer weakens a test. | False pass. | Gate rules 2 and 5. |
| Large apps do not start. | No video. | The start recipe. The PR states "Not proven". |
| The proof design is tested on one small app only. Fender, login and database state are untested. | The gate may pass on small apps and give weak tests on large ones. | Run a second spike on fender before phase 3. |
| Video files are large. | Slow upload. | Compress on upload. Keep short clips for each claim. |
| One task grows too large for its session. | Quality drops. | Use `/compact`. Split the work into a stack of many. |
| The agent runs `gh pr create` by hand. | A PR with no gate. | Deny `gh pr create` in `--settings`. A pre-push hook in the repo checks for the gate file. |
| The agent writes to the SQLite file or forges proof files from Bash. | A false status or a false proof. | `awb ship` runs the gate again from disk. Deny rules on `$AWB_HOME`. Section 3.10. |
| The agent replaces a stack and leaves out a task by mistake. | A waiting task is lost. | The command returns the removed tasks. The version check stops a replace over your UI edits. |
| `native-trusted` is not a sandbox. | Hostile code has full access. | Same as v5. State it in the README. |

### 7.2 Open questions

1. Answered in phase 0: the hook payload has no token counts. The transcript file that it names has them (section 6.3).
2. Gate rule 6: how strict? A strict rule needs a second session to write the tests, which costs more. A cheaper option: the same session writes the tests first, before the code, and the gate checks that they fail on the base commit. The spike did not test this.

Resolved in this draft: The command name is `awb`. `awb run` ships in the first version. Data lives in `$AWB_HOME`. The agent uses the `awb` CLI, not an MCP tool server.

---

# Appendix: proof spike

The spike tested the riskiest idea, that Playwright can prove a feature works, before any v6 code existed.

Date: 2026-10-22. Target: `browser-games__ai`, a Tic-Tac-Toe scoreboard. Draft PR: https://github.com/Borghese-Gladiator/browser-games__ai/pull/50

Tools: `@playwright/test` 1.61.1 in the target repo, Playwright Test Agents from `init-agents --loop=claude`, Claude Code 2.1.308 in headless mode (`claude -p`).

The full spike plan, with the setup steps and the decision rule, is in git history at commit `0f52576` (`docs/v6-spike-plan.md`).

## A.1 Facts found before the spike

1. **The healer can hide a bug.** The docs say that it may skip a test if it believes the feature is broken. A skipped test must never count as proof.
2. **The healer edits test code.** It can weaken an assertion until the test passes.
3. **Browsers are not installed by default.** Run `npx playwright install chromium` once. Without it, every test fails with "Executable doesn't exist".
4. **`init-agents` overwrites files.** It replaced `.mcp.json` in other people's repos. v6 passes the agent files on the command line instead.
5. **The seed file is empty.** It must start the app, or the config needs a `webServer` entry. The planner runs the seed first.
6. **The agents default to the Sonnet model** (`model: sonnet` in the agent files). Change it in the file to use another model.

## A.2 How the spike ran

- I built a new feature (a scoreboard) instead of reusing a past PR. It was cheaper and kept the test honest. The claims were written before the code.
- The repo has its own heavy Playwright config (a gateway plus four players). I added `playwright.proof.config.js` (Vite only) and pointed the MCP server at it with `-c` in `.mcp.json`.
- I ran the agents in separate headless sessions that started without the code context. The feature code came from a different session.

## A.3 Results

| Experiment | Result | Evidence |
| --- | --- | --- |
| 1. Happy path | **Pass** | 11 tests from 6 claims. I ran them: 11 passed. The gate passed 6 of 6 claims. Each claim has a video and a trace. The assertions check counters and status text, not only that a page loads. Session cost about 0.91 USD. |
| 2. Planted bug (X wins not counted) | **Pass** | 5 tests failed. The gate failed C1, C2, C4, C5, C6. The healer session changed no files. It named the buggy line and said that editing tests would hide the bug. Cost about 0.21 USD. |
| 3. Independence (a draw counts twice) | **Pass** | A fresh session wrote tests from scratch. It had a deny rule for reading `games/`, `packages/` and `portal/`. Only the C3 test failed. It asserts "Draws shows 1". The source was not edited. No test was skipped. Cost about 1.15 USD. |
| 4. Comparison with v5 `exercise` | **Not run** | It needs a live v5 run with real tokens. Run it only if you want the numbers. |

## A.4 Findings

1. **The proof design works on this case.** Playwright Test Agents plus a 60-line gate give claim-linked video and trace. The gate caught both planted bugs.
2. **The healer did not hide the bug in one run.** I limited it to `proof-tests/` and gave it no instruction to make tests pass at any cost. The docs say it may skip tests. A single sample does not show that this never happens. Keep the gate rule that rejects `skipped` and `fixme`.
3. **Prompt limits matter.** The prompts said "edit only these folders" and "do not change the test to match the app". Put both rules in the v6 playbook. I did not test what happens without them.
4. **Scope of the read ban was not audited.** I set deny rules for `Read(games/**)` and so on. I did not check the session log to prove that it never read the source by another tool.
5. **Extra tests under one claim id can fail the claim.** In experiment 2, a negative reload test was titled with `C1`. It made C1 fail even though the "starts at zero" test passed. This is the safe direction. Decide in v6 if it is wanted.
6. **The agent's final message is not proof.** In experiment 3, the final message talked about an old Vite server and did not list the tests. In experiment 1, the agent said that it did not re-run the tests. The gate and my own run of the tests were the proof.
7. **The plan file has stale paths.** The planner wrote test paths under `tests/`, but the config uses `proof-tests/`. The generator followed the prompt. The v6 playbook must state the folder.
8. **Setup cost is real.** Steps that were needed: install Chromium, add a config, edit `.mcp.json`, edit the seed file. The full repo `npm run lint` fails on an old nested worktree folder in the target repo.

## A.5 Limits

- One small feature, one repo, a simple UI, three runs.
- No test on a large app such as fender. No test of state that needs login or a database.
- No test of the rest of v6: the `awb` launcher, hooks, the stack, delivery.

## A.6 Decision

Go, with these changes. All four are in the proposal above.

1. Keep the gate as written. Add one check: reject a test file that changed after the run started (gate rule 5).
2. Put the folder rules and "do not change the test to match the app" into the playbook.
3. Run a second spike on fender before the gate phase, to check app complexity and start-up cost.
4. Run experiment 4 only if you want a cost and time comparison with v5.

## A.7 Spike claims (Tic-Tac-Toe scoreboard)

Page: `/games/tic-tac-toe/` (served by Vite). The scoreboard shows the result of each game in this browser tab. Scores are not saved after a page reload.

- C1: The page shows a scoreboard with three counters labeled "X wins", "O wins" and "Draws". All three show 0 when the page loads.
- C2: When X wins a game, the "X wins" counter shows 1. The other two counters still show 0.
- C3: When a game ends in a draw, the "Draws" counter shows 1.
- C4: After a game ends, the "Reset game" button clears the board and keeps the counters.
- C5: A "Reset scores" button sets all three counters to 0. It does not clear the board.
- C6: A finished game is counted once. Clicking a filled cell after the game ends does not change any counter.

## A.8 Gate script (`gate.mjs`)

The v6 gate starts from this script. v6 changes three things: the tests and claims move to the task folder, gate rule 5 adds the test hash, and the source paths come from the repo instead of the fixed `games`, `packages` and `portal` folders.

```js
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const [repo, claimsFile = "proof-tests/claims.md", reportFile = "proof/report.json"] = process.argv.slice(2);
if (!repo) {
  console.error("usage: node gate.mjs <repo> [claimsFile] [reportFile]");
  process.exit(2);
}

const claimIds = [...readFileSync(join(repo, claimsFile), "utf8").matchAll(/^- (C\d+):/gm)].map((m) => m[1]);
const report = JSON.parse(readFileSync(join(repo, reportFile), "utf8"));

const specs = [];
const walk = (suite) => {
  for (const spec of suite.specs ?? []) specs.push(spec);
  for (const child of suite.suites ?? []) walk(child);
};
report.suites.forEach(walk);

const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"]).toString().trim();
const shaFile = join(repo, "proof/sha.txt");
const savedSha = existsSync(shaFile) ? readFileSync(shaFile, "utf8").trim() : "";
const dirty = execFileSync("git", ["-C", repo, "status", "--porcelain", "--", "games", "packages", "portal"]).toString().trim();
const shaOk = savedSha === head && dirty === "";

const testDir = join(repo, "proof-tests");
const skipped = new Set();
for (const file of readdirSync(testDir).filter((f) => f.endsWith(".ts") || f.endsWith(".js"))) {
  const text = readFileSync(join(testDir, file), "utf8");
  for (const m of text.matchAll(/test\.(?:fixme|skip)\(\s*['"`](C\d+)/g)) skipped.add(m[1]);
}

const rows = claimIds.map((id) => {
  const mine = specs.filter((s) => new RegExp(`^${id}\\b`).test(s.title));
  const results = mine.flatMap((s) => s.tests.flatMap((t) => t.results.map((r) => ({ t, r }))));
  const reasons = [];
  if (mine.length === 0) reasons.push("no test");
  if (skipped.has(id) || results.some(({ t }) => t.status === "skipped")) reasons.push("skipped");
  if (results.some(({ r }) => r.status !== "passed")) reasons.push("not passed");
  const attached = (r, name) => r.attachments.some((a) => a.name === name && a.path && existsSync(a.path));
  if (results.some(({ r }) => !attached(r, "video") || !attached(r, "trace"))) reasons.push("no video or trace");
  if (!shaOk) reasons.push("sha mismatch or dirty source");
  return { id, tests: mine.length, status: reasons.length ? "FAIL" : "PASS", reasons: reasons.join(", ") };
});

console.table(rows);
console.log(`head ${head.slice(0, 10)}  saved ${savedSha.slice(0, 10)}  dirty source: ${dirty === "" ? "no" : "yes"}`);
process.exit(rows.every((r) => r.status === "PASS") ? 0 : 1);
```
