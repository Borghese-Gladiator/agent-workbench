# Backlog
Prioritized List of Things to Fix

Each task: what's wrong / what to do, where, and how we'll know it's done.
Status legend: `[ ]` open · `[~]` in progress · `[x]` done

---

## P1 — Observability follow-ups (from live run f47a0d8e, 2026-07-27)

First full-lifecycle claude run under the new OTel layer (TASK-34) succeeded end
to end (draft PR `browser-games__ai#7`) and proved control-plane events +
per-phase traces + metrics land. But looking at the traces in Tempo surfaced a
structural bug the unit tests couldn't (they assert a span exists + carries
`run_id`, never the trace *shape*).

### [x] TASK-36: One trace per run, not one trace per phase (nested span tree)

**What's wrong.** Each phase renders as its OWN trace with a single span — a run
is 9 separate one-span traces (`phase.specify`, `phase.plan`, … each a distinct
trace id), not one trace with the phases nested under it. The Tempo waterfall for
any phase shows "1 span" and no structure, so the trace view is not actually
useful for "why did this run take so long / where did time go". Two root causes:
1. **No shared trace id across phases.** Every phase is a separate Temporal
   activity execution (`runPhase` invoked once per phase, often a different
   event-loop turn / worker), and `withSpan` (`packages/telemetry/src/spans.ts`)
   calls `tracer.startActiveSpan` with **no parent context**, so OTel mints a
   fresh random trace id per phase. In-process context propagation can't link them
   because there is no shared process context between activities.
2. **The phase span is a leaf.** The agent session + tool calls are emitted only
   as `semantic_events` rows; no OTel **child spans** are opened under the phase
   span (`run-phase.ts:1275` wraps only `drivePhase`). So even within a phase
   there is nothing to nest.

**What to do.**
1. Derive a **deterministic 16-byte trace id from `run_id`** (hash) so every phase
   of the same task lands in the same trace. Add a `withSpan` variant (or an
   option) to `@awb/telemetry` that takes `runId` and attaches a reconstructed,
   non-recording run-level `SpanContext` as the parent (build it with
   `trace.setSpanContext` on a fresh context; pass that context to
   `startActiveSpan`).
2. Optionally emit a stable per-run **root span** (`run`) once, or just parent all
   phase spans to the derived run context so they nest as siblings under one trace.
3. Open **child spans** under each phase span for the agent session
   (`session.<role>`) and, where cheap, tool calls — the builder path
   (`builder-support.ts` / `run-phase.ts` implement loop) and the QA/review paths.
   This gives the real tree: `run → phase.plan → session.planner → tool.Read …`.

**Where.** `packages/telemetry/src/spans.ts` (the parent-context variant),
`workers/temporal-worker/src/activities/run-phase.ts:1275` (parent the phase span
to the run context; open session child spans), `builder-support.ts` (tool/session
spans). Bridge ids already present (`run_id`/`task_id` on every span).

**How we'll know it's done.**
- *Unit:* a telemetry test asserting two `withSpan` calls with the same `runId`
  share a trace id (and differ across run ids), and that a child span's parent is
  the phase span.
- *Manual (live):* re-drive a task; in Tempo a single trace id covers the whole
  run, its waterfall shows `phase.*` spans nested under one root with real
  durations, and at least the builder phase has a nested `session.*` child.

### [x] TASK-37: `awb task remove` + cascade (no CLI way to delete a task today)

**What's wrong.** There is no CLI command to delete a task — cleaning up old/failed
tasks (2026-07-27) required hand-writing DELETEs across ~15 FK-linked tables
(`tasks`, `runs`, `phase_attempts`, `agent_sessions` + its `model_invocations`/
`tool_invocations`/`context_composition`/`command_executions`, `semantic_events`,
`runtime_attribution`, `evidence` + claims/deps, `findings`, `plans` + slices/
coverage, `task_contracts` + claims, `pull_requests` + feedback, `workspace_leases`,
`waivers`, `human_decisions`, `artifacts`, `memory_sources`). `repo remove`
(`packages/repository/src/persist.ts:99`) deletes only the repo + discovery rows,
so removing a repo **orphans** its tasks rather than cascading.

