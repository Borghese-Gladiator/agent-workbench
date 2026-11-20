# awb

Needs Node 24 or later. There is no build step: Node runs the TypeScript files directly.

```sh
npm install                      # dev tools only (typescript, @types/node)
npm install -g .                 # puts awb on the PATH as a link to this clone
awb doctor                       # checks claude, Chromium, the daemon, the MCP servers and the logs
awb                              # opens claude in the current repo
awb ui                           # opens the session list in the browser
```

A task id or a stack id can be a prefix of 6 or more characters in every command.

## Chat and setup

| Command | What it does |
|---|---|
| `awb [claude args]` | Starts the daemon if needed, registers a session, and starts `claude` with the playbook. Every argument goes to `claude`. |
| `awb --resume [id]` | Resumes a Claude Code session in the worktree where it ran. The id is a session id or a task id. With no id, it resumes the newest session of the current branch. |
| `awb ui [--no-open]` | Prints the UI URL and opens it. See "Web UI". |
| `awb doctor` | Checks `claude`, Chromium, the daemon, the Slack, Sentry and Linear MCP servers, and the log pipeline. Prints a fix for each problem. |
| `awb daemon start\|stop\|status` | Controls the daemon of the active `AWB_HOME`. |
| `awb logging up\|down` | Starts or stops the Loki, Alloy and Grafana stack. It reads the logs of the active `AWB_HOME`. |
| `awb wt [repo] [--root <dir>]` | Lists the worktrees of a repo with the branch, the changed files and the last commit age. |
| `awb wt pick [repo]` | Opens a picker. Space marks, `d` then `y` removes the marked worktrees (it refuses a dirty one), Enter prints the path, `q` quits. `cd "$(awb wt pick)"` works. |

## Stacks and tasks

| Command | What it does |
|---|---|
| `awb stack set` | Reads a stack as JSON on stdin and creates or replaces it. A stack of many tasks gets one branch for each task. Task 1 starts from the current branch, and each later task starts from the task below. |
| `awb run [stack \| task] [--wait] [--retries N]` | Starts the runner on a stack (default: the newest of the repo), or on one `waiting` task. A task start fails if a task below it is not done. `--wait` returns when the run is `done` or `stopped`, and exits 1 if it is not `done`. |
| `awb retry <stack \| task> [--wait] [--retries N]` | Sets a `failed` task, or every `failed` task of a stack, back to `waiting` and runs only those tasks. It uses the same worktree and branch. |
| `awb stop <stack \| task>` | Stops the run and the proof of the current task. The task becomes `failed` with the reason `stopped by awb stop`, and the later tasks stay `waiting`. Exits 1 if nothing runs for the id. |
| `awb task rm <id...>` | Removes waiting or failed tasks in one transaction. If one id is doing, is shipped or does not exist, nothing is removed. |
| `awb prove [--rewrite C1,C2]` | Starts the app, writes the missing proof tests with a fresh test-writer session, runs them, and runs the gate. Prints the claim table. Exits 1 if the gate fails. `--rewrite` deletes the tests of those claims first. |
| `awb ship` | Runs the gate again. If it passes, scans for secrets, pushes the branch, opens a draft PR, uploads each video, and sets the task to `done`. Refuses when the gate fails. |

How the runner works:
- It makes a worktree in `AWB_HOME/worktrees/` for each task, runs the `## setup` block of the run file in it, and starts `awb -p` with the task prompt.
- If a session ends on a transient API error (connection refused or reset, overloaded, 429, 5xx, fetch failed), it resumes the same Claude session up to `--retries` times (0 to 5, default 1).
- If a task ends without a PR, the task is `failed` and the stack stops.
- It runs at most `AWB_MAX_STACKS` stacks at a time, and refuses a new one when the limit is full.

## Read the state

| Command | What it does |
|---|---|
| `awb show [task]` | Shows a task: the claims, the failure reason, every gate row, the cost, the transcripts and the PR. With no id, it shows the task of the current branch. |
| `awb tasks [--repo <path>] [--status a,b] [--since 7d]` | Lists the tasks of all repos, newest first, with the failed claims of the last gate. |
| `awb sessions` | Lists the sessions. |
| `awb cost [--since 7d] [--repo <name or path>]` | The estimated cost for each day, repo and task. The estimate uses the price table in `prices.ts`. A model that is not in the table counts as unpriced. |
| `awb logs [--task <id>] [--run <id>] [--session <id>] [--level warn] [--source <name>] [--since 1d] [--limit 200] [-f]` | Reads the structured log from `AWB_HOME/logs/`. `-f` prints new lines as they come. |

