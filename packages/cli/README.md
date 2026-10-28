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

`AWB_HOME` defaults to `~/.awb`. Each `AWB_HOME` has its own daemon, database and `daemon.json`. For a dev instance, use `AWB_HOME=~/.awb-dev`.

A repo can replace the default playbook with `.awb/playbook.md`.

To test:

```sh
npm test
npm run typecheck
bash spikes/phase1/check.sh      # manual check with a stub claude, no tokens
```
