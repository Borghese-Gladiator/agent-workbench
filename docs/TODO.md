# Backlog
Prioritized List of Things to Fix

Each task: what's wrong / what to do, where, and how we'll know it's done.
Status legend: `[ ]` open · `[~]` in progress · `[x]` done

Tasks are grouped by implementation theme and ordered so foundational work comes
before what depends on it. Task IDs are stable (referenced across the code and
notes) — the numbers are not sequential within a group. Provenance for each
cluster (the live runs / articles that surfaced it) is noted in-line and in the
Reference notes at the bottom.

---

## Group A — Runtime & multi-adapter (foundational)

The profile-driven refactor that unblocks every additional-runtime idea; land
TASK-38 before TASK-44.

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

---

## Group B — Planning discipline & slice sizing

WSFF's 80/20 core: right-size the ceremony, review structure before code, and cap
how much unreviewed diff a run can dump. TASK-51 gates when TASK-52 runs; TASK-56
is the deliberate counterweight to the fewest-slices bias (TASK-19).

### [ ] TASK-51: Phase-sizing router (the WSFF 80/20 rule)

**What's wrong.** The pipeline runs one-size-fits-all — every task gets the same
planning weight regardless of size. WSFF's central structural claim is that ~40%
of tasks deserve single-shot execution, medium tasks a single combined
product+architecture doc, and only large tasks the full four-phase treatment.
Applying full ceremony to a one-line README edit is waste; applying single-shot to
a multi-package feature is the 2000-line-dump failure mode. We have neither the
classification nor the branching.

**What to do.** Add a task-sizing classifier at intake (S/M/L) that selects which
planning phases run: S → single-shot (skip straight to a slice), M → one combined
product+arch artifact, L → full plan + program-design (TASK-52) + slices. Size
from cheap signals first (prompt length, target-file count, cross-package span
from the discovered command/structure map) before spending a model call. Make the
chosen size and phase set visible in the run state / UI and overridable at the
contract gate.

**Where.** intake / contract-gate path, `workers/temporal-worker/src/activities/`
(phase selection), run-state schema (persist the size + phase set), `apps/web`
task detail (show it). Interacts with TASK-19 (fewest-slices bias) and TASK-49
(surface status).

**How we'll know it's done.** *Unit:* a one-line-edit prompt classifies S and the
workflow skips the heavy planning phases; a multi-package prompt classifies L and
runs program-design. *Manual:* a trivial task finishes without the full plan
ceremony; a large task shows all phases in the UI.

### [ ] TASK-52: Program-design artifact (signatures / call-stack / file-tree diff) before code

**What's wrong.** We go plan → build with nothing between. WSFF inserts an explicit
"program design" phase — types, method signatures, projected file-tree diff, call
stacks — decided and reviewed *before* implementation, because that review is cheap
and catches architectural mistakes while they're still free. Today the first time a
human sees structure is in the slice diff, which is exactly the expensive review
WSFF warns against.

**What to do.** Add a program-design artifact type produced (for L tasks per
TASK-51) after the plan and before the first slice: projected file-tree diff (files
added/changed), key type/interface definitions, and function signatures with a
one-line intent each — no bodies. Route it through the same gate machinery as the
plan so a human (or the adversarial reviewer, TASK-14) can redirect before code
exists. Feed it into the builder as context for the slices.

**Where.** artifact/phase definitions, `workers/temporal-worker/src/activities/`
(new phase between plan and build), `packages/review/` (reviewer sees it), builder
context payload. Depends on TASK-51 for when-to-run; complements TASK-19.

**How we'll know it's done.** *Unit:* an L task emits a program-design artifact with
a file-tree diff + signatures and no implementation bodies, and it reaches the gate
before any slice runs. *Manual:* rejecting the program design redirects structure
without a build ever happening.

### [ ] TASK-56: "Amplify, don't automate" velocity guardrail

