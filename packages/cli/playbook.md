# awb playbook

You work inside Agent Workbench (`awb`). The workbench tracks this session and proves each feature with browser tests before it ships.

## For a feature request

1. Make a branch for the task: `git checkout -b awb/<short-name>`.
2. Write the claims. A claim is one sentence that is true or false, and that a browser test can prove false. Name the labels that a user sees, for example "X wins" or "Reset scores".
3. Create the task. Send the stack as JSON on stdin:
   ```sh
   awb stack set <<'EOF'
   {"tasks":[{"title":"<title>","claims":[{"id":"C1","text":"<claim>"},{"id":"C2","text":"<claim>"}]}]}
   EOF
   ```
4. Make sure that `.awb/run.md` exists. It tells `awb prove` how to start the app. If it does not exist, find the start command and write it:
   ````md
   ## start
   ```sh
   <start command, with {port} where the port goes>
   ```
   url: http://localhost:{port}
   ready: <a path that answers when the app is up>
   ````
   If the app is already running at a fixed URL, leave out the code block and write only `url:` and `ready:`.
   If a fresh clone needs an install before the app can start, add a `## setup` section with a ```sh block, for example `npm ci`. The runner runs it in each new worktree.
5. Write the code. Run the repo lint, typecheck and unit tests, and fix every failure.
6. Commit. `awb prove` refuses uncommitted changes.
7. Run `awb prove`. A separate session writes the proof tests from the claims and the running app. Then the gate runs them. The command prints a claim table.
8. If a claim fails, fix the code, commit, and run `awb prove` again. Do not edit the proof tests. They are not yours, and the gate refuses a test that changed during a run.
9. When every claim passes, run `awb ship`. It runs the gate again, pushes the branch, uploads the videos and opens a draft PR. Report the PR URL and the claim table.

## For a big feature

One session has a limit. If the feature needs more than about one session of work, or more than about 6 claims, split it into a stack of tasks. Each task must stand alone: it has its own claims, and its PR makes sense on top of the tasks below it.

1. Write the tasks in order, from the bottom up. Do not make a branch for each task. The daemon makes them.
2. Send the whole stack:
   ```sh
   awb stack set <<'EOF'
   {"tasks":[{"title":"<task 1>","claims":[...]},{"title":"<task 2>","claims":[...]}]}
   EOF
   ```
3. Make sure that `.awb/run.md` exists and is committed, and push the current branch. The first task starts from the current branch, and the PR of the first task targets it.
4. Run `awb run`. It returns at once. A fresh session does each task in its own worktree. Each task branches from the task below, so the PRs stack.
5. If a task fails, the stack stops. Run `awb show` in that task's worktree, or read the reason from `awb run`. To try again, run `awb retry <task id>`.

## Questions about tasks

The daemon keeps every task, attempt and gate result. Answer from it, not from memory. Run the command, then answer in a few lines.

| The user asks | Run |
| --- | --- |
| What did you do today? What is open? | `awb tasks --since 1d --json` |
| What failed (this week)? | `awb tasks --status failed --since 7d --json`, then `awb show <id> --json` for each one |
| Why did a task fail? | `awb show <id> --json`: the failure reason, the gate rows of each attempt, the cost and the transcripts |
| Which PRs are still open? | `awb tasks --status done --json` (a merged PR shows as `merged`) |
| Retry it. | `awb retry <id>` |
| Drop these tasks. | `awb task rm <id...>` (waiting tasks only) |

A task id prefix of 8 characters, as `awb tasks` prints it, works in every command.

## Rules

- Your own message is never proof. Only the claim table from `awb prove` is.
- Run `awb show` to see the task, its claims and every gate result.
- Do not open a pull request yourself. `awb ship` is the only way. It refuses when the gate fails.
