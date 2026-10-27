# @workbench/mcp

A stdio [MCP](https://modelcontextprotocol.io) server that exposes the Agent
Workbench daemon's HTTP API as tools, so a local Claude session (or the demo
driver) can create and steer tasks natively instead of shelling out to `wb`.

It is a thin wrapper over [`@workbench/client`](../client) — the same typed
client the web app and `wb` CLI use. The only non-trivial logic is
`wait_for_run`, which rides the daemon's per-run SSE stream
(`finished` / `idle` / `fallback`, never throws).

## Configuration

| Env | Default | Meaning |
| --- | --- | --- |
| `WORKBENCH_URL` | `http://127.0.0.1:4417` | Base URL of the daemon to drive. |

Point it at your **real** daemon (`pnpm daemon`, port 4417) for your own
sessions. The demo driver (`scripts/drive.mjs`) instead points it at the
throwaway daemon it spawns, so demo runs never touch your real task list or DB.

## Tools

Reads: `list_projects`, `list_tasks`, `get_task` (full joined bundle),
`get_artifact`, `worktree_diff`, `get_active_run`, `get_run`,
`unanswered_questions`.

Actions: `create_project`, `create_task`, `do_action` (generic gate driver —
`generate-brief`, `approve-brief`, `reject-brief`, `approve-plan`, …),
`abandon_task`, `answer_question`, and `wait_for_run` (block until the
in-flight run finishes).

All tools are exposed unconditionally — this is a single-user local tool with
no capability gate, so a session can create/drive/abandon real tasks.

## Use from a local Claude session

The repo ships an [`.mcp.json`](../../.mcp.json) registering this server against
the real daemon. Start the daemon, then a Claude session in this repo can call
the tools directly:

```bash
pnpm daemon            # real daemon on :4417 (data/workbench.sqlite)
# in a Claude session: create_task -> do_action generate-brief -> wait_for_run -> get_task
```

## Run standalone

```bash
WORKBENCH_URL=http://127.0.0.1:4417 pnpm --filter @workbench/mcp dev
```
