# 009 — Graph plane: we're missing it, and we're deliberately not building it yet

Spike for TASK-47. **Verdict: don't build a graph plane now.** This ADR records why the
idea is real, why it doesn't earn its cost for us today, and the single condition that
would change that. Source: the Karpathy "Graph Engineering Systems" note (read directly).

## The idea, briefly

The note's model: as you scale from one agent to many, the hard problem stops being
"the next model call" and becomes **where memory and evaluation live**. It describes a
system as **five separable planes**:

| Plane | Job | In the workbench |
| --- | --- | --- |
| Control | decide what to do, budget, start/stop | daemon + Temporal |
| Execution | run tools/tests/subagents in isolation | worktree + process runtime |
| Artifact | store outputs as immutable versions | evidence / artifact store |
| Evaluation | deterministic checks + reviewers + gates | verify / QA / review + `evaluatePhaseCompletion` |
| **Graph** | **entities, claims, relations, provenance, lineage, task-deps — traversable** | **— (this is the gap)** |

We already are four of the five. The one we don't have as a first-class thing is the
**graph plane**: our run/phase/evidence data exists but as flat relational rows, so
questions like *"which prior runs are relevant to this new task?"* or *"reconstruct this
run's decision lineage"* are awkward to ask.

## Decision

1. **The missing plane is the graph plane** (traversable cross-run lineage + provenance).
2. **Don't build it now.** The note's own guardrail: *add a graph only when connected
   queries, evolving relations, provenance, or shared cross-session state are central.*
   For running one task, they aren't — the payoff is cross-run memory/lineage, which is
   aspirational for us, not load-bearing. Building it now is complexity ahead of need,
   and would cut against ADR-002 (don't add stores without a reason) and ADR-008.
3. **The token-cost motivation evaporated.** The note's headline reason to want a graph
   is "retrieve a subgraph instead of replaying history, to cut tokens." But TASK-46's
   measurement showed history-replay/preamble is **not** our token cost (it's ~0.03% of
   input; the cost is accumulated in-session context). So that argument doesn't apply to
   us — see `docs/token-cost-measurement.md`.
4. **Decline AgentMemory as a dependency; borrow ideas only.** Its useful features
   (vector/graph recall, auto-compress) ship off-by-default and it has a poor security
   history (stored-XSS, `0.0.0.0` bind, `curl|sh` install fixed after the fact). We
   already own `repository-memory` + Claude Code's `~/.claude/**/memory`.
5. **If we ever build it:** one proof-query first — *"given a new task, return the
   connected subgraph of prior runs/decisions/evidence relevant to it"* — over the
   relational rows we already have (versioned tables / an in-process traversal), **not** a
   new graph database. That is the spun-out follow-up, justified by memory-recall
   quality, not by token cost.

## What is worth keeping regardless

The note's four graph-write invariants are a good provenance checklist we can hold to
**without** a graph, and our schema mostly already does: (1) every claim has a source or
is marked inference; (2) every artifact has an authoring run + version; (3) every
evaluation names a rubric; (4) every superseded object stays addressable.

## Consequences

- No graph DB, no new store. The proof-query is a scoped future task, not this PR.
- **This is the "md vs graph" call TASK-50 was gated on: md, not graph.** The
  `repository-memory` compile/lint passes stay flat-store / md-first and do not
  introduce the graph plane.
- AgentMemory stays out of the dependency tree; its ideas inform `repository-memory`.

## Status

**Accepted — spike complete, build deferred.** Satisfies TASK-47's deliverable: names
the missing plane, picks the one proof-query, gives a clear decline-AgentMemory call,
and defers the build with a single trigger condition (cross-run lineage/shared memory
becoming central).