`awb sessions`, `awb wt`, `awb stack set`, `awb run`, `awb retry`, `awb stop`, `awb task rm`, `awb prove`, `awb ship`, `awb show`, `awb tasks`, `awb cost` and `awb logs` accept `--json`.

## Web UI

`awb ui` shows the cost of today in the header and these views:
- **Live:** the current run, and every session with its state and cost.
- **Session:** the events and tokens of one session.
- **Stacks:** each task with its status, cost and PR. You can edit a waiting task.
- **PRs:** each open PR with its gate result and state.
- **Task:** the claim table, a video for each claim, the trace, the logs, the proof tests and the diff. On a failed task, Retry, Rewrite test and Drop call the same routes as `awb retry`, `awb prove --rewrite` and `awb task rm`.
- **Logs:** the log lines, with a link to Grafana when Loki runs.

## Settings

`AWB_HOME` defaults to `~/.awb`. Each `AWB_HOME` has its own daemon, database and `daemon.json`. For a dev instance, use `AWB_HOME=~/.awb-dev`.

| Variable | Default | Meaning |
|---|---|---|
| `AWB_HOME` | `~/.awb` | The folder of the daemon, the database, the logs and the task folders. |
| `AWB_PORT` | a free port | The daemon port. |
| `AWB_MAX_STACKS` | 2 (max 5) | The number of stacks that run at the same time. |
| `AWB_TASK_TIMEOUT_MIN` | 45 | The time limit of a task session. |
| `AWB_WRITER_TIMEOUT_MIN` | 30 | The time limit of the test writer. In a task session, it gets only the time left. |
| `AWB_CLAUDE` | `claude` | Replaces `claude` in the launcher and the task sessions. |
| `AWB_WRITER_CLAUDE` | `claude` | Replaces `claude` in the test writer. |
| `AWB_LOG_KEEP_DAYS` | `none` | Deletes log files older than this number of days. `none` keeps every file. |
| `AWB_QUIET_MIN` | 15 | The minutes of silence after which a session shows `quiet`. |
| `AWB_NOTIFY` | on | `0` turns off the desktop notice when a run stops or finishes. |
| `AWB_NOTIFY_CMD` | none | Runs your own command with the title and the text. |
| `AWB_SYNC_MS` | 60000 | How often the daemon asks GitHub for the state of each shipped PR. |
| `AWB_WORKTREES` | see `awb wt` | The root folder of `awb wt`. |
| `AWB_GRAFANA_URL` | none | The Grafana URL. The Logs tab shows a link to it. |
| `AWB_ALLOY_URL` | `http://127.0.0.1:12345` | The Alloy URL that `awb doctor` checks. |
| `AWB_LOKI_URL` | `http://127.0.0.1:3100` | The Loki URL that `awb doctor` checks. |

awb sets no spend limit. It records the cost of each session and test writer.

Logs: every part writes JSON lines to `AWB_HOME/logs/awb.<YYYY-MM-DD>.jsonl`, one file for each UTC day. At 50 MB the day continues in `awb.<YYYY-MM-DD>.1.jsonl`, then `.2`, and so on.

## Scheduled jobs

The daemon runs the jobs in `$AWB_HOME/schedule.json`. It checks every 30 seconds, and each job runs at most once a day. If the daemon is down at the set time, the job runs when the daemon starts, on the same day. The output goes to `$AWB_HOME/schedule/<name>/<YYYY-MM-DD>.md`, and a desktop notice shows the result.

```json
[
  { "name": "standup", "at": "09:30", "cwd": "/path/to/repo", "prompt": "/awb:standup", "timeoutMin": 10 },
  { "name": "sentry-triage", "at": "09:00", "cwd": "/path/to/repo", "timeoutMin": 45, "prompt": "/awb:triage <channel> last 24 hours. Skip each issue that already has a PR." }
]
```

`cwd` is required. It must be a git repo, because `awb -p` exits at once outside one. A job with no `cwd` makes the file not valid. A job that ends well keeps only its standard output in the output file. A failed job keeps the standard error too. `days` is a list of 0 (Sunday) to 6, default `[1,2,3,4,5]`. `allowedTools` replaces the default `Read, Glob, Grep, Bash`.

Each run is a row in the `job_runs` table of `awb.db`, with the state `running`, `done`, `failed` or `stopped`. A run that was open when the daemon stopped becomes `stopped`, and the job starts again the same day. A job that failed does not start again the same day. To start it again, use `awb schedule run`.