**What to do.**
1. Add a daemon data-access `deleteTask(db, taskId)` that removes a task and all
   descendant rows in FK-safe order, in one transaction (mirror the cleanup script
   used on 2026-07-27).
2. Expose `awb task remove [taskId] --yes` in the CLI.
3. Make `repo remove` optionally cascade its tasks (a `--with-tasks` flag) so it no
   longer orphans them, or at least warn + list the tasks it would orphan.

**Where.** `packages/database/src/data-access/` (new `deleteTask`), the daemon
internal route + `apps/daemon` handler, `apps/cli/src/commands/` (task remove),
`packages/repository/src/persist.ts` (cascade option).

**How we'll know it's done.** *Unit:* a data-access test that `deleteTask` removes
the task + every descendant and leaves a sibling task's rows intact, with
`PRAGMA foreign_key_check` clean afterward. *Manual:* `awb task remove <id> --yes`
drops it from `task list` and the web UI with no orphaned rows.

---

## P1 — Idea triage (2026-08-03)

Sorted a backlog of loose ideas into what actually applies to this workbench.
Each item below was checked against the live code (and the live PR
`browser-games__ai#7`), not just accepted at face value. Ideas that turned out
non-applicable or already-done are listed at the bottom with the reason so we
don't re-file them.

### [ ] TASK-38: Runtime gate is hard-coded to `'claude'`, not profile-driven

