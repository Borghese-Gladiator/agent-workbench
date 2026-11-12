# awb playbook

You work inside Agent Workbench (`awb`). The workbench tracks this session and proves each feature with browser tests or repo tests before it ships.

## For a feature request

1. Make a branch for the task: `git checkout -b awb/<short-name>`.
2. Write the claims. A claim is one sentence that is true or false, and that a browser test can prove false. Name the labels that a user sees, for example "X wins" or "Reset scores".
   If a claim is about logic that a page does not show (an engine, a rule, a calculation), add `"proof":"test"` to it. A separate session then proves it with an integration test in the repo test framework, not in a browser. Write the input and the result, for example "After the event B moves to 14:00, replan keeps the event A at 10:00 in every option".
3. Create the task. Send the stack as JSON on stdin:
   ```sh
   awb stack set <<'EOF'
   {"tasks":[{"title":"<title>","claims":[{"id":"C1","text":"<claim>"},{"id":"C2","text":"<claim>"}]}]}
   EOF
   ```
4. Make sure that a run file exists. It tells `awb prove` how to start the app and run the tests. `awb` uses `.awb/run.md` in the repo if it exists, else `{run_file}`. The second file is outside the repo, so do not commit it. If neither file exists, find the start command and write it to `{run_file}`:
   ````md
   ## start
   ```sh
   <start command, with {port} where the port goes>
   ```
   url: http://localhost:{port}
   ready: <a path that answers when the app is up>
   ````
   If the app is already running at a fixed URL, leave out the code block and write only `url:` and `ready:`.
   For `"proof":"test"` claims, add a `## test` section. Its ```sh block runs the given test files with a JUnit XML reporter. `{tests}` is the list of files, and `{report}` is the XML path. For `node --test`:
   ````md
   ## test
   ```sh
   node --test --test-reporter=junit --test-reporter-destination={report} {tests}
   ```
   ````
   For other frameworks:
   - vitest: `npx vitest run --reporter=junit --outputFile={report} {tests}`
   - pytest: `python3 -m pytest -q -p no:cacheprovider --junitxml={report} {tests}` (add `pythonpath = .` in `pytest.ini` if the tests cannot import the code)
   The test writer names each file for its claim: `c1.test.ts` or `c1_test.py`. The gate maps a test to a claim from the file name.
   A task with only test claims does not need `## start`.
   If a fresh clone needs an install before the app can start, add a `## setup` section with a ```sh block, for example `npm ci`. The runner runs it in each new worktree.
   If this branch changes how the app starts, write the new run file to `.awb/run.md` in the repo and commit it. That file wins over the run file outside the repo.
5. Write the code. If the task adds or changes a UI, read `{skills}/build-ui.md` first and follow it. It sets the stack, the default theme and the PWA claims. Add those claims to the task before you write the code. Run the repo lint, typecheck and unit tests, and fix every failure.
6. Commit. `awb prove` refuses uncommitted changes.
7. Run `awb prove`. A separate session writes the proof tests from the claims and the running app. Then the gate runs them. The command prints a claim table, and a line with how the test writer ended, its cost and its time limit.
8. If a claim fails, fix the code, commit, and run `awb prove` again. Do not edit the proof tests. They are not yours, and the gate refuses a test that changed during a run.
   If the video and the trace (or for a test claim, `proof/test.log` in the task folder) show that the test itself is wrong (it checks something that the claim does not say), run `awb prove --rewrite C1` (a comma list of claim ids). This deletes those tests, and the test writer writes them again. Do not use it to get past a real bug in your code.
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
3. Make sure that the run file exists (step 4 of the feature request), and push the current branch. The first task starts from the current branch, and the PR of the first task targets it.
4. Run `awb run --wait`. A fresh session does each task in its own worktree. Each task branches from the task below, so the PRs stack. The command returns when the run is `done` or `stopped`. Each task can take 30 minutes or more, so run it in the background. Do not write your own wait loop: a stopped stack keeps its later tasks `waiting`.
5. If a task fails, the stack stops. Run `awb show <task id>` to read the reason. To try again, run `awb retry <task id> --wait`.

## Questions about tasks

The daemon keeps every task, attempt and gate result. Answer from it, not from memory. Run the command, then answer in a few lines.

| The user asks | Run |
| --- | --- |
| What did you do today? What is open? | `awb tasks --since 1d --json` |
| What failed (this week)? | `awb tasks --status failed --since 7d --json`, then `awb show <id> --json` for each one |
| Why did a task fail? | `awb show <id> --json`: the failure reason, the gate rows of each attempt, the cost and the transcripts |
| Which PRs are still open? | `awb tasks --status done --json` (a merged PR shows as `merged`) |
| What did it cost (this week)? | `awb cost --since 7d --json` |
| What went wrong (today)? | `awb logs --level warn --since 1d`, then `awb logs --task <id>` for one task |
| Retry it. | `awb retry <id> --wait` |
| Drop these tasks. | `awb task rm <id...>` (waiting or failed tasks only) |

A task id prefix of 8 characters, as `awb tasks` prints it, works in every command.

## Rules

- Your own message is never proof. Only the claim table from `awb prove` is.
- Run `awb show` to see the task, its claims and every gate result.
- Do not open a pull request yourself. `awb ship` is the only way. It refuses when the gate fails.
