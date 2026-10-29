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

## Rules for the next session

- Read `PROPOSAL.md` sections 3, 5 and 6 before you start.
- The v5 code is in `archive/agentic-development-task-system-v5__ai/code/`. You can copy small parts, such as the GitHub release upload. Do not copy its structure. v5 had 19 packages and Temporal.
- Work on a branch, not on `main`. Open a draft PR at the end of each phase. Do not push to `main`.
- Do not start phase 3. Phase 3 waits for the fender spike, and the user must start the `app` stack for it.
- If a phase 0 check fails, stop and report. Do not change the design yourself.
