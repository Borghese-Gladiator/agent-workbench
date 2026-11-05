# awb logging stack

Loki, Grafana and Alloy in Docker on the awb machine. Other computers open Grafana through Tailscale.

awb does not need this stack. awb always writes its log to `AWB_HOME/logs/awb.jsonl` first, and `awb logs` reads that file. This stack only copies the lines to Loki, so that Grafana can show them from another computer.

| Service | Image | Port | Job |
| --- | --- | --- | --- |
| loki | `grafana/loki:3.7.9` | `127.0.0.1:3100` | Stores the logs. No retention: it never deletes a line. |
| alloy | `grafana/alloy:v1.21.3` | `127.0.0.1:12345` | Reads `awb*.jsonl` and sends new lines to Loki. Its page on port 12345 shows its state. |
| grafana | `grafana/grafana:13.3.0` | `GRAFANA_BIND:3000` | The view, with the "awb" dashboard. |

## Start

1. Install Tailscale on this machine and on each computer that must see the logs, and log in to the same tailnet:
   ```sh
   brew install --cask tailscale
   ```
   Open the Tailscale app and log in. Then find this machine's Tailscale address:
   ```sh
   tailscale ip -4
   ```
2. Copy the settings file and fill it in:
   ```sh
   cp infra/logging/.env.example infra/logging/.env
   ```
   - `GRAFANA_PASSWORD`: the Grafana admin password. Grafana does not start without it.
   - `GRAFANA_BIND`: the Tailscale address from step 1, for example `100.101.102.103`. With the default `127.0.0.1`, only this machine can open Grafana.
   - `AWB_LOGS`: the folder with `awb.jsonl`. Change it only if `AWB_HOME` is not `~/.awb`.
   - `AWB_HOST`: a name for this machine in Grafana.
3. Start the stack:
   ```sh
   docker compose -f infra/logging/docker-compose.yml up -d
   ```
4. Open `http://<GRAFANA_BIND>:3000` from a computer on the tailnet. Log in as `admin` with your password. Open the dashboard "awb".

Never set `GRAFANA_BIND` to `0.0.0.0`. That opens Grafana to every network that this machine is on.

## Check

```sh
curl -s 127.0.0.1:3100/ready
curl -s 127.0.0.1:3100/loki/api/v1/labels
curl -s 127.0.0.1:12345/-/ready
```

Loki answers `ready`, and the label list has `host`, `job`, `level` and `source` after awb writes its first line.

## When Docker is not running

No log is lost. awb writes to the local file, and `awb logs` still works. From another computer, run `ssh <this machine> awb logs`. When Docker starts again, Alloy sends the lines that it missed:

- Alloy keeps its read position in the `alloy-data` volume.
- Alloy reads the rotated files (`awb.<time>.jsonl`) too.
- Loki accepts old lines (`reject_old_samples: false`).
- Alloy sets each entry's time from its `ts` field and has no file name label. So if Alloy reads a line twice (for example, after a log file rotates), Loki drops the second copy.

## Stop and remove

```sh
docker compose -f infra/logging/docker-compose.yml down
```

This keeps the data volumes. `down -v` also deletes them, which deletes the copy in Loki. The local `awb.jsonl` files are not touched.

## Queries

The labels are `host`, `job`, `level` and `source`. The ids are in the JSON body, so filter them with `| json`:

```
{job="awb", level="error"}
{job="awb"} | json | task=~"0e751a8c.*"
{job="awb", source="runner"} | json | event="task.failed"
```
