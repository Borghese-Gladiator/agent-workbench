# TODO: logging, local first, viewable from another computer

Status: part 1 is built and tested (`e2e/logging.sh`). Part 2 is written in `infra/logging/` but has not run. Part 3 is not started.

## Goal

- Every part of awb writes structured logs to one local place. The parts are the daemon, the runner, `awb prove`, `awb ship`, the PR sync and the CLI.
- The logs stay on the machine that runs awb. awb works with no network and no extra service.
- You can read and search the logs from another computer, for example a laptop when the runs happen on a desktop.
- An error is never ignored. Each place that catches an error writes a log line.

## What exists today (and why it is not enough)

| Source | Where it goes | Problem |
| --- | --- | --- |
| Daemon `console.log` | `AWB_HOME/daemon.log` | Plain text, no level, no task id |
| CLI errors | the terminal of the command | Lost when the terminal closes |
| `events.log` (this branch) | each task folder | A text copy of part of the database. No query. Tasks only. |
| 14 `catch {}` blocks | nowhere | Silent failures, for example the PR sync |
| Session transcripts, `writer.jsonl`, `run.log`, `setup.log` | the task folder | Good raw evidence. Keep them. They are not logs. |

The database tables (`runs`, `attempts`, `gate_results`) are the state. They stay. The log is the history of what happened and why.

## Decision: Grafana Alloy, Loki and Grafana (not Promtail)

Promtail is end of life since 2026-03-02. Grafana Alloy replaces it, and Alloy can convert a Promtail config. So the plan uses Alloy as the log shipper.

| Part | Runs where | Job |
| --- | --- | --- |
| awb | the awb machine | Writes JSON lines to `AWB_HOME/logs/awb.jsonl` |
| Alloy | the awb machine | Tails the file, adds labels, sends to Loki. If Loki is down, it keeps a buffer and sends later. |
| Loki | a log server (the same machine, or another one) | Stores and indexes the logs |
| Grafana | the log server | The view from any computer: search, filters, live tail, a dashboard |

awb itself knows nothing about Alloy or Loki. It only writes a local file. So the remote stack is optional, and you can replace it later (for example with an OpenTelemetry collector) without a change to awb.

### Other options (and why not now)

- **Serve the logs from the awb daemon over the network.** It is the least infrastructure, but the daemon listens only on 127.0.0.1 and has no login. To open it to other computers, it needs authentication and TLS. This is more security risk in awb itself. Do this only if the user does not want a separate log server.
- **OpenTelemetry (OTLP) from awb to a collector.** v5 did this for traces. It adds a dependency to awb and needs a collector to start. Alloy can take OTLP later if traces come back.
- **A hosted service (Grafana Cloud, Datadog).** It needs no server, but the logs leave your network. That conflicts with "stored locally". It is possible later as a second Alloy output.

## Plan

### Part 1: one structured log in awb (no infrastructure)

1. Add `packages/daemon/src/log.ts` with one function:
   `log(level, source, event, fields)`. The levels are `debug`, `info`, `warn` and `error`. The fields can be `task`, `run`, `session`, `repo`, `stack`, `attempt`, `ms` and `error`.
2. Each call writes one JSON line to `AWB_HOME/logs/awb.jsonl`. Example:
   ```json
   {"ts":"2026-11-03T16:12:04.120Z","level":"error","source":"runner","event":"session.ended","task":"0e751a8c","run":"7f2c...","repo":"games","how":"timeout after 45 min"}
   ```
3. Rotate the file: at 50 MB, rename it to `awb.<time>.jsonl` and start a new one. Keep every rotated file. The expiration setting `AWB_LOG_KEEP_DAYS` exists, but its default is "none". Use no new dependency. (Done.)
4. Replace `taskLog` and `events.log` with `log()`. The task folder keeps the raw evidence files only.
5. Replace each `console.log` and `console.error` in the daemon with `log()`. `daemon.log` then holds only the crash output from Node.
6. Change each of the 14 `catch {}` blocks to log a `warn` line, with the error message.
7. Let the CLI send its errors to the daemon with `POST /api/log`. If the daemon is down, the CLI writes to the same file itself.
8. Add `awb logs [--task <id>] [--run <id>] [--level warn] [--source runner] [--since 1h] [--follow] [--json]`. It reads the local file, so it works without Loki.
9. Never log secrets or the full prompt text. The daemon already scans for secrets before a push (`findSecrets` in `ship.ts`). Use the same scan on the `error` field.

Event names to start with:

