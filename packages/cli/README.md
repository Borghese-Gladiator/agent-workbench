# awb

Needs Node 24 or later. There is no build step: Node runs the TypeScript files directly.

```sh
npm install                      # dev tools only (typescript, @types/node)
alias awb="$PWD/packages/cli/bin/awb"
awb doctor                       # checks claude, Chromium and the daemon
awb                              # opens claude in the current repo
awb ui                           # opens the session list in the browser
```

| Command | What it does |
|---|---|
| `awb [claude args]` | Starts the daemon if it is not up, registers a session, and starts `claude` with the playbook and `AWB_HOME`. Every argument goes to `claude`. |
| `awb ui [--no-open]` | Prints the UI URL and opens it. |
| `awb sessions [--json]` | Lists the sessions. |
| `awb doctor` | Checks the setup and prints a fix for each problem. |
| `awb daemon start\|stop\|status` | Controls the daemon of the active `AWB_HOME`. |
| `awb stack set [--json]` | Reads a stack as JSON on stdin and creates or replaces it. A stack of one binds to the current branch. |
| `awb prove [--json]` | Starts the app from `.awb/run.md`, writes the missing proof tests with a fresh test-writer session, runs them, and runs the gate. Prints the claim table. Exits 1 if the gate fails. |
| `awb show [--json]` | Shows the task on the current branch, its claims and every gate result. |

`AWB_HOME` defaults to `~/.awb`. Each `AWB_HOME` has its own daemon, database and `daemon.json`. For a dev instance, use `AWB_HOME=~/.awb-dev`.

A repo can replace the default playbook with `.awb/playbook.md`.

`awb` passes hooks to `claude` with `--settings`. Each hook runs `bin/awb-hook`, which sends the hook JSON to the daemon of `AWB_HOME` for the session in `AWB_SESSION_ID`. The sender prints nothing, waits at most 1 s, and always exits 0. If the daemon is down, the event is dropped and the chat continues. On `Stop` and `SessionEnd`, the daemon reads the token totals from the transcript file that the hook names. The UI page gets live updates from `/api/feed` (server-sent events).

To test:

```sh
npm test
npm run typecheck
bash spikes/phase1/check.sh      # manual check with a stub claude, no tokens
bash spikes/phase2/check.sh      # live feed check with the real claude (haiku)
```
