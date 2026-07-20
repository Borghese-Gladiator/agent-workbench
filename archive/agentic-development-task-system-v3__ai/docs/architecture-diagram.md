# Architecture diagram

Visual companion to [`architecture.md`](../architecture.md). That file is the prose
("why"); this file is the picture ("what talks to what"). Source of truth for the
lifecycle FSM is [`agent-workbench-live/schemas/transitions.yaml`](../agent-workbench-live/schemas/transitions.yaml).

## 1. System layers

How a human request flows down through the workbench and out into a product repo.
The workbench owns orchestration; the product repo only ever sees a finished feature branch.

```mermaid
flowchart TB
    subgraph human["👤 Human"]
        H1["raw idea / approval / accept-or-bounce"]
    end

    subgraph session["Claude Code session (the orchestrator / master)"]
        direction TB
        SC["Slash commands<br/>.claude/commands/*.md<br/>/new-run /shape /plan /start<br/>/validate /followups /complete /bounce /abandon"]
        SUB["Subagents (Agent tool)<br/>Explore · Plan · general-purpose<br/>spawned for parallel work, return findings"]
        SC -. spawns .-> SUB
    end

    subgraph cli["agent-workbench CLI (bin/ + lib/)"]
        direction TB
        TE["Transition engine<br/>lib/transitions.py<br/>(only writer of status)"]
        RS["Run store<br/>lib/runs.py · metadata.py · events.py"]
        RW["Repo / worktree manager<br/>lib/repos.py"]
        CTX["Stage context builders<br/>lib/*_context.py"]
        AUD["Audit / metrics<br/>lib/audit.py · metrics/"]
    end

    subgraph store["Run artifacts (file-persistent memory)"]
        direction TB
        META["runs/&lt;id&gt;/metadata.yaml<br/>(canonical state)"]
        EVT["runs/&lt;id&gt;/events.jsonl<br/>(append-only audit)"]
        ART["runs/&lt;id&gt;/*.md<br/>brief · plan · decisions · review · audit · handoff"]
    end

    subgraph product["Product repo (downstream consumer)"]
        direction TB
        REPO["source checkout<br/>(lives anywhere)"]
        WT["worktrees/&lt;repo&gt;/&lt;name&gt;/<br/>isolated feature branch<br/>← all implementation happens here"]
        REPO -- "git worktree add" --> WT
    end

    H1 --> SC
    SC --> TE & RW & CTX
    TE --> RS
    RS --> META & EVT
    CTX --> ART
    TE --> EVT
    RW --> WT
    AUD --> ART
    META -. read by .-> CTX

    classDef owned fill:#e8f0fe,stroke:#4285f4;
    classDef ext fill:#fff4e5,stroke:#f5a623;
    class session,cli,store owned;
    class product ext;
```

**Reading it:** the human only touches the session. The session's slash commands
call the CLI. The transition engine is the *only* writer of `status` and the *only*
appender of `TransitionApplied` — that keeps lifecycle state single-threaded. Context
builders read `metadata.yaml` and emit markdown artifacts. The product repo never
imports the workbench; it just receives a worktree on a feature branch.

## 2. Lifecycle state machine

Exactly mirrors `schemas/transitions.yaml`. Solid arrows are the happy path; each
edge requires its listed **evidence** before the engine will apply it. `abandoned`
is reachable from *any* non-terminal state (wildcard). `done` and `abandoned` are
terminal and preserve all artifacts.

```mermaid
stateDiagram-v2
    [*] --> draft

    draft --> shaping: raw_idea_path
    shaping --> planning: brief_path
    planning --> ready: plan + assumptions +<br/>decisions + preflight +<br/>repo/worktree/branch
    ready --> building: approved_by<br/>(human gate)<br/>⟹ WorktreeCreated
    building --> validating: impl_summary +<br/>diff_summary + iterations
    validating --> followups: review + qa + audit<br/>(staged layout)
    validating --> human_review: review + qa + audit +<br/>handoff (flat/legacy)
    followups --> human_review: followups +<br/>handoff
    human_review --> done: accepted_by +<br/>completion_ref<br/>⟹ RunCompleted
    human_review --> building: bounce_reason<br/>⟹ BounceRequested

    state "abandoned (from any<br/>non-terminal · wildcard)" as abandoned
    draft --> abandoned
    building --> abandoned
    validating --> abandoned

    done --> [*]
    abandoned --> [*]

    note right of ready
        Human gates: /start (ready→building)
        and /complete | /bounce | /abandon.
        Everything else auto-chains.
    end note
```

## 3. Slash command → stage → artifact mapping

Which command drives each transition, whether it carries an LLM, and what it writes.
LLM-bearing stages auto-chain (`/new-run → /shape → /plan`); the rest are thin
deterministic transitions plus the two human gates.

```mermaid
flowchart LR
    NR["/new-run"]:::thin --> SH["/shape 🧠"]:::llm
    SH --> PL["/plan 🧠"]:::llm
    PL --> ST["/start ✋"]:::gate
    ST --> BUILD["build in worktree 🧠"]:::llm
    BUILD --> VAL["/validate 🧠"]:::llm
    VAL --> FU["/followups 🧠"]:::llm
    FU --> CMP["/complete ✋"]:::gate
    CMP -. bounce .-> BO["/bounce ✋"]:::gate
    BO -. back to .-> BUILD
    NR -. any time .-> AB["/abandon ✋"]:::gate

    SH -.writes.-> a1["brief.md"]
    PL -.writes.-> a2["plan · preflight ·<br/>assumptions · decisions"]
    VAL -.writes.-> a3["review · qa/report ·<br/>audit · handoff"]
    FU -.writes.-> a4["followups.md"]

    classDef thin fill:#eee,stroke:#999;
    classDef llm fill:#e6f4ea,stroke:#34a853;
    classDef gate fill:#fce8e6,stroke:#ea4335;
```

Legend: 🧠 LLM-bearing (Skill/subagents) · ✋ human gate · plain = deterministic plumbing.

## Cross-references

- Prose rationale & design goals — [`architecture.md`](../architecture.md)
- Lifecycle narrative — [`docs/lifecycle.md`](lifecycle.md)
- In-run discipline (who may write status, only-`draft`-asks-questions) — [`agent-workbench-live/AGENTS.md`](../agent-workbench-live/AGENTS.md)
- FSM source of truth — [`agent-workbench-live/schemas/transitions.yaml`](../agent-workbench-live/schemas/transitions.yaml)
- Context library index — [`agent-workbench-live/context/README.md`](../agent-workbench-live/context/README.md)