**What's wrong.** Nothing caps how much unreviewed diff a single run can produce
before a human sees it. WSFF's concrete anti-pattern is reviewing 2000+ lines of
untested code in one dump; the antidote is frequent redirection on thin vertical
slices. We bias toward fewest slices (TASK-19) for tractability, which is in tension
with this — we need a ceiling, not just a floor.

**What to do.** Add a configurable guardrail: when a slice's projected/actual diff
exceeds a threshold (lines or files), force a human checkpoint (or auto-split the
slice) before continuing, and prefer the WSFF slice progression (mock API + curl →
frontend on mocks → wire services → add DB) for end-to-end features. Make the
threshold a profile/config knob, off by default for MOCK, on for the real path.
Explicitly the counterweight to TASK-19: fewest slices *up to* a review-sized cap.

**Where.** builder / slice execution in
`workers/temporal-worker/src/activities/`, profile/config (the threshold knob),
contract-gate path (the forced checkpoint). Counterbalances TASK-19; feeds the
human review WSFF requires.

**How we'll know it's done.** *Unit:* a slice whose diff exceeds the threshold
triggers a checkpoint/split instead of proceeding; under the threshold it proceeds
untouched. *Manual:* a large feature run pauses for human review at the cap rather
than dumping one giant diff.

---

## Group C — Quality gates: QA correctness, maintainability & pre-work alignment

Correctness ≠ maintainability (WSFF). TASK-42 hardens the correctness gate;
TASK-53 adds the missing maintainability axis (advisory, non-blocking); TASK-54
moves the cheapest redirection (problem + success criteria) *before* any code.

### [ ] TASK-42: QA is not thorough enough — run "succeeds" but artifact is broken

**What's wrong.** Runs report success while the delivered feature is actually
broken (observed: a Sheng Ji game that doesn't work; multiple WebSocket
connections opened from clicking the same "Join" button). Browser QA asserts a
couple of shallow steps and rubber-stamps, matching the standing "QA static checks
miss runtime bugs" and "QA cold re-entry never converges" learnings. So "run
success" ≠ "working artifact".

Root cause in the gate itself: the `exercise` gate
(`evaluatePhaseCompletion` → `evaluateExercise`, `evaluate-completion.ts:105-122`)
clears as long as `structuredAssertionsPass` is true, a recording exists, and a
browser scenario has a trace (`completion-context.ts:51-59`) — it never inspects
**how strong** those assertions are. A scenario that asserts almost nothing passes
exactly like one that asserts the real behavior, so "QA passed" can mean "the
feature is wired and live" while saying nothing about whether it is **correct**.

**Concrete evidence (President dogfood, `browser-games__ai#10`).** The President
e2e (`e2e/president.spec.js`) drove 4 real clients through create-room → join →
auto-start → play a trick, and its only assertions were:
```
expect(sawFirstPlay).toBe(true);     // at least one card was played
expect(sawTrickAdvance).toBe(true);  // the trick moved past its first play
```
Those prove the `useGameSocket("president")` → gateway → engine wiring is alive;
they exercise **no** President rule (turn order, beating by higher rank, matching
multiples, finishing order, roles). Consistent with that, the adversarial reviewer
separately found a fidelity bug QA was structurally incapable of catching —
`passedSeats` resets on every play (`engine.js:261`), so a player who passed
re-enters the same trick. QA was green; the behavior was wrong.

**What to do.** Strengthen the QA rubric toward *interaction correctness*, not just
page-load, AND make QA strength a first-class, checkable gate property rather than
trusting assertion *count > 0*:
- Assert on functional outcomes (a game action produces the expected state change),
  detect duplicate/leaked WebSocket connections (count sockets per user action),
  and treat unhandled console errors / repeated identical socket opens as failing
  signals.
- Tie QA scenarios to behavioral acceptance claims and check *coverage of the
  claim*: make `everyBehavioralClaimCovered` (already a gate field) mean "an
  assertion actually exercises this claim's observable behavior", not merely "a
  scenario ran for it". "A higher rank beats a lower one" should require an
  assertion that observes a *beat*, not just that a card was played.
