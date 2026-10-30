# Plan: v6 phase 0, then phases 1 and 2

Read `PROPOSAL.md` first. This plan builds its sections 6.1 phases 0, 1 and 2. Do not start phase 3. The fender spike must come first, and the user must start the app stack for it.

## Brief

Phase 0 tests three facts that the design depends on. If a fact is false, stop and report it. Do not build around it. Phases 1 and 2 build the `awb` launcher, the daemon, the hooks and the live feed. They do not depend on the proof design.

Known on 2026-10-28: `claude` 2.1.312 has the flags `--agents <json-or-file>`, `--mcp-config`, `--strict-mcp-config`, `--settings <file-or-json>`, `--append-system-prompt`, `--plugin-dir` and `--setting-sources`. Nobody has tested them for this use.

## Phase 0: three checks

Put each check in `spikes/phase0/` as one script. Each script prints PASS or FAIL and the evidence. Use a scratch copy of the games repo (`browser-games__ai`), never your own working copy. Run `git status` in it after each check. It must show no new or changed files.

### Check 1: Playwright agents from the command line

Question: can `claude` use the Playwright planner, generator and healer, and the `playwright-test` MCP server, with no files written into the target repo?

1. In a temp folder outside the repo, run `npx playwright init-agents --loop=claude`. This gives the three agent files and a `.mcp.json`.
2. Turn the agent files into one JSON object for `--agents`. If the agent files do not map to that format, try `--plugin-dir` with a plugin folder that holds them.
3. Write an MCP config file that starts `npx playwright run-test-mcp-server -c <task folder>/playwright.config.ts`.
4. Write a proof config in a task folder, outside the repo. Set `testDir: 'proof-tests'`, `video: 'on'`, `trace: 'on'`, the `json` reporter, and a `baseURL` for the Vite server.
5. Run headless with the task folder (real path) as the working folder, and no `--add-dir`: `claude -p --agents <file> --mcp-config <file> --strict-mcp-config`, with the prompt on stdin. The MCP server needs `--headless`. The prompt: "Use the playwright-test generator to write one test for claim C1 in claims.md. Save it in the task folder."
6. Run the test from the task folder with the `@playwright/test` copy that the task folder installed.

PASS: a spec file and a video exist in the task folder, `report.json` lists the video and trace, and `git status` in the games repo is clean.

FAIL: write down the exact error and which step failed. Section 4.2 of the proposal then needs a new design. Stop phase 0 and report to the user.

### Check 2: token counts in hooks

Question: does a hook payload hold token counts?

1. Write a hook script that appends its stdin to a JSONL file.
2. Pass it with `--settings` for `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop` and `SessionEnd`.
3. Run one short headless session that calls one tool.
4. Search the JSONL file for token or usage fields.
5. If there are none, find the session transcript path in the payload (`transcript_path`), and read the usage from that file.

PASS: tokens come from the hooks, or from the transcript file named in the hooks. Record which one, and the field names.

### Check 3: a headless session runs CLI commands to the end

Question: can a `claude -p` session run a whole task through Bash, including commands that it must call by name, and stop?

1. Write a stub `awb` script on `PATH` with three commands: `awb prove` and `awb ship` append their name and the branch to a log file, and `awb prove` prints a fake claim table.
2. Run `claude -p` in a scratch branch of the games repo. Pass `--append-system-prompt` with the steps: make one small change, run `awb prove`, run `awb ship`.
3. Use `--output-format stream-json` to save the full session.

PASS: the log shows `prove`, then `ship`, on the right branch. The session exits by itself. Record the cost and the time.

### End of phase 0

Add a short "Phase 0 results" section at the end of section 6 in `PROPOSAL.md`, with the result of each check. Commit the scripts and the proposal change. If any check fails, stop here and report to the user.

## Phase 1: launcher and daemon

### Changes

Make one TypeScript workspace at the repo root. Keep the number of packages small: `packages/cli` (the `awb` binary) and `packages/daemon`. Add a third package only when two packages need the same code.

