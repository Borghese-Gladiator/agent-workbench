# Agent Workbench architecture

The first design is in `archive/v6-build/PROPOSAL.md`. This file shows the system as built.

## System

```mermaid
flowchart TB
  user([You: terminal and browser])

  subgraph sessions["Claude Code processes"]
    chat["Chat session<br/>awb = claude + playbook + hooks<br/>cwd = repo"]
    task["Stack task sessions<br/>awb -p<br/>cwd = task worktree"]
    writer["Test-writer session<br/>claude -p + Playwright agents<br/>cwd = task folder (real path)"]
  end

  subgraph clients["Clients"]
    cli["awb CLI<br/>--json, run through Bash"]
    hooks["Hook sender<br/>fire and forget"]
    ui["Web UI<br/>live feed (SSE)<br/>Live, Session, Stacks, PRs, Task, Logs"]
  end

  subgraph daemon["Daemon: one for each AWB_HOME, owns state and hard rules"]
    api["HTTP API"]
    store[("SQLite<br/>repos, sessions, events,<br/>stacks, tasks, attempts,<br/>gate results, PRs")]
    runner["Runner<br/>one task at a time in a stack<br/>up to AWB_MAX_STACKS stacks"]
    proof["Proof engine<br/>start app, start test writer,<br/>run tests"]
    gate["Gate<br/>pure proof rules"]
    shipper["Shipper and PR sync"]
    logger["Logger<br/>JSON lines"]
  end

  subgraph outside["Files and services"]
    home["$AWB_HOME/tasks/&lt;id&gt;/<br/>claims.md, proof-tests/,<br/>proof/, playwright.config.ts"]
    repo["Repo and worktrees<br/>feature code only"]
    app["App under test<br/>started from the run file<br/>AWB_HOME/repos/repo.run.md"]
    gh["GitHub<br/>branches, draft PRs,<br/>video assets"]
    logs["$AWB_HOME/logs/<br/>awb.YYYY-MM-DD.jsonl"]
    loki["Alloy, Loki, Grafana<br/>optional"]
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

  logger --> logs
  logs -.->|tail| loki
```

The test writer has no link to the repo. Its working folder is the task folder, so the Playwright save tools write there, and it cannot read the source. It reaches the app only through the URL.

Every part writes to the log. One file holds one UTC day. The Logs tab and `awb logs` read the files. `awb doctor` checks that Alloy and Loki are current when they run.

## Stack run: `awb run`

```mermaid
sequenceDiagram
  participant U as You or chat session
  participant D as Daemon
  participant R as Runner
  participant W as Task worktree
  participant S as Task session (awb -p)

  U->>D: awb run --wait
  D->>R: start the stack (refuse if AWB_MAX_STACKS is full)
  loop each waiting task, from the bottom up
    R->>W: git worktree add (task N starts from task N-1)
    R->>W: copy .env, run ## setup
    R->>S: start with the task prompt
    S->>D: awb prove, awb ship
    alt session ends on a transient API error
      R->>S: claude --resume (up to --retries times)
    end
    alt task has no PR at the end
      R->>D: task failed, stack stopped
    end
  end
  D-->>U: run done or stopped
```

`awb stop` ends the run and the proof of the current task. The task becomes `failed` with the reason `stopped by awb stop`, and the later tasks stay `waiting`. `awb retry` sets a failed task back to `waiting` and starts the runner again, in the same worktree and branch.

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
  opt run file has ## seed
    D->>D: build the seed once, cache it by hash of the script and key files
    D->>A: copy the cache for this proof
  end
  D->>A: start clean app at the commit (run file)
  alt claims with no proof test
    D->>W: claude -p --agents --mcp-config (headless)
    W->>F: read claims.md
    W->>A: browse, check each claim
    W->>F: write proof-tests/*.spec.ts
    opt a claim still has no test
      D->>W: run the writer once more for those claims
    end
  end
  D->>A: run the specs (@playwright/test, task config)
  A-->>F: report.json, videos, traces
  opt test claims
    D->>F: run the repo tests on the head, and on the base commit
  end
  opt stack
    D->>F: run the passing test claims of the tasks below
  end
  D->>F: gate reads the files on disk
  D-->>S: claim table
  S->>D: awb ship
  D->>F: gate runs again from disk
  alt gate passes
    D->>G: scan for secrets, push, upload videos, open draft PR
    D-->>S: PR URL
  else gate fails
    D-->>S: refusal and claim table
  end
```

The gate refuses in these cases:
- A claim has no test, or its test is skipped or not passed.
- A browser claim has no video or no trace.
- A test claim also passes on the base commit.
- A carried claim of a task below no longer passes.
- The commit or a proof test file changed after the run started, or the source has uncommitted changes.

The test writer runs under a time limit. In a task session, it gets only the time left in the task session.