| Command | Result |
|---|---|
| `awb schedule` | Each job with its next run and its last run. Exit code 1 if `schedule.json` is not valid. |
| `awb schedule runs [--limit n]` | The history of runs. |
| `awb schedule run <job>` | Starts a job now. |
| `awb schedule output <run id>` | Prints the output of a run. The id can be the first 8 characters. |
| `awb logs --source schedule -f` | The log lines of the scheduler. |

The **Schedule** tab of the UI shows the same data, a **Run now** button for each job, and the output of each run.

## Files in a repo

- **Playbook:** a repo can replace the default playbook with `.awb/playbook.md`.
- **Run file:** it tells `awb` how to set up the worktree, start the app, seed data and run the tests. It is `$AWB_HOME/repos/<repo name>.run.md`, so no awb file goes into the repo. All worktrees of a repo use the same file. If a worktree has `.awb/run.md`, that file wins. Use it only for a branch that changes how the app starts.
- **Repo rules:** a repo that cannot hold awb files can have its own rules in `$AWB_HOME/repos/<repo name>.md`. `awb` adds the file to the end of the playbook, in the repo and in its worktrees. Task sessions get the rules too.

## Plugin and hooks

`awb` loads the plugin in `packages/cli/plugin` with `--plugin-dir`. It has six skills. Each verb is one skill. The source (Sentry, Linear, GitHub, Slack) is a file inside the skill.
- `awb:triage`: gives each item one verdict (`fix`, `answer`, `request`, `route`, `skip`) with evidence, and writes a report in `$AWB_HOME/triage/`. The item can be a Sentry issue, a Linear ticket, a GitHub issue, PR or comment, a Slack thread, a channel, or a list of links. It does not change code and does not post.
- `awb:fix`: reproduces one Sentry issue with a test that fails with the same exception and frame, fixes it, and writes the before and after output to `$AWB_HOME/sentry/<id>/proof.md`. To ship the fix, the skill makes a task with one `"proof":"test"` claim, and then `awb prove` and `awb ship` run as for any task.
- `awb:respond`: drafts one reply for a Slack thread, a GitHub comment or a Linear ticket. It posts only after the user approves that draft.
- `awb:review`: posts one short review comment on a GitHub PR, after the user approves the draft.
- `awb:standup`: prints the standup text (`:yesterday:`, `:today:`, `:construction:`) from commits, PRs, awb tasks and the status of Linear tickets. A PR is "Merged" only when GitHub says it is merged. It only reads and never posts. The skill file has the `schedule.json` job.
- `awb:worktrees`: makes worktrees in `~/LOCAL_worktrees/<repo>/<branch>`.

The skills use the Slack, Sentry and Linear MCP servers in your `claude` settings. `awb doctor` checks them.

`awb` passes hooks to `claude` with `--settings`. Each hook runs `node src/hook-send.ts`, which sends the hook JSON to the daemon for the session in `AWB_SESSION_ID`. The sender prints nothing and waits at most 1 s. If the daemon is down, the event is dropped and the chat continues. On `Stop` and `SessionEnd`, the daemon reads the token totals from the transcript file.

The settings also deny file edits to the database, `daemon.json` and the task folders in `AWB_HOME`. Traces stay in the task folder and are not uploaded, because a trace can hold cookies.

## Windows

- Use Node 24 and Git for Windows. Put `sh` and `git` on `PATH`.
- Run `node packages/cli/src/main.ts` in place of `bin/awb`. The `bin` files are shell scripts.
- The daemon starts every child process with `windowsHide`, so no console window takes focus.
- `npm run e2e` runs on Windows. `e2e/acceptance.sh` runs only on macOS, because it uses the real `claude` and `sed -i ''`.
- The unit tests that use `#!/bin/sh` stubs and `/tmp` paths run only on macOS and Linux.

## Tests

```sh
npm test
npm run typecheck
npm run e2e
```

| Test file | What it covers | Cost |
|---|---|---|
| `e2e/wt.e2e.ts` | `awb wt` with real git worktrees | none |
| `e2e/ui.e2e.ts` | The web UI in a browser, with a real stack run, a stub `claude` and a stub `gh` (about 1 min) | none |
| `e2e/logging.e2e.ts` | The structured log, with a stub `claude` (about 70 s) | none |
| `e2e/repo-test.e2e.ts` | Test claims and the run file outside the repo, with a stub test writer | none |
| `WORK=<dir> bash e2e/acceptance.sh setup`, then `single`, `bug`, `stack`, `ask` | The full flow with the real `claude` and GitHub | about 6 USD |