- **`awb` launcher (proposal section 3.7):** finds the repo root and the branch. Starts the daemon if it is not up. Registers a session. Starts `claude` with `--append-system-prompt` (the playbook), `--settings` (the hooks) and `AWB_HOME` in the environment. Passes every other argument through. Reports the end of the session.
- **`AWB_HOME` (section 5):** the default is `~/.awb`. The daemon picks a free port and writes `$AWB_HOME/daemon.json`. The CLI reads it. No port is hard-coded. The first line of output names the active `AWB_HOME`.
- **Daemon:** one Node process. SQLite in `$AWB_HOME`. A health route that checks the process, not only the port. Tables for this phase: repos and sessions. Add the other tables in the phases that use them.
- **`awb ui`:** the daemon serves a page. For this phase it can be a plain session list. The React UI comes in phase 7.
- **`awb doctor`:** checks `claude`, Chromium and the daemon, and prints the fix for each problem.
- **Default playbook:** a short `.awb/playbook.md` that ships with `awb`. It only needs to exist in this phase.

### Tests

Unit tests (one focused file for each part):

- `daemon.json` read and write. A stale file, where the process no longer runs, makes the CLI start a new daemon.
- Two `AWB_HOME` folders give two daemons on two ports.
- Argument pass-through: `awb --resume` reaches `claude` as `--resume`.
- The session registry: register, end, list.

Manual test (a script, `spikes/phase1/check.sh` or a TypeScript script):

1. Start `awb` in two repos.
2. Both sessions show in `awb ui`.
3. Start `AWB_HOME=$(mktemp -d) awb` in a third terminal. It starts its own daemon. Its session does not show in the first UI.
4. Stop one daemon. Run `awb`. It starts a new daemon.

## Phase 2: hooks and live feed

### Changes

- **Hook sender:** a small script that reads the hook JSON from stdin and sends it to the daemon URL from `AWB_HOME`. It must exit fast and never block `claude`. If the daemon is down, it drops the event.
- **Events table:** session id, repo, worktree, branch, hook type, time, and the raw payload.
- **Tokens:** use the source that check 2 found.
- **Live feed:** the daemon pushes new events to the UI page (server-sent events are enough). The page shows each open session: repo, branch, last tool call, and idle or busy.

### Tests

Unit tests:

- The hook sender maps each hook type to an event row.
- The hook sender exits with code 0 when the daemon is down.
- Token totals for a session, from saved payloads.

Manual test:

1. Open `awb` and the UI side by side.
2. Ask the chat to run one Bash command.
3. The tool call shows in the UI in under 2 seconds.
4. Stop the daemon during a chat. The chat keeps working.

## Phase 3: stack of one, `awb prove` and the gate

### Brief

The chat can make a stack of one task, bind it to the current branch, and run `awb prove`. The daemon runs the test writer in the task folder (phase 0 fact 1), runs the proof tests, and runs the gate. The command prints the claim table. The fender spike runs when the `app` stack is up. Phase 3 is proven on the games repo, which needs no stack.

### Changes

- **Tables:** `stacks` (id, repo, version), `tasks` (id, stack, position, title, claims, status, branch, base), `attempts` (id, task, session, started, ended), `gate_results` (id, attempt, commit, pass, rows JSON).
- **`awb stack set`:** JSON on stdin: `{ "version"?, "tasks": [{ "id"?, "title", "claims": [{ "id", "text" }] }] }`. For a stack of one, the task binds to the current branch. A replace changes only `waiting` tasks, and checks the version. It returns the changes.
- **Task folder:** `$AWB_HOME/tasks/<id>/` (real path) with `claims.md`, `playwright.config.ts`, `proof-tests/`, `proof/`. The daemon writes `claims.md` and the config when the task is created.
- **Start recipe:** `.awb/run.md` in the repo, with a fenced `start` block, a `url` line and a `ready` path. `awb prove` starts the app from the recipe at the commit, and stops it after the run.
- **`awb prove`:** finds the task from the branch. Sets it to `doing`. Starts the app. If `proof-tests/` has no test for a claim, starts the test writer (`claude -p`, cwd = task folder, `--agents`, `--mcp-config` with `--headless`, `--max-budget-usd`). Saves `sha.txt` and `test-hash.txt`. Runs `@playwright/test`. Runs the gate. Saves the gate result. Prints the claim table, and exits 1 if the gate fails.
- **Gate:** a pure function from the claims, the report, the head commit, the source state and the test hashes to the claim table. Rules 1 to 5 of section 4.3. Rule 6: the test writer is always a fresh session in phase 3, so rule 6 holds by design.
- **`@playwright/test` and the Playwright agents:** a dependency of `@awb/daemon`, so the target repo needs no install.

