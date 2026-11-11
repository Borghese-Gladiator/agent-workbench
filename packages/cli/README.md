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
| `awb ui [--no-open]` | Prints the UI URL and opens it. The header shows the cost of today. The UI has five views: Live (the current run, and every session with its state and cost), Session (its events and tokens), Stacks (each task with its status, cost and PR; you can edit a waiting task), PRs (each open PR with its gate result and state) and the proof page of a task (the claim table, a video for each claim, the trace, the logs, the proof tests and the diff). On the page of a failed task, Retry, Rewrite test and Drop call the same routes as `awb retry`, `awb prove --rewrite` and `awb task rm`. |
| `awb sessions [--json]` | Lists the sessions. |
| `awb doctor` | Checks the setup and prints a fix for each problem. |
| `awb wt [repo] [--root <dir>] [--json]` | Lists the worktrees in `<root>/<repo>/<branch>`, grouped by repo, with the branch, the number of changed files and the last commit age. The root is `--root`, else `AWB_WORKTREES`, else `~/Klaviyo/Repos/LOCAL_worktrees` when the current folder is in `~/Klaviyo/Repos`, else `~/LOCAL_worktrees`. A folder without a `.git` file shows as `not a worktree`. |
| `awb wt pick [repo] [--root <dir>]` | Opens a picker. Arrow keys or `j`/`k` move, Space marks, `d` then `y` removes the marked worktrees with `git worktree remove` (it refuses a worktree with changes), Enter prints the path, `q` quits. The picker draws on stderr, so `cd "$(awb wt pick)"` works. |
| `awb daemon start\|stop\|status` | Controls the daemon of the active `AWB_HOME`. |
| `awb stack set [--json]` | Reads a stack as JSON on stdin and creates or replaces it. A stack of one binds to the current branch. In a stack of many, each task gets its own branch: task 1 starts from the current branch, and each later task starts from the task below. |
| `awb run [stack] [--wait] [--json]` | Starts the runner on the stack (default: the newest stack of the repo). Without `--wait` it returns at once. With `--wait` it returns when the run is `done` or `stopped`, and exits 1 if it is not `done`. The runner makes a worktree in `AWB_HOME/worktrees/` for each task, runs the `## setup` block of `.awb/run.md` in it, and starts `awb -p` with the task prompt. If a task ends without a PR, the task is `failed` and the stack stops. |
| `awb retry <task> [--wait] [--json]` | Sets a `failed` task back to `waiting` and starts the runner. `--wait` works as in `awb run`. The new session uses the same worktree and branch. |
| `awb prove [--rewrite C1,C2] [--json]` | Starts the app from `.awb/run.md`, writes the missing proof tests with a fresh test-writer session, runs them, and runs the gate. `--rewrite` first deletes the tests of those claims, so that the writer writes them again. Prints the claim table. Exits 1 if the gate fails. |
| `awb ship [--json]` | Runs the gate again from the files on disk. If it passes, scans the specs for secrets, pushes the branch, opens a draft PR, uploads each video to the prerelease `awb-proof-<PR>`, and writes the PR body. Sets the task to `done`. Refuses when the gate fails. |
| `awb show [task] [--json]` | Shows a task: with no id, the task of the current branch. A prefix of 6 or more characters works. Shows the claims, the failure reason, every gate row, the cost, the transcripts and the PR. |
| `awb tasks [--repo <path>] [--status a,b] [--since 7d\|12h\|30m\|date] [--json]` | Lists the tasks of all repos, newest first, with the failed claims of the last gate. |
| `awb cost [--since 7d] [--repo <name or path>] [--json]` | The estimated cost for each day, repo and task, split into sessions and the test writer. The estimate comes from the token counts and the price table in `prices.ts`. A session with a model that is not in the table counts as unpriced. |
| `awb logs [--task <id>] [--run <id>] [--session <id>] [--level debug\|info\|warn\|error] [--source <name>] [--since 1d] [--limit 200] [--follow] [--json]` | Reads the structured log of every awb part from `AWB_HOME/logs/`. `--level warn` shows warnings and errors. `--follow` (or `-f`) prints new lines as they come. A CLI command that fails also writes a `cli.error` line. |
| `awb task rm <id...> [--json]` | Removes waiting or failed tasks in one transaction, with the attempts and gate results of each. If one id is doing, is shipped or does not exist, nothing is removed. |

Time limits: `AWB_TASK_TIMEOUT_MIN` for a task session (default 45) and `AWB_WRITER_TIMEOUT_MIN` for the test writer (default 30). awb sets no spend limit. It records the cost of each session and test writer. `AWB_CLAUDE` replaces `claude` in the launcher and the task sessions, and `AWB_WRITER_CLAUDE` replaces it in the test writer.

Logs: every part writes JSON lines to `AWB_HOME/logs/awb.<YYYY-MM-DD>.jsonl`, one file for each UTC day. At 50 MB the day continues in `awb.<YYYY-MM-DD>.1.jsonl`, then `.2`, and so on. No file is ever renamed. awb never deletes a log file unless you set `AWB_LOG_KEEP_DAYS` to a number of days (the default is `none`). `AWB_QUIET_MIN` (default 15) sets when a silent session shows `quiet`. A run that stops or finishes shows a desktop notice: `AWB_NOTIFY=0` turns it off, and `AWB_NOTIFY_CMD` runs your own command with the title and the text.

`AWB_HOME` defaults to `~/.awb`. Each `AWB_HOME` has its own daemon, database and `daemon.json`. For a dev instance, use `AWB_HOME=~/.awb-dev`.

A repo can replace the default playbook with `.awb/playbook.md`.

`awb` also loads the plugin in `packages/cli/plugin` with `--plugin-dir`. It has three skills: `awb:sentry-fix` (reproduce one Sentry issue with a test that fails with the same exception and frame, fix it, and write the before and after output to `$AWB_HOME/sentry/<id>/proof.md`), `awb:bug-triage` (a channel or a list of links becomes fix and skip verdicts, at most 5 fixes, and a report in `$AWB_HOME/triage/`), and `awb:worktrees` (worktrees in `~/LOCAL_worktrees/<repo>/<branch>`). The skills use the Slack and Sentry MCP servers in your `claude` settings. `awb ship` cannot ship a Sentry fix yet, because the gate proves only browser claims.

`awb` passes hooks to `claude` with `--settings`. Each hook runs `bin/awb-hook`, which sends the hook JSON to the daemon of `AWB_HOME` for the session in `AWB_SESSION_ID`. The sender prints nothing, waits at most 1 s, and always exits 0. If the daemon is down, the event is dropped and the chat continues. On `Stop` and `SessionEnd`, the daemon reads the token totals from the transcript file that the hook names. The UI page gets live updates from `/api/feed` (server-sent events).

The settings also deny `gh pr create` and file edits to the database, `daemon.json` and the task folders in `AWB_HOME` (an `Edit` rule covers every file tool; the worktrees stay writable), so `awb ship` is the only way to open a PR. Every 60 s (`AWB_SYNC_MS`), the daemon asks GitHub for the state of each shipped PR and sets the task to `merged` or `closed`. Traces stay in the task folder and are not uploaded, because a trace can hold cookies.

To test:

```sh
npm test
npm run typecheck
bash e2e/wt.sh                           # awb wt with real git worktrees and the picker in a pty (no cost)
WORK=<dir> bash e2e/acceptance.sh setup   # then single, bug, stack, ask (real claude and GitHub, about 6 USD)
```
