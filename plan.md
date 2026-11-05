# Observability (docs/TODO.md section 1)

## Brief

Make awb tell you when something goes wrong, why it went wrong, and what it cost. All data stays in the one SQLite file and the task folders. There is no new service.

## Changes

### When things go wrong

1. **A notice when a run ends.** `createRunner` gets an `onEnd(state)` callback. `main.ts` sends a desktop notice (`osascript` on macOS) for `stopped` and `done`, with the stack, the task and the reason. `AWB_NOTIFY_CMD` replaces the notice command (the e2e test uses it), and `AWB_NOTIFY=0` turns notices off.
2. **The real reason when a limit ends a session.**
   - `run()` returns `timedOut`.
   - A task session returns how it ended: `timeout after N min`, the subtype of the last result row (for example `error_max_turns`), or `exit <code>`. `runStack` adds it to `fail_reason`.
   - The test writer saves how it ended in `proof/writer-end.txt`. The gate adds `test writer: <end>` to each claim with no test, so "no test" has a cause.
3. **No stuck `doing`.**
   - After a proof run that the runner does not own, the task goes to `waiting` if the gate passed, or to `failed` with the reason if it did not.
   - When the daemon starts, a task that is `doing` goes to `failed` with "the daemon restarted while the task ran".
4. **Quiet and lost sessions.** A session that is not ended and has no event for `AWB_QUIET_MIN` minutes (default 15) shows `quiet`. A session whose `awb` process is dead shows `lost`. The Live view checks this again every 30 s.
5. **A log for each task.** `<task folder>/events.log` gets one line with a time for each runner, proof and ship step. This is a stopgap. `docs/TODO-logging.md` plans the full structured log that replaces it.
6. **A durable run state.** A `runs` table holds each run. On start, the daemon sets each `running` run to `stopped` with "daemon restart". `GET /api/runs/:id` reads the table.

### Cost

7. **USD for each session.** `tokenTotals` also gives `cost_usd`, from the model of each message and a price table (`prices.ts`). A model that is not in the table gives no cost. The table is an estimate, so the UI and CLI label it "est.". Live shows a USD column.
8. **The cost of the test writer.** `attempts.writer_usd` keeps the writer cost of each proof run. Today `writer.jsonl` is replaced on each run, so that cost is lost.
9. **Totals.** `GET /api/cost?since&repo` and `awb cost [--since 7d] [--repo] [--json]` give the total, split by session and writer, and for each day, repo and task.
10. **No spend limits.** awb tracks cost only. The per-session caps (`AWB_TASK_BUDGET_USD`, `AWB_WRITER_BUDGET_USD`, `--max-budget-usd`) are removed. The time limits stay.

Not in this change: Slack (add as an `AWB_NOTIFY_CMD` script when needed) and a total for each stack (the task row has the stack id).

## Tests

### Unit

- prices: the cost of a usage row for a known model, a prefix match for a dated id, and no cost for an unknown model.
- gate: a claim with no test gets the writer end reason.
- runner: a session that returns "timeout after 1 min" puts it in `fail_reason`. `onEnd` gets the final state.
- stacks: runs survive a new `createStacks` on the same database. `recover()` stops a `running` run and fails a `doing` task.
- store: `quiet` after the quiet time, and `lost` for a dead pid.
- cost: the report adds sessions and writer attempts for each day, repo and task, and `--since` filters it.

### Manual (`e2e/observability.sh`, a stub claude, no tokens)

1. A stack of two. The stub task session sleeps past `AWB_TASK_TIMEOUT_MIN`. The task fails with "timeout after", and the notice command gets "stopped".
2. `awb retry` with a stub writer that sleeps past `AWB_WRITER_TIMEOUT_MIN`. The claim table says `test writer: timeout`.
3. Stop the daemon while a run is `running`, then start it. `awb run --wait` on the old run id shows `stopped (daemon restart)`, and the task is `failed`, not `doing`.
4. `awb cost --json` has the writer and session rows.
5. The task folder has `events.log` with the steps above.

# Logging, part 1: one structured local log (docs/TODO-logging.md)

## Brief

Replace `events.log` and the daemon `console.log` lines with one JSON-lines log, `AWB_HOME/logs/awb.jsonl`, and add `awb logs` to read it. Part 2 (Alloy, Loki and Grafana) waits for the four open questions in `docs/TODO-logging.md`.

## Changes

- `packages/daemon/src/log.ts`: `createLog(dir)` returns `log(level, source, event, fields)`. One JSON line for each call. It rotates at 50 MB and keeps 10 files. It never throws.
- The daemon opens one log in `main.ts` and passes it to the runner, the routes and the store recovery. The runner, prove, ship, sync, recovery and http errors use it.
- Remove `taskLog` and `events.log`. The task page reads the task's lines from the log.
- 5 silent catches log a `warn` line: the PR sync, the cost update, `onEnd`, the notice spawn and the log write itself (to stderr). The other 9 catches ignore an expected case and stay.
- `POST /api/log` takes a line from the CLI. The CLI sends its own errors there. If the daemon is down, the CLI writes to the file itself.
- `GET /api/logs?task&run&level&source&since&limit` and `awb logs [--task] [--run] [--level] [--source] [--since] [--follow] [--json]`.
- Redact secrets in each line with the same patterns as `findSecrets` in `ship.ts`.

## Tests

Unit:
- One valid JSON line for each call, with `ts`, `level`, `source` and `event`.
- Rotation keeps the newest 10 files.
- A secret in a field is redacted.
- The read filter selects by task, level (and above), source and time, and it reads across the rotated files.
- The runner logs `session.start`, `session.ended` and `task.failed` with the task id.

Manual:
- Run `awb run --wait` on a stub stack with a task that times out.
- `awb logs --task <id>` shows the path from `run.start` to `task.failed`.
- `awb logs --level error --since 1h` shows the failure.
- `awb logs --follow` prints new lines while a run goes on.

# Handoff (state at the end of the session, 2026-11-05)

The branch typechecks and 109 unit tests pass. `bash e2e/logging.sh` passes (a stub run, no tokens, about 70 s). The archived phase 7 stub check also passes against this code (prove, gate, runner and UI).

Done: logging part 1 (`log.ts`, every daemon part and the CLI log, `awb logs`, no delete by default, `AWB_LOG_KEEP_DAYS`), the session cost on `session.ended`, `infra/logging/` with its README, and the task time limit fix (the kill reaches the whole process group).

The logging stack runs in Docker (the user approved the start on 2026-11-05). `infra/logging/.env` has a random Grafana password; the deny rules block reading `.env`, so the user reads it. Alloy reads `~/.awb/logs`. Checked: Loki, Alloy and Grafana are ready; the lines reach Loki with the labels `host`, `job`, `level` and `source`; an outage test (Alloy stopped, 40 lines written, two new part files) delivers 50 of 50 lines, each once; every dashboard query runs. Log files are one per UTC day and are never renamed, because Alloy keys its read position by path (rename-based rotation lost 12 of 50 lines in the first outage test).

Decisions from the user: Loki and Grafana run on this local machine. Other computers reach Grafana through Tailscale. Logs are never deleted by default. Docker is acceptable. Ask the user before a new Docker start.

Not done:
1. Tailscale is not installed on this machine. Remote access is not tested. To open it: install Tailscale, set `GRAFANA_BIND` in `infra/logging/.env` to the Tailscale address, and run `docker compose -f infra/logging/docker-compose.yml up -d`.
2. The cost panel has no data until a real (not stub) session runs with this code.
3. The UI does not show the task log lines, `quiet` and `lost`, or USD yet (`docs/TODO.md` section 3).
