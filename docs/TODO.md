# TODO

v6 is a proof of concept. The acceptance test passes (`e2e/acceptance.sh`), but these items stand between it and an MVP. Do the sections in order: the CLI (with awb on awb), then the UI.

## 1. CLI and core, with awb on awb

The gate proves a claim in a browser, or with a repo test for logic that no page shows.

- [x] **Claims proven by repo tests.** A claim can say `"proof": "test"`. A separate writer session reads the worktree and writes an integration test in `.awb-proof/`. It cannot change the source: the daemon undoes a change and refuses. The gate runs the tests with `## test` in the run file and reads JUnit XML for each claim.
- [ ] **Red on the base commit.** Run the test claims on the base commit too. A claim passes only if its test fails on the base and passes on the head. This refuses a test that passes on any code.
- [ ] **Test claims carried forward in a stack.** Task N also runs the passing test claims of the tasks below it. A replan change must not break an earlier claim.
- [x] **A run file for a repo that cannot hold awb files.** The run file is `$AWB_HOME/repos/<repo name>.run.md`, outside the repo, so `awb` works the same way in every repo. A committed `.awb/run.md` in the worktree still wins, for a branch that changes how the app starts. One reader (`readRunFile` in `run-md.ts`) serves `prove`, `ship` and the runner.
- [ ] **An env file for a run.** Keep `$AWB_HOME/repos/<repo name>.env`. When the runner makes a worktree, it copies the file into it before `## setup`. The file stays outside the repo, so its secrets are not committed.
- [ ] **Run awb on awb.** Write the run file for this repo: `## setup` runs `npm ci`, `## test` runs `npm test`, and `## start` starts a daemon with its own `AWB_HOME` on `{port}`, so that the UI claims also work. Then do each item below as an awb task in this repo. Each task gets its own worktree, so a change cannot break the daemon that runs it.
- [ ] **Concurrent stacks.** The runner runs one stack at a time. Allow N stacks (default 2) in parallel, and never more than 5 (the v5 lesson: 10 at a time overloaded the host).
- [ ] **Linux.** `cp -c` in the setup recipes and the `open` call are macOS only.
- [ ] **An install.** Publish `awb` as an npm package with a `bin`, so that a user does not need an alias to a clone.
- [ ] **A test-writer report.** Show the writer's cost, turns and time limit in `awb prove` output, so that a missing test has a clear cause.

## 2. Web UI

Today the UI is mostly read-only. Add actions and the observability data.

- [x] **A run view.** The current run: `running`, `stopped` or `done`, the active task and how long it has run. A stopped run shows its reason at the top.
- [x] **Actions on a failed task.** Buttons for Retry, Rewrite test (a check box for each claim) and Drop. Each calls the same route as its CLI command.
- [x] **Cost.** A USD column in Live and Stacks, and the daily total in the header.
- [x] **Logs on the task page.** The task's lines from the structured log (the task detail already returns them as `log`), the setup log, the writer log and the limit reason, next to the claim videos.
- [x] **`quiet` and `lost` in Live.** The feed already sends these states. Give them a color and a short note.
- [x] **A PR list.** All open draft PRs with their gate result and sync state.
- [ ] Do not add a form to start a stack. The chat writes a stack better than a form can.

## Known facts from the acceptance run

- A full run (single, bug, stack, ask) cost about 6 USD and took about 75 minutes on 2026-11-03. On 2026-11-05 it cost about 16 USD, mostly the test writer (9.55 USD), because the turn timer claims are slow for the writer (one writer: 4.56 USD). The stack part passed only with `AWB_WRITER_TIMEOUT_MIN=45 AWB_TASK_TIMEOUT_MIN=120`.
- The writer needs more than 20 minutes for a claim that takes many moves. The stack run passed with `AWB_WRITER_TIMEOUT_MIN=30`. Make 30 the default.
- The time limits do not fit together. A task session (45 min) can start the test writer (30 min) more than once, for example after `awb prove --rewrite`. In the 2026-11-05 stack run, the writer timed out on a claim about a live countdown, the rewrite started a second writer, and the session reached 45 min while it worked. Fix: give the writer the time that is left in the session, or do not count writer time in the session limit. A retry with `AWB_WRITER_TIMEOUT_MIN=45 AWB_TASK_TIMEOUT_MIN=120` checks if the limits are the only cause.
- `awb prove` can run longer than the agent's Bash call may wait. In the 2026-11-05 stack run, the writer ran more than 5 minutes, the agent's call gave up, and its next `awb prove` was refused with "a proof run for task ... is already running". The proof went on, but the agent lost its result. Fix: let `awb prove` attach to a running proof and wait for its result, and tell the playbook to run `awb prove` in the background.
- A writer that times out writes no result row, so its cost is not recorded. The 2026-11-05 stack task shows 1.52 USD, which is the task session only.
- Each stack run leaves a base branch on GitHub. The acceptance script must delete it after the PRs are retargeted or closed.
