# Agent Workbench v6 architecture

These diagrams follow `PROPOSAL.md` sections 3 and 4. Section 6.3 holds the phase 0 facts that shaped them.

## System

```mermaid
flowchart TB
  user([You: terminal and browser])

  subgraph sessions["Claude Code processes"]
    chat["Chat session<br/>awb = claude + playbook + hooks<br/>cwd = repo"]
    task["Stack task sessions<br/>claude -p<br/>cwd = task worktree"]
    writer["Test-writer session<br/>claude -p + Playwright agents<br/>cwd = task folder (real path)"]
  end

  subgraph clients["Clients"]
    cli["awb CLI<br/>--json, run through Bash"]
    hooks["Hook sender<br/>fire and forget"]
    ui["Web UI<br/>live feed (SSE)"]
  end

  subgraph daemon["Daemon: one for each AWB_HOME, owns state and hard rules"]
    api["HTTP API"]
    store[("SQLite<br/>repos, sessions, events,<br/>stacks, tasks, attempts,<br/>gate results, PRs")]
    runner["Runner<br/>one task at a time"]
    proof["Proof engine<br/>start app, start test writer,<br/>run tests"]
    gate["Gate<br/>pure proof rules"]
    shipper["Shipper and PR sync"]
  end

  subgraph outside["Files and services"]
    home["$AWB_HOME/tasks/&lt;id&gt;/<br/>claims.md, proof-tests/,<br/>proof/, playwright.config.ts"]
    repo["Repo and worktrees<br/>feature code only,<br/>.awb/playbook.md, .awb/run.md"]
    app["App under test<br/>started from .awb/run.md"]
    gh["GitHub<br/>branches, draft PRs,<br/>video assets"]
  end

  user --> chat
  user --> ui
  chat --> cli
  task --> cli
  chat -.-> hooks
  task -.-> hooks
  writer -.-> hooks

  cli -->|HTTP| api
  hooks -->|HTTP, events| api
  ui <-->|HTTP and SSE| api

  api --> store
  runner -->|starts| task
  proof -->|starts| writer
  proof -->|starts| app
  proof --> gate
  gate --> store
  shipper --> gate
  shipper --> gh

  writer -->|browser through URL| app
  writer -->|writes specs| home
  proof -->|runs specs, reads evidence| home
  task -->|edits code| repo
  runner -->|creates worktree| repo
```

The test writer has no link to the repo. Its working folder is the task folder, so the Playwright save tools write there, and it cannot read the source. It reaches the app only through the URL.

## Proof flow: `awb prove` and `awb ship`

```mermaid
sequenceDiagram
  participant S as Task session (cwd = repo)
  participant D as Daemon
  participant A as App
  participant W as Test writer (cwd = task folder)
  participant F as Task folder
  participant G as GitHub

  S->>D: awb prove
  D->>A: start clean app at the commit (.awb/run.md)
  alt no proof tests yet
    D->>W: claude -p --agents --mcp-config (headless)
    W->>F: read claims.md
    W->>A: browse, check each claim
    W->>F: write proof-tests/*.spec.ts
  end
  D->>A: run the specs (@playwright/test, task config)
  A-->>F: report.json, videos, traces
  D->>F: gate reads the files on disk
  D-->>S: claim table
  S->>D: awb ship
  D->>F: gate runs again from disk
  alt gate passes
    D->>G: push, upload videos, open draft PR
    D-->>S: PR URL
  else gate fails
    D-->>S: refusal and claim table
  end
```

## Phase 1 scope

Phase 1 builds only part of the system diagram:

```mermaid
flowchart LR
  awb["awb launcher"] -->|finds or starts| daemon["daemon<br/>$AWB_HOME/daemon.json"]
  awb -->|registers, ends| sessions[("SQLite<br/>repos, sessions")]
  awb -->|spawns| claude["claude<br/>--append-system-prompt playbook<br/>--settings hooks<br/>AWB_HOME in env"]
  daemon --- sessions
  ui["awb ui<br/>session list page"] --> daemon
  doctor["awb doctor"] -->|checks| claude
  doctor -->|checks| chromium["Chromium"]
  doctor -->|checks| daemon
```