**What's wrong.** `run-phase.ts` branches on `ctx.strategy === 'claude'` in ~20+
places as *the* gate for the real (non-mock) path — real contract, real planner,
real prepare/worktree, real builder, real QA, real delivery, and even durable run
state (`durable = strategy === 'claude'`). Any other runtime (Pi, Codex,
OpenCode) therefore silently falls back to the MOCK path even when a real adapter
exists. This directly contradicts the RuntimeProfile design ("daemon is
profile-driven, no runtime string branches") — the daemon may be profile-driven,
but the phase activity is not. This is the "hard-coded naming of Claude inside
phases + lots of mock adapters" complaint, and it's the blocker for every
additional-runtime idea below.

**What to do.** Replace the `strategy === 'claude'` checks with a capability/profile
predicate — e.g. `ctx.profile.usesRealAgent` (or `runtimeSupportsRealPhase(ctx)`)
sourced from the RuntimeProfile — so "run the real path" is a property of the
selected runtime, not a string equality on one vendor's name. Keep MOCK as the
one explicit fallback. Grep for every `=== 'claude'` / `!== 'claude'` in the
activities and route each through the predicate; keep the ones that are genuinely
Claude-adapter-specific (if any) named as such.

**Where.** `workers/temporal-worker/src/activities/run-phase.ts` (all
`strategy === 'claude'` sites, lines ~91–1247), the RuntimeProfile definition,
`agent-factory.ts`.

**How we'll know it's done.** *Unit:* a phase test driven by a non-claude profile
whose `usesRealAgent` is true takes the real branch (planner/builder/delivery),
and a mock profile takes the mock branch — asserted without any `'claude'`
literal in the activity. *Manual:* a Pi/Codex profile run reaches a real builder
edit instead of a fake candidate.

### [ ] TASK-39: PR branch name keeps the "In <scope>," preamble (ugly slug)

**What's wrong.** The live PR branch was
`awb/in-wip-browser-games-add-a-one-line-note-f47a0d8e` — the raw prompt ("In
wip-browser-games, add a one-line note…") is slugified verbatim. `derivePrTitle`
(`packages/github/src/pr-content.ts:39`) already strips an `^in <scope>, <action>`
preamble, but `resolveTaskBranchName` → `slugify`
(`packages/workspace/src/branch.ts`) does not, so the branch leads with `in-` and
the repo name instead of the action.

**What to do.** Reuse the same preamble-stripping the title path uses (extract it
to a shared helper, or have `slugSource` be the already-derived action rather than
the raw prompt) so branches read `awb/add-one-line-note-f47a0d8e`. `worktree.ts:54`
passes `slugSource` straight through — fix at the source or in `slugify`.

**Where.** `packages/workspace/src/branch.ts`, `packages/workspace/src/worktree.ts`,
optionally a shared `stripScopePreamble` in `@awb/github` or a small util.

**How we'll know it's done.** *Unit:* `resolveTaskBranchName(id, "In
wip-browser-games, add a one-line note")` yields a slug with no leading `in-` and
no repo-name filler. *Manual:* next live run's branch reads cleanly.

### [ ] TASK-40: PR title is repo-name-scoped + hard-truncated with "…"

**What's wrong.** Same live PR titled "Wip-Browser-Games: add a one-line note to
README.md stating how many ga…". Two problems: (a) when the prompt's `<scope>` is
just the repo name, `derivePrTitle` title-cases it into a useless `Wip-Browser-Games:`
prefix; (b) the title overflows `TITLE_MAX` and gets chopped mid-word with `…`
("how many ga…"). GitHub already shows the repo, so the scope adds nothing and the
truncation reads as broken.

**What to do.** (a) Drop the scope prefix when the scope resolves to (or contains)
the target repo's name; fall back to the plain action clause. (b) Truncate on a
word boundary and prefer trimming the trailing detail clause over cutting a word —
or raise `TITLE_MAX` toward GitHub's ~72 and end on whitespace, never mid-token.

**Where.** `packages/github/src/pr-content.ts` (`derivePrTitle`, `titleCase`,
`TITLE_MAX`), with the repo name available to the caller.

**How we'll know it's done.** *Unit:* prompt "In wip-browser-games, add a one-line
note to README.md stating how many games…" with repo `wip-browser-games` yields a
title with no `Wip-Browser-Games:` prefix and no mid-word `…`. *Manual:* live PR
title reads as a sentence.

### [ ] TASK-41: PR description quality — worked examples + anti-patterns

**What's wrong.** The templated PR body (`delivery.ts` / `pr-content.ts`,
Background/Changes/Test-plan) is serviceable but has no house style to hold it to
— we've seen bloated "Changes" paragraphs and the title issues above. The user's
`/pr-draft` skill already encodes what a good Klaviyo PR looks like.

**What to do.** Pull the concrete guidance out of the `/pr-draft` skill into a
short in-repo reference (`docs/pr-style.md`): a list of good example PR
titles+bodies and an explicit "what not to do" list (no `[AWB]` noise, no
restating the whole prompt in Changes, no unrendered markdown, title ≤ ~72 chars,
etc.). Encode the checkable rules as assertions in `pr-content.test.ts`.

**Where.** new `docs/pr-style.md`, `packages/github/src/pr-content.ts` +
`pr-content.test.ts`. Source: the `/pr-draft` skill.

**How we'll know it's done.** The reference exists and at least the mechanizable
rules (length, no prompt-echo, no `[AWB]`) are covered by tests over
`derivePrTitle`/`buildPrBody`.

### [ ] TASK-42: QA is not thorough enough — run "succeeds" but artifact is broken

**What's wrong.** Runs report success while the delivered feature is actually
broken (observed: a Sheng Ji game that doesn't work; multiple WebSocket
connections opened from clicking the same "Join" button). Browser QA asserts a
couple of shallow steps and rubber-stamps, matching the standing "QA static checks
miss runtime bugs" and "QA cold re-entry never converges" learnings. So "run
success" ≠ "working artifact".

**What to do.** Strengthen the QA rubric toward *interaction correctness*, not just
page-load: assert on functional outcomes (a game action produces the expected
state change), detect duplicate/leaked WebSocket connections (count sockets per
user action), and treat unhandled console errors / repeated identical socket opens
as failing signals. Lean on the adversarial reviewer to actually gate runtime
correctness rather than trusting agent-reported completion.

**Where.** `packages/qa/` (browser QA assertions + rubric), `packages/review/`
(adversarial gate wiring), the QA scenario templates.

**How we'll know it's done.** *Unit/fixture:* a QA scenario fails when a button
opens N>1 sockets or when the asserted post-action state never appears. *Manual:*
re-run the Sheng Ji case and confirm QA blocks it instead of passing.

### [ ] TASK-43: Dogfood the workbench on this repo (agent-workbench itself)

**What's wrong.** We dogfood on `browser-games`/`fender`/`app` but have never
driven a task against *this* repo, which is the most honest test of whether the
tool is pleasant to use on a real TS monorepo.

**What to do.** Register `agent-workbench` as a repo and drive one small, real,
self-contained task (e.g. one of the smaller fixes above) end to end, interactively,
stopping at the PR-readiness gate. Capture friction as new TODO items.

**Where.** operational — uses the `run-workbench-task` skill; no code target.

**How we'll know it's done.** A branch + draft PR on this repo produced by the
workbench, with a short writeup of what was awkward.

### [ ] TASK-44: Add runtime adapters — Codex, Pi, OpenCode (depends on TASK-38)

**What's wrong.** Only `claude-adapter` and `mock-adapter` live in
`packages/agent-gateway/src/`. Pi and Codex adapters were prototyped on worktree
branches but never merged, and the phase gate (TASK-38) would ignore them anyway.
OpenCode is a net-new integration with useful subagent semantics.

**What to do.** After TASK-38 makes the real path profile-driven: land a
`RuntimeProfile` + adapter per runtime (start with whichever is closest to
merge-ready), each conforming to the existing `adapter.ts` contract. Keep external
tooling model-agnostic per the standing learning (daemon-seeded env + recipe
cards, no claude-gating). OpenCode's per-file agent loop (`opencode run --agent …`
over a file list) is a strong fit for the builder's per-slice model and for
en-masse mechanical fixes.

