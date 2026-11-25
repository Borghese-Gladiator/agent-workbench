# TODO

## Proof run

- [ ] **`awb prove` client stops after a body timeout.** A long proof run makes the client fail with `UND_ERR_BODY_TIMEOUT` and `TypeError: terminated`. The daemon keeps the run, and the gate result is in the log. The user sees a crash for a run that works. Make the client retry the wait, or make the daemon send keep-alive bytes. The proof for the fix: a run of more than 5 minutes ends with the gate result in the client output.
- [ ] **`awb ship` fails on a video upload.** One run failed with "ReleaseAsset.name already exists" after 5 of 7 uploads. A second `awb ship` worked. The cause is not known. Find the cause in `uploadVideos` in `packages/daemon/src/ship.ts`. Do not use `--clobber` as the only fix if two runs write at the same time.
- [ ] **The test writer times out under machine load.** At a load of about 47, the writer stopped after 30 minutes with a test for one claim of five. Make the timeout a setting. Keep the tests that the writer finished, so a retry writes only the missing claims.
- [ ] **Two `awb prove` runs overlap on one seed folder.** The log shows `ENOTEMPTY` on a seed folder after a second run started. Lock the seed folder for each task, or give each run its own folder.
- [ ] **No gate for the dark screenshot.** `build-ui.md` section 6 asks for a dark screenshot at 1440px of each main screen. No code checks that the agent took it. Add a claim type or a gate step that fails when the file is missing.
- [ ] **Proof does not show that a test fails on broken code.** A pass on the first run does not show that the test can fail. Add a mutation step: break the changed code on a copy, run the tests, and require a failure.

## Proof cost

Video and trace stay on for browser claims. The gate needs them as evidence. Do not reduce them.

- [ ] **Optional limits for the test writer.** Add a setting for the model, the turn count and the cost of one writer session. No setting has a default. With no setting, `runClaude` in `packages/daemon/src/writer.ts` passes no flag, as it does now. With a setting, it passes the matching `claude` flag. The timeout setting in "The test writer times out under machine load" belongs with these settings. Claims for the proof:
  - With no setting, the writer arguments have no model flag, no turn flag and no cost flag.
  - With each setting, the writer arguments have the matching flag and value.
  - A value that is not valid fails with a clear message before the session starts.
- [ ] **Run only the claims that a code change can affect.** Slice 1 is done: the writer writes `c1.files` next to each test, and `claimsAffected` in `packages/daemon/src/claim-files.ts` picks the claims to run. Slice 2 is open: call it from `prove`, and add the "kept from <sha>" gate row. Today each `awb prove` runs every claim after any change. Make the writer list the files that each claim depends on. Save the list next to the test. On a new run, read `git diff --name-only <sha of the last pass>..HEAD`. A claim keeps its last pass when its test file and its listed files did not change. Run all claims when the change touches a file that no claim lists, a lock file or a config file. The cost of a wrong list is a false pass, so the fallback must favor a full run. Claims for the proof:
  - A change to a file that claim C1 lists runs C1 and keeps C2.
  - A change to a file that no claim lists runs all claims.
  - A kept claim shows "kept from <sha>" in the gate row, not "PASS".
- [ ] **Carried tasks rerun on every proof run.** `carriedClaims` in `packages/daemon/src/task-helpers.ts` adds each passed test claim of the tasks below, and `prove` runs them again. Use the file list from the item above. Rerun a carried claim only when the diff since its last pass touches its files. The carried tasks exist to catch a regression from a higher task, so keep the full rerun when the file list is missing. Claim for the proof: a task that changes only its own files keeps all carried claims and starts no carried test run.
- [ ] **Do not repeat the base run for the same test.** The base run is not a repeat. It proves that a test fails on the old code. But it runs again on each proof run, also when the test file and the merge base did not change. Save the base result with the hash of the test file and the merge base sha. Reuse the result when both match. Run the base commit only for claims that pass on the head commit. Claims for the proof:
  - A second `awb prove` with the same test hash and the same merge base does not switch the worktree to the base commit.
  - A changed test file runs the base run again for that claim only.
- [ ] **Question: can the writer run count as the proof run?** The test writer runs the tests in its own session, and `runRepoTests` runs them again. The second run is independent of the writer, and the gate needs that. Decide whether to keep both. A cheaper option: keep the proof run, and tell the writer to run its tests only once at the end. Measure the share of writer time that goes to test runs before a change.

## Windows

- [ ] **Claude writer sessions survive a daemon restart.** `run()` in `packages/daemon/src/process.ts` adds each child to the `groups` set in memory only. `remember` records only the app process from `startApp`. After a restart, `killLeftovers` cannot find the writer sessions. The old sessions keep running while the resumed run starts new ones. Record each `run()` child in the leftover file, and forget it when it ends. Claim for the proof: after a forced daemon restart in the middle of a writer session, `killLeftovers` ends that session.
- [ ] **Hook processes can open a console window.** Claude Code starts `hook-send.ts` on each tool call (`PreToolUse` and `PostToolUse` with matcher `*`). Our code cannot set `windowsHide` for them. Find out on Windows whether a window opens. If it does, send the events from one long-lived process, or use an HTTP hook, in place of a new `node` process for each call. Keep the draft PR block in `blockReason`.

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
