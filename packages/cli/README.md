# awb

Needs Node 24 or later. There is no build step: Node runs the TypeScript files directly.

```sh
npm install                      # dev tools only (typescript, @types/node)
alias awb="$PWD/packages/cli/bin/awb"
awb doctor                       # checks claude, Chromium and the daemon
awb                              # opens claude in the current repo
awb ui                           # opens the session list in the browser
```

| Command | What it does |
|---|---|
| `awb [claude args]` | Starts the daemon if it is not up, registers a session, and starts `claude` with the playbook and `AWB_HOME`. Every argument goes to `claude`. |
| `awb ui [--no-open]` | Prints the UI URL and opens it. The UI has four views: Live (every session), Session (its events and tokens), Stacks (each task with its status and PR; you can edit a waiting task) and the proof page of a task (the claim table, a video for each claim, the trace, the proof tests and the diff). |
| `awb sessions [--json]` | Lists the sessions. |
| `awb doctor` | Checks the setup and prints a fix for each problem. |
| `awb daemon start\|stop\|status` | Controls the daemon of the active `AWB_HOME`. |
| `awb stack set [--json]` | Reads a stack as JSON on stdin and creates or replaces it. A stack of one binds to the current branch. In a stack of many, each task gets its own branch: task 1 starts from the current branch, and each later task starts from the task below. |
| `awb run [stack] [--json]` | Starts the runner on the stack (default: the newest stack of the repo) and returns at once. The runner makes a worktree in `AWB_HOME/worktrees/` for each task, runs the `## setup` block of `.awb/run.md` in it, and starts `awb -p` with the task prompt. If a task ends without a PR, the task is `failed` and the stack stops. |
| `awb retry <task> [--json]` | Sets a `failed` task back to `waiting` and starts the runner. The new session uses the same worktree and branch. |
| `awb prove [--json]` | Starts the app from `.awb/run.md`, writes the missing proof tests with a fresh test-writer session, runs them, and runs the gate. Prints the claim table. Exits 1 if the gate fails. |
| `awb ship [--json]` | Runs the gate again from the files on disk. If it passes, scans the specs for secrets, pushes the branch, opens a draft PR, uploads each video to the prerelease `awb-proof-<PR>`, and writes the PR body. Sets the task to `done`. Refuses when the gate fails. |
| `awb show [task] [--json]` | Shows a task: with no id, the task of the current branch. A prefix of 6 or more characters works. Shows the claims, the failure reason, every gate row, the cost, the transcripts and the PR. |
| `awb tasks [--repo <path>] [--status a,b] [--since 7d\|12h\|30m\|date] [--json]` | Lists the tasks of all repos, newest first, with the failed claims of the last gate. |
| `awb task rm <id...> [--json]` | Removes waiting tasks in one transaction. If one id has started or does not exist, nothing is removed. |

Limits for a task session: `AWB_TASK_BUDGET_USD` (default 5) and `AWB_TASK_TIMEOUT_MIN` (default 45). `AWB_CLAUDE` replaces `claude` in the launcher and the task sessions, and `AWB_WRITER_CLAUDE` replaces it in the test writer.

`AWB_HOME` defaults to `~/.awb`. Each `AWB_HOME` has its own daemon, database and `daemon.json`. For a dev instance, use `AWB_HOME=~/.awb-dev`.

A repo can replace the default playbook with `.awb/playbook.md`.

`awb` passes hooks to `claude` with `--settings`. Each hook runs `bin/awb-hook`, which sends the hook JSON to the daemon of `AWB_HOME` for the session in `AWB_SESSION_ID`. The sender prints nothing, waits at most 1 s, and always exits 0. If the daemon is down, the event is dropped and the chat continues. On `Stop` and `SessionEnd`, the daemon reads the token totals from the transcript file that the hook names. The UI page gets live updates from `/api/feed` (server-sent events).

The settings also deny `gh pr create` and file edits to the database, `daemon.json` and the task folders in `AWB_HOME` (an `Edit` rule covers every file tool; the worktrees stay writable), so `awb ship` is the only way to open a PR. Every 60 s (`AWB_SYNC_MS`), the daemon asks GitHub for the state of each shipped PR and sets the task to `merged` or `closed`. Traces stay in the task folder and are not uploaded, because a trace can hold cookies.

To test:

```sh
npm test
npm run typecheck
bash spikes/phase1/check.sh      # manual check with a stub claude, no tokens
bash spikes/phase2/check.sh      # live feed check with the real claude (haiku)
bash spikes/phase3/check.sh      # awb prove on the games repo (real claude, about 1.20 USD)
SPECS=<phase 3 task>/proof-tests bash spikes/phase4/check.sh   # awb ship to GitHub, then close the PR
bash spikes/phase5/check.sh      # a stack of three with a stub claude: stacked PRs, a planted bug, a retry
bash spikes/phase6/check.sh      # a failed task, then the real claude (haiku) answers "what failed?"
bash spikes/phase7/check.sh      # the four UI views in a headless browser, with a screenshot of each
```
