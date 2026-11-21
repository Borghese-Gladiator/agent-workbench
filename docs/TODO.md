# TODO

## Proof run

- [ ] **`awb prove` client stops after a body timeout.** A long proof run makes the client fail with `UND_ERR_BODY_TIMEOUT` and `TypeError: terminated`. The daemon keeps the run, and the gate result is in the log. The user sees a crash for a run that works. Make the client retry the wait, or make the daemon send keep-alive bytes. The proof for the fix: a run of more than 5 minutes ends with the gate result in the client output.
- [ ] **`awb ship` fails on a video upload.** One run failed with "ReleaseAsset.name already exists" after 5 of 7 uploads. A second `awb ship` worked. The cause is not known. Find the cause in `uploadVideos` in `packages/daemon/src/ship.ts`. Do not use `--clobber` as the only fix if two runs write at the same time.
- [ ] **The test writer times out under machine load.** At a load of about 47, the writer stopped after 30 minutes with a test for one claim of five. Make the timeout a setting. Keep the tests that the writer finished, so a retry writes only the missing claims.
- [ ] **Two `awb prove` runs overlap on one seed folder.** The log shows `ENOTEMPTY` on a seed folder after a second run started. Lock the seed folder for each task, or give each run its own folder.
- [ ] **No gate for the dark screenshot.** `build-ui.md` section 6 asks for a dark screenshot at 1440px of each main screen. No code checks that the agent took it. Add a claim type or a gate step that fails when the file is missing.
- [ ] **Proof does not show that a test fails on broken code.** A pass on the first run does not show that the test can fail. Add a mutation step: break the changed code on a copy, run the tests, and require a failure.

## UI

- [ ] **The Stacks State column hides the real status.** The dark 1440px screenshot of the Stacks page shows "Seed merged task" as Done and "Seed closed task" as Waiting. The State column uses `stepStates` in `packages/daemon/ui/select.ts`, which maps merged to done and closed to waiting. The Merged and Closed filters then list rows with a different label. Show the real task status in the column. Claim for the proof: with the Closed filter, the row state reads "Closed".
- [ ] **The Stacks tables have different column widths.** Each stack has its own table, so the Task, Branch and USD columns do not line up from one stack to the next. Use one fixed column layout for all tables.

- [ ] **Failed-claim actions on the task page.** The task page shows the failed claim ids in a callout, and each claim row shows its reasons. Retry is in the page header. The Rewrite form is in the Verification tab. Put a "Rewrite this test" button in each failed claim row. The button calls the same route as `awb prove --rewrite C1`. Show the last reason and the video link in the row. A failed task shows one "Retry task" button next to the callout. Claims for the proof:
  - A failed claim row has a "Rewrite this test" button. A passed claim row has none.
  - A click on the button starts the rewrite for that claim only.
  - The callout links to the first failed claim row.
- [ ] **Failed claims across tasks.** Do this only if the task page change is not enough. The Live page lists tasks that need attention. Add one list of every failed claim with its task, its reason and a link to the claim row. The list has a filter by repository.
## Flaky unit test

One unit test fails in some runs of `npm test`. It passes when the same code runs again.

### What we know

- The failure shows `code: 'ERR_ASSERTION'` and `operator: 'throws'`.
- It failed in 2 of about 9 runs on 2026-11-19.
- The two failures happened when another suite ran at about the same time: first the browser suite, then a second `npm test` that started right after it.
- The next 4 runs passed in a row (266 tests). The code did not change between a failing run and a passing run.
- The pre-commit hook runs `npm test`. A failure in the hook stops the commit. A second commit attempt passed.

### What we do not know

- The name of the failing test. The output was not saved in either failing run.
- The cause. One guess is a port clash: some tests start a real daemon, and the browser suite starts one as well. We did not test this guess.

### Next steps

1. Run `npm test` many times, one run at a time, and save the output of each run to a file. Look for a run with `fail` above 0, and find the test name in that file.
2. Run `npm test` while `npm run e2e` runs. If the failure appears often, the cause is shared ports or shared state.
3. When the test is known, fix its cause. Do not add a retry.
4. Until then, if the pre-commit hook fails on a test that your change did not touch, run the commit again.

## Stacks and runs

- [ ] **Change the stack limit without a restart.** `AWB_MAX_STACKS` is read from the environment of the process that started the daemon, so raising it means a restart, and a restart fails every task that is running. Add `awb limit <n>` (and a field in the UI) that changes the limit in the running daemon and stores it in `AWB_HOME/config.json`, so the next daemon start keeps it. The new limit takes effect for the next `awb run`. Lowering it never stops a stack that is running; it only refuses new ones until fewer are left. The env var stays as the default when no config value is set, and the cap of 5 stays.
- [ ] **Stop at the next task, then restart safely.** A daemon restart marks every run `stopped` and fails any task with no live session, so restarting with stacks running costs the tasks in progress. Add `awb stop --after-task <stack id>` (and `awb daemon stop --when-idle`): the runner finishes the current task, starts no next one, and ends the run with the reason "stopped by you". Then a restart loses no work.
- [ ] **Resume runs after a restart.** On start, the daemon knows which runs it stopped for "daemon restart". Offer `awb run --all-stopped`, or an `AWB_AUTORESUME=1` setting, that starts them again from the first `waiting` task.
- [ ] **Tasks stuck in `doing` after a restart.** Runner sessions write to a pipe to the daemon, so a session that outlives the daemon loses its result, and its task stays `doing` while its stack is `stopped`. `recover` must adopt such a session (read its transcript) or kill it and fail the task. Also check that the pid belongs to the session: Windows reuses pids, so a dead session can look alive.
- [ ] **Track and stop the app servers a proof starts.** Windows has no process groups, so `process.kill(-pid)` did nothing and every proof leaked a `next start`: 17 were still running after one day. `killTree` (taskkill) now stops the app at the end of a proof. Still open: record each child pid, stop the ones that are left when the daemon starts or stops, and add `awb cleanup` for the rest.
- [ ] **`awb stacks` and `awb stack show`.** There is no command to list stacks with their ids, run ids and task states, so the only way is to read `awb.db`. `awb run`, `awb stop` and the UI all need a stack id.

## Windows

awb now runs on Windows (Git Bash for `sh` and hooks). These items remain.

- [ ] **`awb doctor` runs the real checks.** Run the hook script under `sh` and confirm the event reaches the daemon; run `node @playwright/test/cli.js --version`; check that `sh` and `git` are on the PATH; check that `claude` starts (an npm `claude.cmd` cannot be spawned without a shell). Each failure prints the fix.
- [ ] **Say why a proof did not run.** When Playwright fails to start, the gate reports "no test", which reads like a test failure. Read the start error from `proof/run.log` and report "Playwright did not start: ..." instead.
- [ ] **README prerequisites for Windows.** Git for Windows, `npx playwright install chromium`, and Developer Mode (for tests that need symlinks).
- [ ] **Run the tests on Windows in CI.** The `prove-tests` cases skip on Windows because the fake `claude` is an `sh` script, and one `ui-routes` case skips without symlink rights. Make the fake `claude` a node script that the test starts with `process.execPath`, so they run everywhere.
- [ ] **No console windows.** Every spawn sets `windowsHide`. Add a lint or a test that fails on a new `spawn`, `execFile` or `execFileSync` without it.