### Tests

Unit tests:

- The gate: one row for each rule that can fail (no test, skipped, fixme, failed, no video, no trace, SHA mismatch, dirty source, test hash changed), and a pass.
- `awb stack set`: create, replace a waiting task, refuse a change to a started task, refuse a stale version.
- The start recipe parser.

Manual test (`spikes/phase3/check.sh`, games repo, real `claude`):

1. Pass: the Tic-Tac-Toe scoreboard claims C1 to C6 on the current games code. `awb prove` passes.
2. Planted bug: X wins not counted. `awb prove` fails C2 and the other claims that depend on it.
3. Independence: the test-writer session reads no file outside the task folder.

## Phase 4: `awb ship`, the PR body and PR sync

### Brief

When the gate passes, `awb ship` opens a draft PR with a video link for each claim. The daemon then sees when GitHub merges or closes the PR, and sets the task to `merged` or `closed`.

### Changes

- **Gate from disk:** `gateFromDisk(task, worktree)` reads `proof/report.json`, `proof/sha.txt` and `proof/test-hash.txt`, and gets `HEAD`, the source state and the test hash now. `awb prove` and `awb ship` both use it, so `awb ship` does not trust the database (section 3.10).
- **`awb ship`:** finds the task from the branch. Refuses if a proof run or a ship for the task is busy, or if the task is `done`. Then it does the steps of section 4.4:
  1. Run the gate from disk. Stop if it fails, and print the claim table.
  2. Scan the spec files and the PR body for secrets. Stop if it finds one.
  3. Push the branch.
  4. Open a draft PR (or use the open PR of the branch, so that a second try works).
  5. Upload the videos to the prerelease `awb-proof-<PR number>`.
  6. Write the PR body: Summary, Features, How it was run, Not proven, Test code.
  7. Save the PR number and URL, and set the task to `done`.
- **Traces stay local.** A trace holds the network data, which can include login cookies. The PR body names the task folder.
- **PR sync:** every 60 s the daemon asks `gh pr view` for the state of each `done` task, and sets `merged` or `closed`.
- **Deny rules:** the `awb` settings deny `gh pr create` and file writes to `$AWB_HOME`.
- **Playbook:** step 9 runs `awb ship`.

### Tests

Unit tests:

- The PR body: a row and a video link for each claim, the commit, the start command, and the spec files in a collapsed block.
- The secret scan: it finds a GitHub token, an AWS key and a private key, and passes normal test code.
- The gate from disk: a pass, and a fail when a spec file changed after the run.
- PR sync: `MERGED` sets `merged`, `CLOSED` sets `closed`, `OPEN` changes nothing.
- The settings have the deny rules.

Manual test (`spikes/phase4/check.sh`, games repo, real `claude` and GitHub):

1. Pass case of phase 3, then `awb ship`. A draft PR opens on `browser-games__ai` with a video link for each claim. Each link downloads a video.
2. Change a file after `awb prove`, then `awb ship`. It refuses and prints the claim table.
3. Close the PR on GitHub (a merge would change `main` of the games repo). After a sync, `awb show` shows `closed`. The `MERGED` case has a unit test.

## Phase 5: stacks of many, the runner, `awb run` and `awb retry`

### Brief

