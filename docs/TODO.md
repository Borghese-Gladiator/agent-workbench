# TODO

v6 is a proof of concept. The acceptance test passes (`e2e/acceptance.sh`), but these items stand between it and an MVP. Do the sections in order: observability, then the CLI (with awb on awb), then the UI.

## 1. Observability

### When things go wrong

- [ ] **A notice when a run stops.** A stopped stack reports nothing today. Send a desktop notice (`osascript` on macOS) when a run goes to `stopped` or `done`. Add Slack later, as an optional webhook.
- [ ] **The true failure reason when a limit stops a session.** When the test writer reaches its time limit, the gate says "no test". When a task session reaches its budget or time limit, the reason says "ended without a PR". Record the limit (`timeout`, `budget`, `exit <code>`) on the attempt, and put it in `fail_reason`.
- [ ] **No stuck `doing` task.** `awb prove` sets `doing`, and nothing resets it when the session ends. The planted-bug task in the acceptance run stayed `doing`. At the end of a proof run, and when the daemon starts, set each `doing` task with no live proof run back to `waiting` or `failed`.
- [ ] **A quiet-session check.** Flag a session with no hook event for N minutes (default 15) as `quiet` in the feed.
- [ ] **Logs where the task is.** Keep `setup.log`, `writer.jsonl`, `run.log` and the session transcript as they are now. Add the daemon errors for a task to its folder, as `daemon.log` is only one file for all tasks.
- [ ] **A durable run state.** The runner keeps runs in memory, so a daemon restart loses a running stack. Store runs in SQLite, and on start mark a run that was `running` as `stopped` with the reason "daemon restart".

### Cost

- [ ] **USD for each session.** The Live view shows tokens. The result row of a `-p` session has `total_cost_usd`. For an interactive session, compute USD from the tokens and a price table for each model.
- [ ] **Totals.** `awb cost [--since 7d] [--repo] [--json]`: the total for each day, repo, stack and task. Split it into the task session and the test writer.
- [ ] **A total budget.** `AWB_DAILY_BUDGET_USD`. The runner and `awb prove` refuse to start a new session when today's total is above it. Each session has a limit already, but nothing stops the tenth retry.

## 2. CLI and core, with awb on awb

The first task makes the rest possible. Repo-test claims are on branch `timothyshee/test-claims`.

- [x] **Claims proven by repo tests.** A claim can say `"proof": "test"`. A separate writer session reads the worktree and writes an integration test in `.awb-proof/`. It cannot change the source: the daemon undoes a change and refuses. The gate runs the tests with `## test` in `.awb/run.md` and reads JUnit XML for each claim.
- [ ] **Red on the base commit.** Run the test claims on the base commit too. A claim passes only if its test fails on the base and passes on the head. This refuses a test that passes on any code.
- [ ] **Test claims carried forward in a stack.** Task N also runs the passing test claims of the tasks below it. A replan change must not break an earlier claim.
- [ ] **A run file for a repo that cannot hold awb files.** A team repo (for example, every repo in `~/Klaviyo/Repos`) must not get `.awb/run.md`. Keep the file as the first choice, because it changes with the branch. If the worktree has no file, use a copy that the daemon keeps.
  - Add a `run_md TEXT` column and an `env_file TEXT` column to `repos`.
  - `awb repo set [--env-file <path>]` reads a run file on stdin, in the same format as `.awb/run.md`, and saves it for the current repo. `awb repo show` prints the run file that a run uses, and its source (`file` or `daemon`).
  - One function reads the run file: the worktree file first, then `repos.run_md`. `prove.ts`, `ship.ts` and `runner.ts` call it, and do not read `.awb/run.md` themselves.
  - When the runner makes a worktree, it copies `env_file` into it before `## setup`. The file stays outside the repo, so its secrets are not committed.
  - Playbook step 4: if the repo is not yours, run `awb repo set`. Do not write `.awb/run.md`. To find out, check if the repo root is in `AWB_TEAM_ROOTS` (default `~/Klaviyo/Repos`).
  - Done when `awb prove` and `awb run` work in a team repo, and `git status` in it shows no awb file.
- [ ] **Run awb on awb.** Add `.awb/run.md` to this repo: `## setup` runs `npm ci`, `## test` runs `npm test`, and `## start` starts a daemon with its own `AWB_HOME` on `{port}`, so that the UI claims also work. Then do each item below as an awb task in this repo. Each task gets its own worktree, so a change cannot break the daemon that runs it.
- [ ] **Concurrent stacks.** The runner runs one stack at a time. Allow N stacks (default 2) in parallel, and never more than 5 (the v5 lesson: 10 at a time overloaded the host).
- [ ] **Linux.** `cp -c` in the setup recipes and the `open` call are macOS only.
- [ ] **An install.** Publish `awb` as an npm package with a `bin`, so that a user does not need an alias to a clone.
- [ ] **A test-writer report.** Show the writer's cost, turns and time limit in `awb prove` output, so that a missing test has a clear cause.

## 3. Web UI

Today the UI is mostly read-only. Add actions and the data from section 1.

- [ ] **A run view.** The current run: `running`, `stopped` or `done`, the active task and how long it has run. A stopped run shows its reason at the top.
- [ ] **Actions on a failed task.** Buttons for Retry, Rewrite test (a check box for each claim) and Drop. Each calls the same route as its CLI command.
- [ ] **Cost.** A USD column in Live and Stacks, and the daily total in the header.
- [ ] **Logs on the task page.** The setup log, the writer log and the limit reason, next to the claim videos.
- [ ] **A PR list.** All open draft PRs with their gate result and sync state.
- [ ] Do not add a form to start a stack. The chat writes a stack better than a form can.

## Known facts from the acceptance run

- A full run (single, bug, stack, ask) costs about 6 USD and takes about 75 minutes.
- The writer needs more than 20 minutes for a claim that takes many moves. The stack run passed with `AWB_WRITER_TIMEOUT_MIN=30`. Make 30 the default.
- Each stack run leaves a base branch on GitHub. The acceptance script must delete it after the PRs are retargeted or closed.