| Source | Events |
| --- | --- |
| daemon | `start`, `stop`, `recover` |
| runner | `run.start`, `run.end`, `session.start`, `session.ended`, `task.failed` |
| prove | `start`, `app.ready`, `writer.start`, `writer.ended`, `playwright.done`, `gate` |
| ship | `start`, `push`, `pr`, `upload`, `refused` |
| sync | `pr.state`, `error` |
| http | `error` (each route error, with the path and the status) |
| cli | `error` (the command and the message) |

Tests:
- Unit: `log()` writes one valid JSON line. Rotation keeps the newest 10 files. A `catch` path writes a `warn` line. `awb logs` filters by task, level and time.
- Manual: run `e2e/acceptance.sh single` and check that `awb logs --task <id>` shows the full path from `session.start` to `ship.pr`.

### Part 2: view the logs from another computer

1. Add `infra/logging/` to this repo:
   - `docker-compose.yml` with Loki and Grafana. Pin the image versions.
   - `loki.yaml`: one local storage, no retention period (logs are never deleted).
   - `grafana/provisioning/`: the Loki data source and one dashboard, "awb".
   - `alloy/config.alloy`: tail `AWB_HOME/logs/awb*.jsonl`, read the JSON, and send to Loki.
2. Labels must stay few, because each new label value makes a new Loki stream. Use these labels: `host`, `level` and `source`. Put `task`, `run`, `repo` and `session` in the JSON body, and filter them in LogQL with `| json`.
3. The "awb" dashboard:
   - Errors and warnings over time, by source.
   - The newest errors, with a link from the task id to the awb task page.
   - Failed tasks, with their reasons.
   - Cost per day, from the `run.end` and `writer.ended` events. The events carry `usd`.
4. Add `awb doctor` checks: Alloy is running, and its last send to Loki worked.
5. Network access from another computer. Choose one, and document it in `infra/logging/README.md`:
   - **Tailscale (recommended).** Grafana listens only on the Tailscale address. No port opens to the internet, and Tailscale gives the login.
   - **The same LAN.** Grafana with its own login, on the LAN address. Never open it to the internet.
   - **An SSH tunnel.** `ssh -L 3000:localhost:3000 <host>`. No setup, but not for a team.
6. The Loki server can run on the awb machine or on another machine. If Loki runs on another machine, Alloy sends to it over Tailscale. When the link is down, Alloy buffers the logs and sends them later, and the local file is still complete.
7. **When Docker is not running, no log is lost.** awb writes to the local file and never needs Docker. `awb logs` still works on this machine, and from another computer with `ssh <host> awb logs`. Only Grafana is not available. When Docker starts again, Alloy sends the lines that it missed. Three settings make this work:
   - **Alloy keeps its read position on a Docker volume.** Mount a named volume at the Alloy storage path (`--storage.path`). Without it, a restart loses the position, and Alloy sends every line again or skips the gap.
   - **Alloy reads the rotated files too.** Tail `awb*.jsonl`, not only `awb.jsonl`. A rotated file gets a fixed name with a time (`awb.<time>.jsonl`) and is never renamed again, so Alloy reads each line once. Otherwise Alloy misses the lines of a file that rotated during the outage.
   - **Loki accepts old lines.** Set `limits_config.reject_old_samples: false` in `loki.yaml`. The default rejects lines older than about one week, so a long outage would leave a gap in Grafana.

Tests:
- Manual: start the stack with `docker compose up`. Run one awb task. From a second computer on the tailnet, open Grafana. Find the task by id, and see a live tail during a run.
- Manual: stop Loki for 5 minutes during a run, then start it again. No log lines are lost.

### Part 3 (later): the awb web UI reads the same logs

- A "Logs" tab in the awb UI reads `awb.jsonl` through `GET /api/logs` (local view, no Loki).
- The task page shows the log lines of that task.
- Optional: a link from each task page to the same query in Grafana.

## Decisions (from the user, 2026-11-03)

1. Loki and Grafana run on this local machine, the same machine as awb. Other computers reach Grafana through Tailscale. There is no cloud server.
2. Tailscale is the access path. Grafana listens only on the Tailscale address.
3. Never delete logs for now. Build an expiration setting, but its default is "none": `log.ts` keeps every rotated file, and Loki has no retention period.
4. Docker is acceptable for Loki and Grafana.

## Sources

- [Promtail agent (Grafana docs, end of life notice)](https://grafana.com/docs/loki/latest/send-data/promtail/)
- [Loki issue on the Promtail deprecation](https://github.com/grafana/loki/issues/16929)
- [Migrating from Promtail to Alloy (DEV Community)](https://dev.to/irinobservability/migrating-from-promtail-to-alloy-for-log-collection-18j2)