**Where.** `packages/agent-gateway/src/*-adapter.ts`, RuntimeProfile registry,
`agent-factory.ts`, per-project `runtimeConfig`.

**How we'll know it's done.** *Unit:* each adapter passes the shared adapter
conformance tests. *Manual:* a real (draft) PR produced under at least one
non-claude runtime, as previously proven for Pi on `wip-browser-games`.

### [ ] TASK-45: Repo-structure legibility — per-directory AGENT(S).md + one global map

**What's wrong.** A recurring agent-legibility gap (see the 2026-07-20 audit):
`workers/` has no README convention and `run-phase.ts` is an 806-line hub. The
idea list asks for "every directory explains itself" + "global understanding in
one file" + "business logic separated from framework glue".

**What to do.** Adopt a light convention: a top-level map (extend `AGENTS.md` or a
new `docs/map.md`) that names each package's job in one line, and a short
`AGENTS.md` (or `README.md`) in the directories that lack one, starting with
`workers/temporal-worker/src/activities/`. Don't over-engineer — one paragraph per
directory, not a doc framework.

**Where.** `AGENTS.md`, `workers/**`, package dirs missing a readme.

**How we'll know it's done.** Every top-level package + the activities dir has a
one-line self-description reachable from a single map file.

### [ ] TASK-46: Token cost — investigate high `cached_tokens` / call count

**What's wrong.** Reported symptom: runs are slow, expensive, and burn a *lot* of
`cached_tokens`, which suggests we re-send a large near-identical prompt prefix on
every call (cold per-slice builder sessions re-establish the same context each
time — see the TASK-19 fewest-slices work and the cold-session design). "Uses a
TON of cached_tokens" is a *symptom to measure*, not yet a confirmed waste.

**What to do.** Instrument per-phase / per-slice: input vs. cached-input tokens,
call count, and how much of each prompt is the repeated preamble
(`contextPayload`). Use the existing OTel/usage-aggregator layer (usage already
aggregated per session). Then decide — the numbers should fork into one of two
distinct levers, which attack different layers and are NOT substitutes:
- **Repeated-preamble / history replay** → deliberate prompt caching + reduce
  cold re-entry (resume sessions where safe) + eventually *subgraph retrieval*
  instead of replaying history (TASK-47). This is the Karpathy "graph
  engineering" point: *"an agent does not need every prior transcript… retrieve
  the connected state needed for the current decision."*
- **Bloated tool-result output** (400-line `npm test`/`git` dumps fed back to the
  agent) → compress command output at the execution layer before it re-enters
  context (the RTK/Caveman *technique*, applied inside `packages/execution` — NOT
  the personal CLI binaries, whose shell hook never intercepts SDK-driven agents).

Pick the lever the measurement points to; don't add a compression proxy before
knowing whether preamble or tool-output dominates.

**Where.** `packages/agent-gateway/src/usage-aggregator.ts`, `packages/telemetry`,
`builder-support.ts` (per-slice session construction), `packages/execution` (if
output compression wins), the run's evidence/metrics.

**How we'll know it's done.** A short measurement writeup: tokens & calls per
phase, % preamble vs. % tool-output, and a ranked list of the top reducible
costs — then a targeted task for the biggest one.