The chat can make a stack of many tasks. `awb run` starts the runner in the daemon and returns at once. The runner does the tasks one at a time, from the bottom up. Each task gets a worktree on its own branch, which starts from the branch of the task below. A fresh `claude -p` session does the task. If the task is not `done` when the session ends, the runner marks it `failed`, and the stack stops. `awb retry` starts a new session on the failed task, and the stack continues.

### Changes

- **`awb stack set` with many tasks:** each task gets the branch `awb/<title slug>-<id>`. Task 1 branches from the base of the stack. Each later task branches from the task below. A replace computes the bases again for the waiting tasks. A stack of one still binds to the current branch.
- **Runner (`runner.ts`):** a loop over the tasks of a stack. It skips `done`, `merged` and `closed` tasks. It runs the first `waiting` task. It stops at a `failed` or `doing` task. The loop gets the task session as a function, so a unit test can replace it.
- **Task session:** `git worktree add -b <branch> $AWB_HOME/worktrees/<task> <base>`, then `awb -p` in the worktree. This is the same launcher as the chat, so the session gets the playbook, the hooks, the deny rules and a session row. The prompt has the title, the claims and the titles of the tasks below. Limits: `--max-budget-usd` (`AWB_TASK_BUDGET_USD`, default 5) and a wall-clock timeout (`AWB_TASK_TIMEOUT_MIN`, default 45), from fender fact 3. The output goes to `<task folder>/session-<n>.jsonl`.
- **`awb run [stack]`:** starts the runner on the stack, or on the newest stack of the repo. It returns the run id at once. `GET /api/runs/<id>` gives the state: `running`, `done` or `stopped`.
- **`awb retry <task>`:** only for a `failed` task. It sets the task to `waiting` and starts the runner. The session uses the same worktree and branch, so it sees the earlier commits.
- **Playbook:** when to split a request into a stack, and how to use `awb run`.

Not in phase 5: a run that survives a daemon restart. If the daemon stops, the task stays `doing`.

### Tests

Unit tests:

- A stack of three: three branches, and the bases form a chain.
- A replace that moves a waiting task computes the bases again.
- The runner: all three tasks done. Task 2 not done: task 2 is `failed`, and task 3 does not start. A retry after that: tasks 2 and 3 run.
- The task prompt has the claims and the titles of the tasks below.

Manual test (`spikes/phase5/check.sh`, a clone of the games repo, real GitHub):

The task session is a stub `claude` (`AWB_CLAUDE`). It writes a fixed page for its task, commits, and runs `awb prove` and `awb ship`. The proof tests are put in each task folder before the run, so no test writer runs, and the check costs no tokens. Phase 0 check 3 and phase 3 already prove a real `claude -p` session with `awb` commands.

1. A stack of three: three stacked draft PRs in order. The base of PR 2 is the branch of PR 1, and the base of PR 3 is the branch of PR 2.
2. A planted bug in task 2: task 2 is `failed`, and task 3 does not start.
3. Remove the bug and run `awb retry`: task 2 and task 3 open their PRs.
4. Close the PRs and delete the branches and releases.

## Phase 6: `awb tasks`, `awb show`, `awb task rm`

### Brief

The chat can answer "what did you do today, and what failed?" from the daemon. The playbook tells the agent which `awb` command answers which question. The user types no `awb` command. Stack replace with the version check is already in phase 3.

### Changes

- **`awb tasks`:** lists the tasks of all repos, newest first. Filters: `--repo <path>`, `--status <status>` (more than one with commas), `--since <7d|12h|30m|ISO date>`. `--json` gives the rows. Each row has the id, status, title, repo, branch, PR URL, the failed claims of the last gate result, and the failure reason.
- **`awb show [task]`:** with no id, the task of the current branch, as before. With an id or an id prefix of 6 or more characters, that task. It now shows the failure reason, the cost and the transcript paths (`session-*.jsonl` and `proof/writer.jsonl` in the task folder), and the PR.
- **Failure reason:** the runner saves why a task failed (`tasks.fail_reason`), for example "the gate failed: C1 not passed" or "the session ended without a PR". A retry clears it.
- **`awb task rm <id...>`:** removes waiting tasks, in one transaction. If one id is not waiting or not found, nothing is removed. The stack version goes up, and the bases of the waiting tasks are computed again.
- **Playbook:** a section with the question and the command for each case in section 2.4 of the proposal.