- Have the planner emit the expected per-claim assertions (the specific state
  transition to observe) so the QA author has a target and the gate can check it.
- Treat trivially-weak scenarios (all existence/liveness checks, no state-transition
  or value comparison) as a QA-quality *finding* for the challenge phase, not a
  silent pass. Lean on the adversarial reviewer to gate runtime correctness rather
  than trusting agent-reported completion.

**Where.** `packages/qa/` (browser QA assertions + rubric, classify weak
scenarios), `packages/workflow/src/evaluate-completion.ts` (`evaluateExercise` —
strengthen what `everyBehavioralClaimCovered`/`structuredAssertionsPass` require),
`packages/workflow/src/completion-context.ts` (fields feeding it),
`packages/planning/*` (planner emits expected per-claim assertions),
`packages/review/` (adversarial gate wiring), the QA scenario templates.

**How we'll know it's done.** *Unit:* a QA scenario fails when a button opens N>1
sockets or when the asserted post-action state never appears; and an
`evaluateExercise` test where a scenario with only liveness assertions against a
behavioral claim leaves `missing` non-empty (gate does NOT clear), while one
asserting the claim's state transition clears it. *Manual:* re-run the Sheng Ji
case and confirm QA blocks it; re-drive a rules-bearing feature and confirm a
`passedSeats`-style fidelity bug is caught by QA, not only by the reviewer.

### [ ] TASK-53: Maintainability review, distinct from correctness, advisory to the human

**What's wrong.** Every gate we have (verify, QA, TASK-42) answers *does it work* —
correctness. WSFF's whole thesis is correctness ≠ maintainability, and
maintainability has **no reliable model self-signal** ("if a model could tell good
code from bad it would have written the good version"). So we have zero coverage on
the exact axis the article says kills factories: duplication, coupling, dead
abstractions, naming, layering.

**What to do.** Add a maintainability-review pass over the run's diff that *surfaces
candidates* for human attention rather than emitting a pass/fail: new duplication
introduced, tight coupling / layering violations, abstractions with a single caller,
inconsistent naming vs. the surrounding code. Present it as advisory annotations on
the review artifact (explicitly "for human review", per WSFF), complementing —
not replacing — the correctness gate (TASK-42) and the adversarial reviewer
(TASK-14). Do not let it block; its job is to make the human review faster and
targeted.

**Where.** `packages/review/` (new advisory pass), review artifact schema (an
advisory section), `apps/web` review display. Sits alongside TASK-14 / TASK-42.

**How we'll know it's done.** *Unit:* a diff that copy-pastes an existing helper
produces a duplication annotation flagged advisory (non-blocking) and the run still
completes. *Manual:* a real run's review artifact lists concrete maintainability
candidates a human can act on.

### [ ] TASK-54: Reviewer-alignment gate *before* implementation

**What's wrong.** Our gates are approve/reject *after* artifacts exist (plan gate,
review gate). WSFF says to align with the person who'll review the PR on problem +
success criteria *before* coding — the cheapest possible redirection. We have no
pre-implementation product/success-criteria checkpoint; the earliest human signal
is on an already-produced plan.

**What to do.** Add a lightweight product-review artifact (problem statement +
measurable success criteria; rough mockup optional for UI tasks) as the first gate,
before planning/architecture spend. On approval it becomes the reference the plan,
program-design, and QA rubric are all held to (success criteria → QA assertions,
tying into TASK-42). For S tasks (TASK-51) this collapses into the single-shot path;
it's mandatory only for M/L.

**Where.** intake / first gate, artifact definitions (product-review type),
contract-gate path, and downstream consumers (planner, QA rubric). Depends on
TASK-51 for sizing; feeds TASK-42/TASK-52.

**How we'll know it's done.** *Unit:* an M/L task cannot reach planning until the
product-review gate is answered, and the recorded success criteria are readable by
the QA phase. *Manual:* rejecting problem/success-criteria redirects the task before
any plan or code is produced.

