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
