# Agent Workbench

`awb` starts `claude` in your repo with a short playbook. The agent writes claims for a feature, writes the code, and runs `awb prove`. An independent session then writes Playwright tests from the claims, and a gate in code runs them. `awb ship` opens a draft PR with a video for each claim. If a claim does not pass, no PR opens.

- `packages/cli`: the `awb` command and the playbook. Start with [its README](packages/cli/README.md).
- `packages/daemon`: one local process with SQLite, the gate, the stack runner and the web UI.
- `docs/architecture.md`: the diagrams. `docs/TODO.md`: the work to an MVP.
- `e2e/acceptance.sh`: the end-to-end test with the real `claude` and GitHub.
- `archive/`: v1 to v5, and the v6 build notes.
