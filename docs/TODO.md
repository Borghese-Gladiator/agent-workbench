# TODO

v6 is a proof of concept. The acceptance test passes (`e2e/acceptance.sh`), but these items stand between it and an MVP.

## Gate

The gate proves a claim in a browser, or with a repo test for logic that no page shows.


## Test writer


## Runner

## Logging

The local log, `awb logs`, the Logs tab and the `awb doctor` checks are done. `infra/logging/README.md` has the Loki and Grafana design.

- [ ] **Run the Loki and Grafana stack once.** Run `docker compose -f infra/logging/docker-compose.yml up -d` and one awb task. Then `awb doctor` must show `alloy` and `loki` as ok. From a second computer on the tailnet, find the task in Grafana and see a live tail.
- [ ] **Outage test.** Stop Loki for 5 minutes during a run, then start it again. No log line is lost in Grafana.
- [ ] **Link from Grafana to the awb task page.** Add a Loki derived field in `grafana/provisioning/datasources/loki.yaml` that links a task id to `<awb UI>/#/task/<id>`. The "Failed tasks" panel must print `task=<id>` so that the link matches.
- [ ] **Empty catch blocks.** 13 `catch {}` blocks remain outside the UI. Most are expected failures: a JSON parse in a loop, a ready probe, or a kill of a process group that already exited. Log a `warn` line only where an error is not expected.