### Tests

Unit tests:

- `tasks` filters: status, repo, since, and the failed claims of the last gate.
- The `--since` parser.
- `task rm`: removes waiting tasks and computes the bases again; refuses all when one task has started.
- The failure reason is saved by the runner, and a retry clears it.

Manual test (`spikes/phase6/check.sh`, local only, real `claude`):

1. Make a stack of two tasks in a scratch clone of the games repo. A stub task session plants a bug in task 1, so the gate fails task 1, and task 2 stays waiting. No GitHub.
2. Ask `awb -p "What did you do today, and what failed?"` with the real `claude`. No `awb` command is typed by hand.
3. The answer names the failed task, claim C1 and the reason. The transcript shows that the agent ran `awb tasks` or `awb show`.

## Phase 7: UI and the PR proof page

### Brief

You can review a PR from the UI only. The UI has the four views of section 3.9: Live, Session, Stacks and PR proof. The proposal names React and Vite. This repo has no build step, so the UI is one HTML page with plain JavaScript that the daemon serves. It reuses the v5 color tokens, in light and dark mode. If the page grows past about 600 lines, move it to Vite.

### Changes

- **`ui.ts`:** the page. Hash routes: `#/` Live, `#/session/<id>`, `#/stacks`, `#/task/<id>` (PR proof). The Live view keeps the SSE feed of phase 2.
- **Live:** every session with its state, repo, branch, task, last tool and tokens. A click opens the Session view.
- **Session:** the event feed (hook, tool, time) and the token totals.
- **Stacks:** each stack in order, with the status, attempts and PR of each task. A waiting task has an edit form for the title and the claims. Save sends the whole stack with its version, so the version check of section 3.5 applies.
- **PR proof:** the claim table of the last gate, a video player for each claim, a trace link with the `npx playwright show-trace` command, the failure reason, the attempts, the cost, the proof spec code and the diff of the branch.
- **New routes:** `GET /api/stacks` (all stacks with their tasks), `GET /api/tasks/<id>/diff` (the git diff of the branch against its base), `GET /files?path=` (a video or a trace).
- **Security:** `/files` serves only real files inside `$AWB_HOME/tasks/`, so a link cannot read any other file. The daemon listens on 127.0.0.1 only, as before.

### Tests

Unit tests:

- `/files` path check: a file in a task folder passes; `..`, a symlink out of the folder, and a path outside `AWB_HOME` fail.
- The diff route: the diff of a branch with one commit has the changed file.

Manual test (`spikes/phase7/check.sh`, games repo, local, no tokens). Frontend, so it is a list of browser actions, run by a Playwright script with a screenshot of each view:

1. Make data: a stack of three. A stub task passes the gate on task 1 (with videos), and the proof of task 2 fails. Task 3 stays waiting.
2. Open `awb ui`. The Live view shows the task sessions.
3. Click a session. The Session view shows its events.
4. Open Stacks. It shows task 1 and task 2 with their status. Only a waiting task has the edit form.
5. Open the proof page of task 1. Each claim row has PASS and a video that plays (`readyState` 4 and a duration). The trace link answers 200. The spec code and the diff show.
6. Open the proof page of the failed task. It shows FAIL, the reason and the video of the failure.
7. Edit a waiting task in Stacks, and save. The title changes, and the stack version goes up by 1.

## Rules for the next session

- Read `PROPOSAL.md` sections 3, 5 and 6 before you start.
- The v5 code is in `archive/agentic-development-task-system-v5__ai/code/`. You can copy small parts, such as the GitHub release upload. Do not copy its structure. v5 had 19 packages and Temporal.
- Work on a branch, not on `main`. Open a draft PR at the end of each phase. Do not push to `main`.
- If a phase 0 check fails, stop and report. Do not change the design yourself.
