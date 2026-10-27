# External references — adopt / steal-idea / decline (2026-08)

Deliverable for **TASK-100** (Group R). Each reference below gets a one-line
**call** (`adopt` / `steal-idea` / `decline` / `reference-only`) and a rationale
mapping to an existing task, learning, or ADR. This is a research writeup, not a
build task; any idea worth doing is flagged as a **candidate task**.

## Standing invariants used as the decision frame

These are the workbench's committed positions; a reference that requires
reopening one of them is declined at the writeup level (it would need an ADR
first, not a task):

- **Five-plane architecture** — the workbench already *is* four of the five
  planes; the missing GRAPH plane is spiked, not built (`ADR-009`,
  `graph-engineering-five-planes` learning).
- **Read-only board, no draggable kanban** — TASK-83 board is
  `deriveTaskStatus`-driven; drag-to-plan explicitly declined (TASK-87).
- **No-subagent policy** — deliberate (TASK-97).
- **Project-memory-as-markdown, repo-is-truth** — memory is invalidated against
  the repo, never the reverse; `AgentMemory` declined (`ADR-009`,
  `project-memory-design`).
- **No vector database** (`AGENTS.md:162`), no Postgres/Redis/K8s/message queue.
- **SQLite single-writer** (daemon-owned) is a firm invariant.
- **Temporal deterministic workflows** for the phase model.

Legend: **adopt** = wire it in; **steal-idea** = take one bounded idea, not the
dependency; **decline** = no action, conflicts with an invariant or already
covered; **reference-only** = read, nothing to do.

---

## Orchestration / frameworks

### Vibe Kanban — `decline`
Beyond draggability it surfaces per-agent live-status columns and a "which agent
is doing what right now" orchestration view. Our board is intentionally
read-only (TASK-83) and drag-to-plan is declined (TASK-87). The one thing it has
that we lack is a **multi-agent concurrency view** — but that only matters under
a subagent/agent-team model we've deliberately declined (TASK-97). No new work.

### ruflo (`ruvnet/ruflo`) — `decline`
Prompt/agent-flow orchestration built on ad-hoc chaining and swarm patterns. Our
orchestration is Temporal deterministic workflows + the fixed phase model, which
gives durable state, replay, and single-writer guarantees ruflo's in-memory
flows don't. Nothing to steal that Temporal + `run-phase` doesn't already give
us. Maps to the Temporal invariant.

### Agentic frameworks 2026 survey (JetBrains) — `reference-only`
Landscape read (LangGraph, CrewAI, AutoGen, ADK, etc.). No single pattern to
adopt; the survey mostly confirms our positions (durable workflow engine, typed
state, tool brokering). Grade-yourself input for the ByteByteAI mapping below.

### "Build a software factory with Claude Code" (freeCodeCamp) — `steal-idea`
Same control-plane framing as Group O (a repeatable pipeline of skills/agents
producing PRs). Idea worth stealing: the **explicit "factory" run-report** that
summarizes what the pipeline produced across a batch of tasks — a rollup view.
We already have `task_summary` projection (`ui-roadmap-phase0-progress`); the
gap is a *cross-task* factory rollup. **Candidate task (low priority):** a
batch/factory rollup view over `task_summary`. Otherwise our control-plane
framing is ahead of the article.

### Conductor (`conductor-oss/conductor`) — `steal-idea`
Mature workflow-orchestration engine (task workers, retries, decision tasks).
We committed to Temporal (bias: ideas, not a swap). Idea worth noting: its
**operator UI for inspecting a running workflow's task DAG** is richer than ours.
Maps to the observability/board work, not an engine change. No new task beyond
what TASK-79 observability already covers.

### microsoft/agent-framework — `reference-only`
Merges Semantic Kernel + AutoGen; typed agents, middleware, workflow graphs.
Confirms the "durable workflow + typed tool contracts" direction we already
have. Nothing bounded to steal that Temporal + our RuntimeProfile don't cover
(`runtime-profile-architecture`).

### deep-agents-from-scratch (`langchain-ai`) — `steal-idea`
Teaching repo for planning + sub-task decomposition + a virtual filesystem for
agent scratch state. The **planning/decomposition** idea we already have as the
stacked-PR DAG (`decompose-into-dag` skill, TASK-51 sizing). The one idea worth
noting: an explicit **agent scratchpad / TODO file the agent maintains** during a
long run. We approximate this with plan artifacts; a persisted per-run scratchpad
could reduce cold re-entry (`qa-cold-reentry-nonconvergence`). **Candidate task
(low):** persisted per-run agent scratchpad. Decline the subagent framing.