### [ ] TASK-47: The "graph plane" — spike a queryable lineage/memory graph (Graph Engineering + Agent Memory)

**Read first (implementer).** The source PDF — "Graph Engineering Systems"
(Karpathy synthesis):
https://isaiuseful.com/downloads/Karpathy-Graph-Engineering-Systems.pdf — read it
directly (open the file / extract text; WebFetch's summarizer **cannot** parse the
binary and returns "unreadable"). The five-plane architecture + the
`publish(update, graph, validator)` provenance API (`validator.check_provenance`,
`tx.link_run(run_id, agent_id, nodes, edges)`) are in §"Reference Production
Architecture" / §"Grounding layer".

**What's wrong / the framing.** The Karpathy "Graph Engineering" note
(Karpathy-Graph-Engineering-Systems, synthesizing autoresearch/AgentHub +
Anthropic's Dynamic Workflows + Knowledge Graph Cookbook) describes a five-plane
reference architecture — **control, execution, artifact, evaluation, graph** — and
this workbench *already is the first four*: daemon+Temporal (control), worktree/
process (execution), evidence+artifacts (artifact), verify/QA/review+gates
(evaluation). **The one plane we don't have as a first-class thing is the graph
plane** — entities, claims, relations, provenance, *experiment lineage*, and
*task dependencies*, stored so they can be traversed. Our run/phase/evidence data
exists but is flat/relational, so we can't cheaply ask the graph questions the
note calls out: *"which retained result has the best metric under a memory limit,
which experiments descend from X, which leaves have no evaluation, which lineages
improve then stagnate."*

Two of our other pains are really this gap in disguise:
- **Token cost (TASK-46).** *"An agent does not need every prior transcript… retrieve
  the connected state needed for the current decision rather than replay the entire
  history."* Subgraph retrieval is the principled fix for re-sent preamble.
- **Memory.** AgentMemory (agent-memory.dev / `rohitg00/agentmemory`) is the same
  idea packaged: hook-based auto-capture of session events + triple-stream recall
  (BM25 + vector + graph). BUT the real writeup shows vector/graph/LLM-compression/
  context-injection are **all off by default** (to avoid token burn), security
  fixes landed *after* real vulns (stored XSS, `0.0.0.0` bind, `curl|sh`), and
  there are open bugs (embeddings stuck BM25-only, Codex MCP surface). So it's a
  *reference for the model*, not a dependency to adopt. We already have
  `packages/repository-memory` + Claude Code's own `~/.claude/**/memory/`.

**The note's own guardrail (important):** *do not add a graph merely because the
system has agents.* A graph earns its cost only when **connected queries, evolving
relations, provenance, or shared cross-session state are central.** For a single
task run it's overkill — the payoff is **cross-run lineage + shared memory**, which
is exactly our pain. It's a "Month 1" item in the note's timeline, not day one.

**What to do (timeboxed spike, then a decision — not a build-out yet).**
1. Write a short ADR mapping our current schema onto the five planes and pinning
   down precisely what a minimal graph plane adds over the flat tables (start with
   versioned relational tables / a NetworkX-style in-proc graph, per the note's
   "Month 1: begin with versioned JSON or relational tables" — NOT a new graph DB).
2. Pick ONE concrete query to make cheap as the proof: e.g. "given this new task,
   retrieve the subgraph of prior runs/decisions/evidence relevant to it" (feeds
   memory recall + TASK-46's preamble reduction), OR "reconstruct a run's lineage
   with keep/discard + metric per node" (feeds the UI task board / TASK-49).
3. Compare against AgentMemory's model + our `repository-memory`; recommend
   adopt-an-idea / integrate-via-MCP / keep-ours. Do **not** wire AgentMemory's
   auto-compress/inject on day one; if trialed, localhost-bound + one flag at a
   time.

**Where.** `docs/decisions/` (the ADR + recommendation), `packages/repository-memory`,
the database schema (lineage/provenance edges), and TASK-46/TASK-49 as consumers.

**How we'll know it's done.** A one-page ADR that (a) states which plane(s) we're
missing, (b) picks the one proof-query, (c) gives a clear adopt/integrate/decline
call on AgentMemory with reasoning, and (d) either defers the build or spins out a
scoped follow-up task for the single proof-query. No graph DB adopted on spec.

### [ ] TASK-50: `repository-memory` compile + lint passes (Karpathy KB workflow) — depends on TASK-47

**What's wrong.** Separate from the graph-plane spike (TASK-47), Karpathy's other
memory idea is the **knowledge-base workflow**: ingest → **compile** (an LLM
synthesizes accumulated raw facts into a compact, linked md wiki with per-concept
summaries + backlinks) → Q&A → **lint** (an LLM health-check that flags
contradictory/stale/missing data and proposes new-connection candidates). Our
`repository-memory` only *appends* atomic `RepositoryFact` rows at closeout
(`recordFacts`, `store.ts`) and retrieves them (`queryMemory`); invalidation
(`invalidateFacts`) is purely mechanical path overlap. So memory grows as an
ever-longer flat log that never gets **denser** or **self-corrects** — the compile
and lint steps are exactly what's missing, and they're buildable md-first without
committing to the graph plane.

**What to do (thin, md-first — do NOT add a graph DB; that's TASK-47's call).**
1. **Compile pass** — an LLM step (at closeout or on demand) that reads a repo's
   facts and emits short per-concept summaries with backlinks (dedupe near-identical
   facts, cluster by unit/path), stored as a new `kind` (`concept`/`summary`) or md,
   **preserving provenance** (`sourcePaths`/`sourceHashes`). Reuse the existing
   schema; don't fork a parallel store.
2. **Lint pass** — an LLM health-check that flags contradictory/stale facts and
   proposes new-article/connection candidates as a **report** (not auto-applied);
   optionally feed confirmed contradictions into the existing `supersededBy`
   invalidation.

**Where.** `packages/repository-memory/src/` (new `compile.ts`, `lint.ts` +
`index.ts` exports), the closeout flow in `@awb/repository`, an `awb memory` CLI
surface if run-on-demand is wanted. Source: the Karpathy PDF linked in TASK-47.

**How we'll know it's done.** *Unit:* compile over a fixture of overlapping facts
yields fewer, linked concept summaries that preserve provenance; lint flags a
planted contradiction and leaves consistent facts untouched. *Manual:* run compile
on a real dogfooded repo's accumulated memory and confirm the KB is denser and
still traceable to sources.

### [ ] TASK-48: "Implement a feature" skill

**What's wrong.** There's no repo skill that captures the house workflow for
implementing a feature through the workbench (plan-first, slice sizing, gate
answers, verify). We have `run-workbench-task` (drives the pipeline) but not an
authoring/planning skill for feature work.

**What to do.** Add a `.claude/skills/` skill that encodes the feature-implementation
workflow (plan.md first per the global CLAUDE.md, converge the contract, keep
slices few, verify). Keep it thin and point at existing skills rather than
duplicating them.

**Where.** `.claude/skills/`.

**How we'll know it's done.** The skill exists and, invoked on a small feature,
produces a plan + drives it without re-deriving the workflow each time.

### UI ideas — scope check (mostly already built)

The live event stream the UI ideas ask for **already exists**: `useEventStream.ts`
opens the daemon **WebSocket** and backfills via `GET /api/events?afterSequence=N`
(TASK-23, done), so "auto-update UI as status changes (WebSocket)" and a live
"event log" are implemented on `TaskDetailPage`. The remaining, still-applicable
slice is narrower and folded in here rather than filed as new WebSocket work:

### [ ] TASK-49: Propagate live status to the list/overview, not just task detail

**What's wrong.** The WebSocket timeline drives `TaskDetailPage`, but `TasksPage`
(the list/status overview) does not appear to update live — you still refresh to
see a task change phase/status. The "add event log AND status" idea is really
"surface the already-streaming status on the overview".

**What to do.** Reuse the existing event stream (or a lightweight task-status
subscription) so the tasks list reflects phase/status changes without a manual
refresh. Don't add a second realtime mechanism — extend the one in
`useEventStream`/`events.ts`.

**Where.** `apps/web/src/pages/TasksPage.tsx`,
`apps/web/src/hooks/useEventStream.ts`, `apps/web/src/api/events.ts`.

**How we'll know it's done.** *Manual:* drive a task; its row on the tasks list
advances phase/status live with no refresh.

### Not applicable / already handled (not filed)

- **Full UI rewrite / "rewrite with an actual architecture diagram".** Meta-
  complaint, not a discrete task; the design is already documented
  (`docs/design.md`, `docs/domain-model.md`, `docs/dependencies.md`, ADRs). The
  real, actionable pieces of it are TASK-49 (live status) and the observability
  work already tracked. Filing a "rewrite" contradicts simplest-solution-first;
  concrete UI gaps get their own tasks instead.
- **PR Videos → remove from change list.** The qa-video/trace is already delivered
  as a PR *comment* with a hosted URL, not committed into the diff, and the
  upload path was fixed (TASK-7). Re-verify opportunistically; nothing to build.
- **Markdown failure on PR comments** (`browser-games__ai#7`). Inspected the live
  PR body + comments via `gh`: the Background/Changes/Test-plan body and the
  Browser-QA comment render correctly (valid tables, links, images). No markdown
  defect reproduced — the actionable problems in that PR are the *title* and
  *branch* naming, captured as TASK-40 / TASK-39.
- **Graph Engineering** (now READ — the Karpathy-Graph-Engineering-Systems note,
  not the paywalled X post). Promoted, not dropped: it's the framing lens for
  TASK-47 (we already are 4 of its 5 planes; the graph plane is the gap) and it
  sharpens TASK-46 (subgraph retrieval vs. history replay). No standalone "graph"
  task filed — the note's own guardrail is *don't add a graph just because you
  have agents*; it earns its cost only for cross-run lineage/shared memory, which
  is precisely TASK-47's scope.
- **Hermes profiles / side-by-side API comparison, auto-routing between online
  providers, "switch providers without rebuilding workflow", "free AI gets more
  useful when routing happens automatically", "how to reduce number of calls" as a
  router concern.** These describe a multi-provider *playground/router*, a
  different product than a task-implementation pipeline. Runtime *adapters*
  (TASK-44) are the in-scope slice; provider auto-routing is out of scope. (Call
  reduction as a cost measurement is TASK-46.)
- **RTK / Caveman token tools.** Not as binaries — their shell hook never
  intercepts our SDK-driven agents. The *technique* (compress tool-result output
  before it re-enters context, in `packages/execution`) is a candidate lever
  inside TASK-46, chosen only if the measurement shows tool-output (not preamble)
  dominates. Distinct from the graph/caching lever; they save tokens at different
  layers.
- **Prompt-Engineering-Guide (dair-ai).** Reference reading, not a dependency. The
  actionable sliver — tightening our stage prompts toward schema-constrained
  typed output + explicit per-slice success criteria + evaluator-optimizer
  phrasing for the reviewer — is folded into TASK-41 (PR style) and TASK-42
  (QA/review rubric), not filed separately.
- **GitHub Spec Kit.** Don't adopt (it's a prompt-scaffolding CLI for a human
  driving one agent; we're a durable multi-agent orchestrator — adopting it is a
  step DOWN in durability). Steal one thing: its `/tasks` dependency-ordered
  decomposition discipline for our weak planner (coarse cold slices, TASK-19), and
  let it reinforce the task-dependency-graph direction (TASK-47) + a real
  dependency-aware task board (TASK-49). No separate task; noted as input to
  those.