---

## Group D — PR output quality

The live PR `browser-games__ai#7` surfaced these; all in the delivery/github
path. TASK-41 (house style) subsumes the checkable rules from TASK-39/40.

### [x] TASK-39: PR branch name keeps the "In <scope>," preamble (ugly slug)

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

### [x] TASK-40: PR title is repo-name-scoped + hard-truncated with "…"

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

### [x] TASK-41: PR description quality — worked examples + anti-patterns

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

### [x] TASK-58: Embed QA video as a downscaled GIF (WEBM stays a committed local file)

**What's wrong.** The QA "Recording" never renders inline in the PR. We commit the
Playwright capture as `.awb/qa/recording.webm` and link it with `blobViewUrl(...)`
→ `github.com/<o>/<r>/blob/<branch>/.awb/qa/recording.webm`, on the belief (see the
comment on `blobViewUrl` in `pr-content.ts:121-128` and `renderQaMediaSection` in
`pr-content.ts:158-159`) that GitHub renders its native `<video>` player on the
blob page. It does not: GitHub only plays videos uploaded through its own
attachment/upload flow, NOT a `.webm` committed to a branch. So the section
degrades to a plain text link ("▶ Watch recording (opens in a tab)") and the
reviewer has to click out to a bare blob page. Live example that FAILS to embed:
`browser-games__ai#8` (`issuecomment-5108991804`).

**What to do.** GitHub DOES render an animated GIF inline via image markdown
(`![...](raw.githubusercontent.com/...)`), the same path the screenshot already
uses. So:
1. In the QA-media step, after capturing the WEBM, transcode it to an animated
   **GIF** (`ffmpeg` two-pass `palettegen`/`paletteuse`).
2. **Scale the GIF down** — a full-res/full-length GIF is huge and blows past
   GitHub's inline-image ceiling. Constrain it: width ≤ **~640px**
   (`scale=640:-1:flags=lanczos`, never upscale — `min(640,iw)`), **~10 fps**
   (`fps=10`), total size under **~10 MB**; if the first transcode is over budget,
   step down (width → 480, then fps → 5) and re-encode. Make the caps named
   constants so they're tunable in one place.
3. Commit the GIF alongside the WEBM (`.awb/qa/recording.gif`) via the existing
   `commitQaMediaToBranch` path, and add `'image/gif' → '.gif'` to
   `EXT_BY_MEDIA_TYPE` in `qa-media-support.ts:95`.
4. **Keep the WEBM** as the full-fidelity source. In the PR comment render the GIF
   inline (`![Browser QA recording](raw…/recording.gif)`) as the primary artifact
   and keep the WEBM as a secondary "full recording (WEBM)" link.
5. **View it in the local UI.** `EvidenceViewerPage.tsx:29-34` says it "cannot yet
   show video/trace playback". Add a daemon read route serving the committed QA
   media bytes and render them in the Evidence Viewer: GIF via `<img>`, WEBM via
   `<video controls>`, so a run's recording is watchable locally without the PR.

**Where.** `packages/github/src/pr-content.ts` (`renderQaMediaSection` — inline GIF
+ secondary WEBM link; the `blobViewUrl` player assumption is wrong, keep it only
as the WEBM fallback), `workers/temporal-worker/src/activities/qa-media-support.ts`
(GIF transcode + downscale, `EXT_BY_MEDIA_TYPE`, `qaMediaFileName`),
`packages/qa/src/browser-qa.ts` (likely home for the transcode), a new daemon media
route + `apps/web/src/pages/EvidenceViewerPage.tsx` (local playback).

**How we'll know it's done.** *Unit:* `renderQaMediaSection` with a `qa-video` item
emits an inline `![...](raw.githubusercontent.com/.../recording.gif)` image (not
just a blob link) plus a secondary WEBM link; a transcode test asserts output GIF
width ≤ cap and that an over-budget input triggers a step-down re-encode. *Manual:*
re-drive a browser-QA task — the PR comment shows the recording playing inline as a
GIF (no click-out), the WEBM is still committed, and the Evidence Viewer plays both.