### Google ADK — `reference-only`
Google's agent dev kit (tools, sessions, evals, deploy to Vertex). Cloud/deploy
surface is out of scope; its **eval harness** is the interesting part but overlaps
our QA gates (TASK-90/91) and adversarial self-review. Nothing to adopt now.

### open-interpreter — `decline`
Local code-execution agent (natural language → runs code on your machine). Our
execution is worktree-confined behind the capability broker
(`monitor-tool-escapes-readonly-deny`); open-interpreter's "run anything locally"
model is the opposite of our confinement posture. No action.

### open-agents.dev — `reference-only`
Directory/marketplace of open agents. Discovery resource, no pattern to adopt.

---

## Memory

### Memory-OS (6-layer memory on Hermes) — `steal-idea`
Layered memory (short-term → mid-term → long-term with promotion/eviction).
Directly relevant to `ADR-009` and `project-memory-design`. We decline the
runtime memory *store* (repo-is-truth, markdown, no `AgentMemory`), but the
**promotion/eviction lifecycle** (when a fact graduates from session → project
memory, and when it's evicted) is a real gap — today memory is written at
closeout with no eviction policy. **Candidate task:** define a memory
promotion/eviction policy for the markdown project-memory file (extends ADR-009,
does not reopen it — still markdown, still repo-is-truth).

### LLM Wiki v2 (extends Karpathy's LLM Wiki) — `steal-idea`
Karpathy's note is already our reference architecture
(`graph-engineering-five-planes`). v2 adds **agentmemory lessons**: treating the
wiki as an agent-maintained, cross-run knowledge base with explicit provenance
links. Provenance is exactly the missing GRAPH plane (`ADR-009` spike). Confirms
the ADR-009 direction; the bounded steal is **provenance edges on memory
entries** (which run/task produced a fact). Folds into the GRAPH-plane spike, no
new task.

### auto-memory ("re-explaining my code 68 min/day") — `steal-idea`
The pain it solves — re-explaining the codebase every session — is exactly what
project-memory + discovery is for (`project-memory-design`). Its automation idea:
**auto-capture repo facts on first touch** rather than only at closeout. We write
memory at closeout; auto-capturing high-signal facts earlier would cut cold
re-entry (`qa-cold-reentry-nonconvergence`). Overlaps the Memory-OS candidate
above; track together.

### autoagent memory (`hkuds/autoagent`) — `steal-idea`
Its memory design is a **fine-grained, typed memory graph** (entities, relations)
maintained automatically. The graph shape maps to our GRAPH-plane spike
(`ADR-009`); the automatic-maintenance idea maps to auto-memory above. Decline
the vector/embedding retrieval layer it pairs with (invariant `AGENTS.md:162`).
No new task beyond the GRAPH-plane spike + memory-lifecycle candidate.

### AnythingLLM memory — `steal-idea (bounded)`
Vector-store RAG over documents. **Conflicts with the no-vector-DB invariant
(`AGENTS.md:162`) and ADR-009 (repo-is-truth).** Standing bias holds: steal an
idea at most, do not adopt the dependency. The one idea: its **document-scoping
UX** (pin which docs are "in context" for a session). We can achieve the same
with explicit context selection (blast-radius, TASK-74) without embeddings.
Replacing markdown memory with this would require reopening ADR-009 — not filed.

### turbovec (vector search) — `decline`
Fast local vector search. Same caveat as AnythingLLM — vector search conflicts
with `AGENTS.md:162`. Read-only; do not add the dependency. Retrieval is served
by blast-radius/lazy-loading (TASK-74), not embeddings.

---

## Tooling / ingestion / observability

### design.md — `steal-idea`
`design.md` / getdesign.md: a structured design-spec file that conditions UI
generation. Directly feeds **TASK-99** (`build-ui` skill) and the Group-O UI work
(`ui-redesign-decisions`). Worth an experiment: does feeding a `design.md`
(tokens, layout, light/dark rules) measurably improve from-scratch UI output vs.
the current skill prompt? **Flag on TASK-99** as the concrete thing to test; not
a separate task.

### markitdown (`microsoft/markitdown`) — `steal-idea`
Converts docs/PDF/office/assets → Markdown for context ingestion. We hit exactly
this pain converting the Karpathy PDF via pdfminer
(`group-e-token-memory-graph`). markitdown is a cleaner, format-general ingestion
front-end for context. **Candidate task (low):** evaluate markitdown as the
context-ingestion converter (PDF/docx/pptx → md) in place of ad-hoc pdfminer.
Bounded, no invariant conflict.

### "MCP server that made developers faster" (Medium) — `steal-idea`
MCP-server design patterns (tight tool surface, token-efficient responses).
Relates to the **MCP-token-savings ask (TASK-95)** and the tool-output
compression finding (`group-e-token-memory-graph`: cost is in-session context,
not preamble). Reinforces TASK-95's direction (compress tool outputs); no new
task.

### Sandcastle (sandboxing/isolation) — `steal-idea`
Sandboxed execution/isolation. Compare to our capability-broker + worktree
confinement, which is **`native-trusted`, explicitly NOT a hostile-code sandbox**
(`AGENTS.md` known-gaps, `monitor-tool-escapes-readonly-deny`). Sandcastle's OS-
level isolation is the mitigation for the known gap if we ever need to run
untrusted repos. Bounded steal: its **isolation boundary model** as the design
reference if/when hostile-code sandboxing is prioritized. **Candidate task
(deferred):** OS-level sandbox for untrusted repos — only if the trust model
changes. Not needed under `native-trusted`.

### Self-built observability writeup (doneyli substack) — `reference-only`
One dev's OTel/traces/metrics build. We already have three-channel observability:
`packages/telemetry` OTel spans + `packages/database`
`runtime_attribution`/`context_composition` + trace-per-run
(`observability-live-proof`, `trace-per-run`, TASK-79). The article confirms our
approach; note the known gaps we already filed (Group AB:
`context_composition` is a chars/4 estimate not measured tokens — TASK-109). No
new adoption.

### SQLite vs Beads — `decline`
Beads as an alternative store. **SQLite single-writer (daemon-owned) is a firm
invariant**; "no Postgres/vector DB/etc." (`AGENTS.md:162`). A store swap reopens
a core decision and would need an ADR, not a task. Read for ideas: Beads'
issue-graph-as-data model overlaps our GRAPH-plane ambitions (`ADR-009`) — that
idea we can express in SQLite. Decline the store swap.

---

## Grade-yourself survey

### ByteByteAI agentic reference — `reference-only` (mapping)
Map of each pattern to have / gap:

| Pattern | Status | Where |
| --- | --- | --- |
| Context engineering (budgeted windows, layered memory, compression) | **partial** | TASK-95 (compression); `context_composition` is an estimate not measured (TASK-109) |
| Retrieval / lazy loading | **have (non-vector)** | TASK-74 blast-radius; no embeddings by design |
| Skills as reusable/composable workflows | **have** | `.claude/skills/*`, TASK-99 (`build-ui`), dogfood |
| MCP & agentic tooling (browser automation, self-correcting loops) | **have** | QA TASK-90/91, browser QA |
| Subagents / agent-teams | **declined** | TASK-97 (deliberate no-subagent) |
| Parallel development (worktree isolation, concurrent testing) | **have** | worktree isolation, TASK-92 bulk-fix, `parallel-fanout-rebase-conflict` |
| Long-running agent workflows | **have** | Temporal deterministic workflows |

Net: strong coverage; the real gaps are **measured (not estimated) context
tokens** (TASK-109) and **memory lifecycle** (Memory-OS candidate above).

---

## Unrelated

### Clinical image de-identification tutorial — `reference-only`
Medical-imaging de-identification build; unrelated domain, no workbench feature.
Keep as a reference only unless a concrete workbench use emerges.

---

## Candidate tasks surfaced (for triage into the numbered backlog)

1. **Memory promotion/eviction policy** for the markdown project-memory file —
   extends `ADR-009` (still markdown, still repo-is-truth), from Memory-OS +
   auto-memory + autoagent. *(higher priority — closes a real gap)*
2. **Auto-capture high-signal repo facts on first touch** (not only at closeout)
   — from auto-memory; may fold into #1.
3. **markitdown as the context-ingestion converter** (PDF/docx/pptx → md),
   replacing ad-hoc pdfminer — from markitdown. *(bounded, low)*
4. **design.md experiment on TASK-99** — test whether a structured design spec
   improves from-scratch UI output. *(flag on TASK-99, not standalone)*
5. **Persisted per-run agent scratchpad/TODO** to reduce cold re-entry — from
   deep-agents-from-scratch. *(low)*
6. **Batch/factory rollup view** over `task_summary` — from the software-factory
   article. *(low)*
7. **OS-level sandbox for untrusted repos** — from Sandcastle; deferred, only if
   the `native-trusted` model changes.

Everything else is `decline` / `reference-only` — covered by an existing
invariant, task, or learning, or conflicting with the no-vector-DB / SQLite-
single-writer / no-subagent / read-only-board positions.