- **ChatGPT conversation link (AgentMemory primer).** Now READ (pasted in full);
  its substance is folded into TASK-47's AgentMemory assessment (opt-in
  compression/injection, security caveats, "recorder+recall not auto-learner").

---

## Live shakeout run — game-count UI feature (2026-07-22)

Drove a trivial UI feature ("show N games available in the portal header") on
`wip-browser-games`, claude runtime + `AWB_QA_MODE=browser`. **The full pipeline
ran end-to-end, first try, in ~7.5 min** (plan→implement→verify→exercise→
challenge→release; implement only ~100s — TASK-19's fewer-slices bias landed):
- Builder wrote a correct, clean, **test-backed** change (reused `enabledGames`,
  added `Portal.test.jsx` + wired vitest). candidate `7cde5fa`.
- **Browser QA fired inside the live pipeline** and produced real PNG + WebM
  video + Playwright trace zip (first live proof — TASK-4 confirmed e2e).
- **Adversarial reviewer reviewed the real diff** (ran Bash to inspect files)
  and converged with no blocking findings — TASK-14 confirmed live.
- Evidence-matrix PR comment correct: build/unit-test/qa-video all `passed`.

Two problems the run exposed: **TASK-20** ("stop before release" isn't
enforceable — release pushed a real draft PR #2 before the external watch could
stop it) and a **TASK-7 regression** (the qa-video/trace upload comments say
`undefined` instead of a real download URL; since fixed and confirmed live).

---

## P2 — The capstone

### [ ] TASK-12: Full President dogfood → real Draft PR with QA artifacts
The originally-requested end-to-end goal: use the workbench (claude runtime) to
implement the **President** card game in `Borghese-Gladiator/wip-browser-games`,
matching the poker/sheng-ji structure — a pure engine
(`packages/engines/president/src/engine.js` + Vitest), a React client
(`games/president/`, `useGameSocket("president")`), and a Playwright e2e — ending
in a **real Draft PR** carrying the workbench's QA artifacts (engine unit-test
run + browser-QA video/trace).
**Prerequisites:** TASK-1 (plan converges), TASK-2–7 (each real phase proven),
TASK-8 (real commands discovered so verify/QA are real). President also needs
server-side `useGameSocket` wiring, so it's an interactive run (answer the
contract gate; possibly reject a too-coarse plan).
**Done when:** a real Draft PR for President exists on the repo with real QA
evidence, reached via the workbench with no fake artifacts, and we stop at the
pr-readiness gate (no auto-merge).

