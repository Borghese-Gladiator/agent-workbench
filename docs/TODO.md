# TODO

v6 is a proof of concept. The acceptance test passes (`e2e/acceptance.sh`), but these items stand between it and an MVP. Do the sections in order: observability, then the CLI (with awb on awb), then the UI.

## 1. Observability

### When things go wrong

- [x] **A notice when a run stops.** A stopped stack reports nothing today. Send a desktop notice (`osascript` on macOS) when a run goes to `stopped` or `done`. Add Slack later, as an optional webhook.
- [x] **The true failure reason when a limit stops a session.** A task session and the test writer report how they ended (`timeout after N min`, a result subtype, or `exit <code>`). It goes into `fail_reason` and into the "no test" reason of the gate.
- [x] **No stuck `doing` task.** `awb prove` sets `doing`, and nothing resets it when the session ends. The planted-bug task in the acceptance run stayed `doing`. At the end of a proof run, and when the daemon starts, set each `doing` task with no live proof run back to `waiting` or `failed`.
- [x] **A quiet-session check.** A session with no hook event for `AWB_QUIET_MIN` minutes (default 15) is `quiet`. A session whose `awb` process is dead is `lost`. (The Live view does not show them yet: see section 3.)
- [x] **One structured log.** Every part writes JSON lines to `AWB_HOME/logs/awb.<day>.jsonl`, and `awb logs` reads them. See [TODO-logging.md](TODO-logging.md).
- [x] **The log in Grafana on this machine.** `infra/logging/` runs Loki, Alloy and Grafana in Docker, and the outage test delivers every line once.
- [ ] **The log from another computer.** Install Tailscale, set `GRAFANA_BIND` in `infra/logging/.env` to the Tailscale address, and test from a second computer.
- [ ] **Check the cost panel with a real session.** The "Estimated cost per day" panel reads `usd` on `runner.session.ended` and `writer_usd` on `prove.gate`. The stub tests write no cost.
- [x] **A durable run state.** The runner keeps runs in memory, so a daemon restart loses a running stack. Store runs in SQLite, and on start mark a run that was `running` as `stopped` with the reason "daemon restart".

### Cost

- [x] **USD for each session.** An estimated cost from the tokens and a price table for each model (`prices.ts`). The writer cost of each attempt is saved. `GET /api/cost` gives the totals.
- [x] **`awb cost [--since 7d] [--repo] [--json]`.** The CLI command for `GET /api/cost`: the total for each day, repo and task, split into the task session and the test writer.
- [ ] **The cost of an interactive session is low.** A `-p` session (every task session, the test writer) has a `result` row with its exact `usage` and `total_cost_usd`, and awb uses it. An interactive session has no `result` row, and its saved transcript has only the output tokens from the start of each message (162 of 4,251 in one test). So its estimate leaves out most of the output cost. Fix: read the final usage from the `Stop` hook input if Claude Code adds it there, or from the statusline cost data.
- [ ] **Keep the price table current.** `prices.ts` is a copy of the published prices. A new model has no price until someone adds it, and the cost report counts it as unpriced.

awb tracks cost and sets no spend limit.

## 2. CLI and core, with awb on awb

The first task makes the rest possible. Today the gate proves claims only with Playwright tests in a browser, and most of awb has no browser.

- [ ] **Claims proven by repo tests (first, and do it by hand).** A claim can say `"proof": "test"`. The writer then writes a unit test in the repo (for this repo: `node --test`), not a Playwright test. The gate runs it from a command in `.awb/run.md` (`## test`) and reads the result per claim. The same rules hold: the agent does not write the test, and the gate refuses a test that changed during the run.
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
- [ ] **Logs on the task page.** The task's lines from the structured log (the task detail already returns them as `log`), the setup log, the writer log and the limit reason, next to the claim videos.
- [ ] **`quiet` and `lost` in Live.** The feed already sends these states. Give them a color and a short note.
- [ ] **A PR list.** All open draft PRs with their gate result and sync state.
- [ ] Do not add a form to start a stack. The chat writes a stack better than a form can.

## Known facts from the acceptance run

- A full run (single, bug, stack, ask) costs about 6 USD and takes about 75 minutes.
- The writer needs more than 20 minutes for a claim that takes many moves. The stack run passed with `AWB_WRITER_TIMEOUT_MIN=30`. Make 30 the default.
- The time limits do not fit together. A task session (45 min) can start the test writer (30 min) more than once, for example after `awb prove --rewrite`. In the 2026-11-05 stack run, the writer timed out on a claim about a live countdown, the rewrite started a second writer, and the session reached 45 min while it worked. Fix: give the writer the time that is left in the session, or do not count writer time in the session limit. A retry with `AWB_WRITER_TIMEOUT_MIN=45 AWB_TASK_TIMEOUT_MIN=120` checks if the limits are the only cause.
- `awb prove` can run longer than the agent's Bash call may wait. In the 2026-11-05 stack run, the writer ran more than 5 minutes, the agent's call gave up, and its next `awb prove` was refused with "a proof run for task ... is already running". The proof went on, but the agent lost its result. Fix: let `awb prove` attach to a running proof and wait for its result, and tell the playbook to run `awb prove` in the background.
- A writer that times out writes no result row, so its cost is not recorded. The 2026-11-05 stack task shows 1.52 USD, which is the task session only.
- Each stack run leaves a base branch on GitHub. The acceptance script must delete it after the PRs are retargeted or closed.
