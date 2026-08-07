# 009 — Graph plane: what it would add, one proof-query, and the AgentMemory call

Spike for TASK-47. Source: the Karpathy "Graph Engineering Systems" synthesis
(read directly; its five-plane model, the `publish(update, graph, validator)`
provenance API, the node/edge taxonomy, and the four graph-write invariants are
the reference for everything below). This ADR records a **decision to defer the
build** and spins out one scoped follow-up — it does **not** adopt a graph DB.

## Decision

1. **We already are four of the note's five planes; the missing one is the graph
   plane.** Map our schema onto the reference architecture:

   | Plane | Note's role | Our implementation |
   | --- | --- | --- |
   | Control | objectives, plans, budgets, start/stop | daemon + Temporal workflow (`packages/workflow`, `apps/daemon`) |
   | Execution | tools/tests/subagents in isolation | worktree + process runtime (`packages/workspace`, `packages/execution`, the agent adapters) |
   | Artifact | plans/drafts/metrics/evals as immutable versions | evidence + artifact store (`packages/evidence`, `evidence`/`plan`/`contract` tables) |
   | Evaluation | deterministic checks + model evaluators + gates | verify/QA/review + `evaluatePhaseCompletion` (`packages/verification`, `packages/qa`, `packages/review`, `packages/workflow`) |
   | **Graph** | **entities, claims, relations, provenance, experiment lineage, task dependencies — stored so they can be traversed** | **not a first-class thing.** The data exists but is flat/relational: `runs`, `phase_attempts`, `evidence`, `findings`, `repository_facts`, `agent_sessions` are rows, not traversable nodes/edges. |

   Our run/phase/evidence data is real but relational, so the questions the note
   calls out are awkward to ask: *which retained result has the best metric under a
   budget, which experiments descend from X, which leaves have no evaluation, which
   lineages improve then stagnate.* That gap — traversable **cross-run lineage +
   provenance** — is the graph plane.

2. **The proof-query, if/when we build it, is subgraph retrieval for a new task:**
   *given a new task, retrieve the connected subgraph of prior runs / decisions /
   evidence / repository-facts relevant to it, with provenance, bounded to a token
   budget.* This is chosen over the lineage-reconstruction alternative because it
   pays two of our standing pains at once:
   - **Token cost (TASK-46).** The note's principle — *"an agent does not need every
     prior transcript… retrieve the connected state needed for the current decision
     rather than replay the entire history"* — is the *principled* form of
     preamble/context reduction. (TASK-46's own measurement, however, found our
     re-sent preamble is already tiny; the dominant cost is accumulated **in-session**
     context, which subgraph retrieval does **not** address. So this query's near-term
     value is **memory recall quality**, not the TASK-46 cost — see Consequences.)
   - **Memory recall.** It is exactly what `repository-memory` retrieval and the
     compile/lint KB (TASK-50) want: "the facts connected to what this task touches,"
     not a flat filtered list.

3. **AgentMemory (agentmemory / agent-memory.dev): DECLINE as a dependency; steal
   the idea.** Reasons, from the note + the primer already triaged into
   `docs/TODO.md`:
   - It is a *recorder + triple-stream recall* (BM25 + vector + graph), but the real
     writeup shows vector/graph/LLM-compression/context-injection are **all off by
     default** (to avoid token burn) — so out of the box it is BM25-over-SQLite,
     which is essentially what `repository-memory` + our FTS5 already are.
   - Security history is a red flag for a dependency in the agent's write path:
     stored-XSS, a `0.0.0.0` bind, and a `curl|sh` install were fixed *after* the
     fact; embeddings were stuck BM25-only. It is a *reference for the model*, not
     something to put on the critical path.
   - We already own the pieces it packages: `packages/repository-memory` (+ its FTS5
     tables) and Claude Code's own `~/.claude/**/memory`. Adopting AgentMemory would
     add surface, not remove it.
   - If ever trialed: localhost-bound, one capability flag at a time, never the
     auto-compress/auto-inject path on day one.

4. **Defer the build.** Per the note's own guardrail — *"do not add a graph merely
   because the system has agents; a graph earns its cost only when connected queries,
   evolving relations, provenance, or shared cross-session state are central"* — and
   its timeline (versioned relational tables are a "Month 1" item, a graph DB is
   not). For a single task run a graph is overkill; the payoff is cross-run lineage +
   shared memory. We are not there yet, so: **no graph DB, no new store.** The one
   scoped follow-up is the proof-query above, built on **versioned relational tables /
   an in-process NetworkX-style view over the rows we already have** — not a new
   database engine.

## Why

- **We pass the note's "when to use a graph" test only partially.** Connected
  queries and provenance would be nice, but *today* each task run is largely
  self-contained; cross-run lineage and shared memory are aspirational, not central
  to a single run. That is precisely the condition under which the note says to
  wait. Building a graph plane now would be complexity ahead of need.
- **The cheapest version is not a graph at all.** The note is explicit: start with
  versioned JSON or relational tables and a bounded-neighborhood traversal in
  application code. Our rows already carry the edges implicitly (`runs.task_id`,
  `phase_attempts.run_id`, `evidence.phase_attempt_id`, `repository_fact_sources`,
  `findings` → phase). The proof-query can be a SQL/`in-proc` traversal over those
  FKs; it does not require materializing a property graph or adopting Neo4j/NetworkX
  as a store.
- **It keeps our two ADRs honest.** ADR-002 (SQLite, not Postgres) and ADR-008
  (observability split) both argue against adding stores without a load-bearing
  reason. A graph DB "because agents" is exactly the move those ADRs reject.
- **The four write-invariants are the real, portable lesson** and we can adopt them
  *without* a graph: (1) every claim has a source or is marked inference; (2) every
  artifact has an authoring run + version; (3) every evaluation identifies a rubric;
  (4) every superseded object stays addressable. Our schema mostly already honors
  these (`repository_facts` has `source_paths`/`source_hashes` + `superseded_by`;
  evidence has authoring phase attempts). Where a follow-up adds provenance edges, it
  should hold to these four — that is the durable win, graph or not.

## Consequences

- **No graph DB is adopted on spec.** The single spun-out follow-up is a scoped
  proof-query task (a new TODO item): "given a new task, return the bounded,
  provenance-carrying subgraph of prior runs/decisions/evidence/facts relevant to
  it," implemented over the existing relational rows (versioned tables / in-proc
  traversal), feeding `repository-memory` recall first. It is **not** wired to
  TASK-46 cost reduction, because TASK-46's measurement showed preamble is not the
  cost driver — so this follow-up is justified by recall quality, and any cost claim
  must be re-measured, not assumed.
- **TASK-50 does not depend on this.** The compile/lint KB passes are md-first over
  the existing `repository_facts` schema and explicitly do **not** introduce the
  graph plane. This ADR is the "graph-vs-md call" TASK-50 was gated on: **md, not
  graph.**
- **AgentMemory stays out of the dependency tree.** Its ideas (auto-capture,
  connected recall, compile/lint-style density) inform `repository-memory` (TASK-50)
  as a reference, nothing more.
- **The four write-invariants become a checklist** for any future provenance work,
  adoptable incrementally against the current tables without a store change.

## Status

**Accepted (spike complete); build deferred.** This ADR is the TASK-47 deliverable:
it (a) names the missing plane (graph), (b) picks the one proof-query (task-scoped
subgraph retrieval), (c) gives a clear DECLINE-as-dependency / steal-the-idea call
on AgentMemory, and (d) defers the build, spinning out a single scoped follow-up for
the proof-query over relational tables. No graph database is adopted.