**Assessment (2026-07-21) — would this work today? Partially; not unattended.**
What now works, proven on the README run: the mechanical spine
(specify→plan→implement→verify with a real worktree, real builder edits/commits,
real candidate SHA, real discovered test/build after prepare installs deps, real
usage aggregation). President is a bigger *code* task than a README, but the same
machinery applies, so the spine should hold.
The real risks are NOT in the plumbing anymore, they are:
1. **Convergence/quality of a hard multi-file task.** President is a real engine
   + React client + server `useGameSocket` wiring + Playwright e2e across several
   packages. The builder runs each plan slice as an *independent, cold* session
   (see TASK-19) with no shared memory, a 10k-token / 60s per-slice budget, and a
   diff-based success signal. A cross-cutting feature that needs coordinated
   edits across engine/client/server is exactly where cold per-slice sessions and
   tight budgets tend to stall or produce a partial, non-wiring-complete change.
   Expect iteration, not a clean first pass.
2. **The critic + adversarial reviewer are no-ops (TASK-14).** They never see the
   plan/diff, so nothing catches an under-wired or subtly-wrong implementation —
   the run can "pass" challenge with a broken feature. For President's
   correctness that matters a lot.
3. **Browser QA (TASK-4) is unproven live** and President's "done" REQUIRES a
   real qa-video/trace. It needs a discoverable dev-server start command
   (`resolveStartCommand`) and the server to actually come up in the worktree;
   that path has only been fixture-tested.