---

## Group E — Token cost, memory & the graph plane

The Karpathy "Graph Engineering" cluster. TASK-46's measurement decides whether
the fix is caching/subgraph-retrieval (→ TASK-47) or output compression. TASK-50
depends on TASK-47's graph-vs-md call.

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

---

## Group F — Observability & Web UI

TASK-55's decay metrics reuse the one-trace-per-run layer and draw on TASK-53's
annotations; TASK-49 surfaces the already-streaming status on the list.

### [x] TASK-55: Track WSFF decay metrics on our own runs

**Done** (buildable subset). Added `getDiffLineStats`/`parseNumstat` (`git diff
--numstat`) to `packages/repository/src/git.ts`; a pure `decay-metrics.ts`
(`computeDecaySignals` + `decaySpanAttributes`) in the worker; and a best-effort
`run.decay` span emitted from `challengeHandler` (real path only) carrying
`awb.decay.*` attributes (diff_lines, files_changed, reviewed_diff_lines,
reviewed_ratio, finding_count, blocker_high_count, maintainability_finding_count,
finding_density_per_kloc) — auto-nested under the phase's one-trace-per-run.
**Duplication-delta deferred**: it needs a prior-run baseline / duplication probe
that doesn't exist yet (and TASK-53's maintainability annotations aren't built);
finding-density uses the adversarial `reviewFindings` count instead. Tested:
`parseNumstat`/`getDiffLineStats` (repository), `computeDecaySignals`/attrs
(worker), and a `span.setAttributes`-in-body case (telemetry).

**What's wrong.** WSFF's point is that maintainability decay is *invisible on the
fast loop* — it shows up weeks later as incidents. We have observability
(one-trace-per-run) but we measure success/latency, not decay. We can't currently
answer "is the factory degrading the codebases it works on?"

**What to do.** Capture per-run decay signals and expose them over time: duplication
delta introduced by the run, diff size vs. reviewed-diff ratio, review-comment /
maintainability-annotation density (from TASK-53), and — where we can observe it —
regression/repair-loop rate and post-merge revert/incident signal on workbench PRs.
Add them to the observability layer as run attributes so a dashboard can trend them.
This is the measurement that tells us whether we're at WSFF's "2–3× safely" or
sliding toward the +242%-incidents outcome.

**Where.** `packages/observability/` (new run attributes / metrics), review pass
(TASK-53) as a source, `apps/web` or Grafana for the trend. Relates to TASK-46
(token cost) and TASK-49 (surface status).

**How we'll know it's done.** *Unit:* a run emits duplication-delta and
reviewed-ratio attributes on its trace. *Manual:* the metrics trend across several
runs in Grafana/Tempo (or the UI), visibly moving when a run introduces duplication.

### [x] TASK-57: Task-detail "Live event timeline" stays empty + fake "reconnecting…"

**Done.** `useEventStream` now runs the initial `catchUp()` on mount / `runId`
change, independent of the WebSocket (history renders even if the socket never
opens), and `openEventStream` has a real capped-backoff reconnect loop that
re-runs catch-up (deduped by `sequence`) on every (re)connect. The hook exposes a
3-state `status` (`connecting`/`connected`/`reconnecting`) and `TaskDetailPage`
labels each distinctly, so a dead socket with backfilled events reads as
"reconnecting" with history, never "no events". Live-verified in a real browser
(WS deliberately down): all stored events rendered + header read "(reconnecting…)".
Unit-tested (jsdom): backfill-on-mount with no socket, reconnect without dup
sequences, status transitions.