4. **Runtime.** At ~1–2h for a README (TASK-19), a multi-slice President run is
   plausibly many hours — needs supervision and probably a plan reject or two.
5. **Release opens a REAL draft PR + pushes** to the target remote (no dry-run
   guard) — must be run with a human present, never unattended.
**Bottom line:** the pipeline will very likely *drive* President through the
phases and produce a branch + commits, but reaching a *correct, QA-evidenced*
Draft PR in one shot is unlikely without (a) TASK-14 so review actually guards
quality, (b) TASK-4 proven so browser QA is real, and (c) TASK-19 so iteration is
tractable. Best run interactively, prepared to reject a too-coarse plan and to
repair after review.

**Update (2026-07-21):** the three named prerequisites are now addressed —
TASK-14 (critic/reviewer now receive their inputs via the contextPayload
preamble), TASK-4 (browser QA validated end-to-end; produces real video/trace),
TASK-19 (planner biased to fewest slices). Remaining risk is inherent difficulty:
President is a real multi-package feature and the builder still runs each slice as
a cold session, so cross-cutting engine/client/server wiring may need a repair
loop or two — but the review step can now actually catch an under-wired result.
Still: run it interactively (answer the contract gate, be ready to reject a coarse
plan) and remember release pushes a REAL PR, so a human must be present.