**What's wrong.** On the task-detail page the **Live event timeline** shows "No
events yet" and a permanent "(reconnecting…)" header even for a task with
**hundreds of stored events** (the President run had 299 rows in `semantic_events`
for `run_id=<taskId>-run`, yet the panel was blank). Two distinct defects in
`apps/web/src/hooks/useEventStream.ts`:
1. **Backfill is gated on the WebSocket opening.** `catchUp()` (the REST
   `GET /api/events?afterSequence=N` call that loads stored events) is invoked ONLY
   inside the socket's `onOpen` handler (`useEventStream.ts:51-55`). If the WS never
   connects, `onOpen` never fires, so existing events are never fetched — the
   timeline is empty despite the data being in SQLite and served by the working
   catch-up route.
2. **"reconnecting…" is a lie — nothing reconnects.** `openEventStream`
   (`apps/web/src/api/events.ts:31-48`) opens the socket exactly once; on
   close/error it sets `connected=false` and never re-opens, so the header's
   "reconnecting…" state (rendered when `!connected`) is permanent.

This corrects TASK-49's premise: the detail timeline is *not* actually working
end-to-end today, so fix the backfill/reconnect here before surfacing the stream on
the list (TASK-49).

**What to do.**
1. Run the initial `catchUp()` **on mount / `runId` change**, independent of the WS
   — historical events must render even if the socket is down.
2. Add a real reconnect loop to `openEventStream` (or the hook): on close/error,
   back off and re-open, and re-run `catchUp(lastSeq)` on each reconnect (dedupe by
   `sequence` already makes this gap-free).
3. Distinguish the states in the UI: "connecting" vs "reconnecting" vs "disconnected
   (showing history)", so a dead socket with backfilled events doesn't read as "no
   events".

**Where.** `apps/web/src/hooks/useEventStream.ts` (backfill-on-mount + reconnect),
`apps/web/src/api/events.ts` (`openEventStream` retry), `TaskDetailPage.tsx` (status
label). Confirm the daemon WS route `/api/events/stream`
(`apps/daemon/src/routes/websocket.ts`) actually accepts the connection — if the
handshake itself fails, that's a third root cause to rule out.

**How we'll know it's done.** *Unit:* a hook test that, with the WS never opening,
still populates `events` from a mocked `fetchEventsAfter`; and a reconnect test that
a dropped socket re-opens and backfills without duplicating sequences. *Manual:*
open the task-detail page for a completed run — the timeline shows the full ordered
event list immediately, and killing/restoring the daemon flips the header through
reconnecting→connected without losing or duplicating events.

### [x] TASK-49: Propagate live status to the list/overview, not just task detail

**Done.** Added `useTaskListLiveRefresh`, which reuses `openEventStream` (the
same reconnect-capable client, no second realtime mechanism — the WS is not
run-scoped, so any event means some task advanced) to debounce-refresh the tasks
list off the stream; the 4s poll stays as a fallback. Wired into `TasksPage`.
Unit-tested: burst debounced into one refresh, refresh-on-(re)connect, closes on
unmount.

The live event stream backfills via `GET /api/events?afterSequence=N` (TASK-23,
done) and drives `TaskDetailPage` via the daemon **WebSocket** — but the backfill/
reconnect on that page is itself broken (TASK-57), so land TASK-57 first. This
task is the narrower remaining slice: surface the status on the overview.

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

---

## Group G — Legibility, DX & dogfooding

Lower-risk, mostly-docs/skills work + the honest self-dogfood.

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

---

## Reference — triage decisions & prior runs (not tasks)

### Not applicable / already handled (not filed)

- **Full President dogfood → real Draft PR** (was TASK-12). **Done** — merged PR
  `browser-games__ai#10` implemented the President card game end to end via the
  workbench (real engine + React client + browser-QA artifacts). The follow-ups it
  surfaced live on in the QA/PR-quality groups above.
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
- **Graph Engineering** (READ — the Karpathy-Graph-Engineering-Systems note,
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
- **ChatGPT conversation link (AgentMemory primer).** READ (pasted in full); its
  substance is folded into TASK-47's AgentMemory assessment (opt-in
  compression/injection, security caveats, "recorder+recall not auto-learner").

### Live shakeout run — game-count UI feature (2026-07-22)

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
