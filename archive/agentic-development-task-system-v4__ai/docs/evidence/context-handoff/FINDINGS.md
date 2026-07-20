# Stage Context Handoff — captured evidence + what to thread

Captured from live `claude`-runtime runs via `scripts/live-e2e.mjs` with the new
`WORKBENCH_CAPTURE_PROMPTS=<dir>` hook (claude adapter dumps the EXACT prompt sent
to the CLI for each stage). Two runs:

- `./` — the from-scratch tic-tac-toe example (empty repo; discovery short-circuits).
- `./nonempty-repo/` — a 3-function `calc` library + a "add divide()" request, so
  discovery actually runs a real agent. **This is the representative chain.**

## Confirmed: the handoff carries ONLY artifact IDs

Every stage prompt's context line is literally:

```
Context artifacts available to you (ids): art_h7BeBztQBS, art_f7nebJLAPj, ...
```

No bodies. The bodies live on disk in the daemon data dir
(`data/<run>/artifacts/<taskId>/art_*.md`), OUTSIDE the agent's worktree sandbox,
so the agent **cannot read them**. All five daemon call sites build the context
identically: `contextArtifactIds: this.store.listArtifacts(task.id).map(a => a.id)`
(`service.ts:238, 661, 931, 1135, 1433`).

### The smoking gun — the agent said so itself

The `calc` run's **task_brief transcript** (`nonempty-repo`, `art_I2hZClm_bI`) opens with:

> "Since I don't have direct file-reading tools in this session, I'll base the brief
> on the request and what's inferable from the git context… The artifact context ID
> `art_h7BeBztQBS` is noted but **not retrievable via available tools**."

The model was handed an ID and explicitly recorded that it could not resolve it.

### The chain, stage by stage (calc run)

| Stage | IDs handed in (count) | What the IDs actually are | Bodies in prompt? |
|-------|----------------------|---------------------------|-------------------|
| `task_brief` | 1 | raw_prompt | none |
| `discovery` | 3 | raw_prompt, task_brief, brief-transcript | none |
| `options_plan_test` | 5 | raw_prompt, task_brief, brief-transcript, discovery, discovery-transcript | none |

The `options_plan_test` instruction orders the agent to bind "one row per **Acceptance
Criteria ID from the Task Brief**" — but the brief body is not in the prompt. The
discovery body (the codebase understanding) is not in the prompt. Both sat on disk:
- task_brief body: **7,911 bytes**
- discovery body: **4,201 bytes**

~12 KB of directly-relevant, already-computed context, withheld from a 1.7 KB prompt.
That is the turn-explosion root cause from `docs/TODO.md` (discovery did the work,
planning re-did it).

## What context each stage SHOULD receive (proposal for step 2)

Thread the **bodies of the durable, model-authored artifacts** the stage logically
consumes — NOT the transcripts (logs) or the raw_prompt (already inlined as `Request:`).
Resolve ids → bodies via `store.readArtifactBody`, render under a `## Prior context`
heading, bounded/truncated with a size guard.

| Stage | Thread these bodies | Why |
|-------|--------------------|-----|
| `task_brief` | (nothing new) | First real stage; raw request already inlined. |
| `discovery` | `task_brief` | Explore against the normalized scope + Acceptance Criteria, not the raw ask. |
| `options_plan_test` | `task_brief` + `discovery` | Stop re-grepping what discovery found; bind the plan to the brief's AC IDs. |
| `implementation` | `execution_plan` (+ `task_brief` for AC) | Apply the approved plan without re-deriving it. (Resume path already covers redo.) |
| `validation_demo` | `execution_plan` + `task_brief` | Map proof to the plan's "Validation by criterion" + the AC IDs. |
| `agent_self_review` | `task_brief` + `execution_plan` (diff already on disk) | Review against intent, not just the diff. |
| `delivery_prep` | `execution_plan` + `validation_report` + `self_review` | The instruction ALREADY claims it uses "the prior task artifacts (plan / validation / self-review)" — today that's an empty promise (ids only). |
| `delivery_conflict` | (nothing new) | Conflict list threaded via reviewerFeedback already. |

## Fix landed — before/after (same calc task, captured)

Threading implemented: `STAGE_CONTEXT_KINDS` allowlist + `claudeStagePrompt` renders
full bodies under `## Prior context`; the daemon resolves ids→bodies via
`resolveStageContext`. Re-ran the calc task with capture (`./after-fix/`):

| Stage | BEFORE (ids only) | threading (`./after-fix/`) | json-dedup (`./after-fix-2-nojson/`) | quality bar (`./after-fix-3-quality/`) |
|-------|-------------------|----------------------------|--------------------------------------|----------------------------------------|
| discovery | 751 | 7,644 (dup json) | 4,407 (prose) | **1,958** |
| options_plan_test | 1,697 | 12,911 (dup json) | 6,663 (prose) | **3,728** |

Discovery now explores against the Acceptance Criteria; planning consumes the brief +
discovery instead of re-grepping/re-reading the file. No truncation — full prose bodies.

### JSON-bloat fix (why "after-fix" was ~2× too big)

The first threading pass surfaced a PRE-EXISTING artifact-bloat bug: every stored
artifact body duplicated its structured json. `buildProduced` (`claude.ts`) took the
agent's `finalText` — which ALREADY ends with its own fenced ```json block — and
appended a SECOND, re-serialized copy under `## Structured summary`. Nothing reads
that stored block programmatically (gates/verification use the parsed object), so it
was pure duplication. Threading those bodies then paid for the dup in every consuming
prompt. Two fixes:
- `buildProduced` no longer appends the duplicate — it stores the agent's prose
  verbatim (one json block, the agent's own). Shrinks EVERY stored artifact.
- `stripStructuredJson` strips fenced ```json (+ the `## Structured summary` heading)
  from a body when it is inlined as `## Prior context` — a downstream stage reads the
  prose; the json is a machine dup of what the prose already says. Storage keeps json.

Net: the calc plan prompt went 12,911 → 6,663 chars with NO loss of real context.

### Output-quality bar (why "after-fix-2" was still too big for a trivial task)

The 6,663 was all distinct prose — but the brief/discovery stages were OVER-PRODUCING
for a trivial task: a 7-row Acceptance-Criteria table for `divide(a,b)` where AC2–AC6
were just test cases (`divide(6,2)=3`, `divide(7,2)=3.5`, …) of the same goal, plus a
6-item assumptions essay where nothing was ambiguous. That is an upstream output-quality
problem, NOT a handoff problem — the handoff was faithfully passing what the stages chose
to write.

Fix: a single cross-cutting `OUTPUT_QUALITY_STANDARD` injected into EVERY stage's system
prompt (`stageSystemPrompt`, `claude.ts`) — a QUALITY bar, not a count. It says: scale
output to the actual work; a goal/AC is a distinct user-visible outcome, NOT a test case
or a restated requirement (most features have 2–3 real goals); don't restate the request
or a prior stage; omit empty sections (e.g. assumptions when nothing was ambiguous). The
per-stage `task_brief`/`discovery`/`options_plan_test` instructions were softened to match
(one AC row per real GOAL not per test case; assumptions only when actually ambiguous; no
menu of rejected options unless a real operator fork exists). Applied uniformly so it also
governs implementation/validation/review/delivery output — not just the early stages.

Result on the SAME calc task: the brief collapsed from 7 ACs + 6 assumptions to **2 ACs
and no assumptions section** (the model itself noted style-conformance "is not a separate
user-visible goal — it is a constraint on how AC1 is delivered"). discovery 4,407 → 1,958,
planning 6,663 → 3,728 — every remaining char is signal.

### Non-goals / guards
- Do NOT inline `log` (transcripts) or `diff` bodies — large, low-signal; the agent
  reads the diff from git directly.
- Inline only the LATEST body per kind (a re-run can produce multiple).
- NO truncation — full prose bodies. Truncating planning context would force the
  downstream stage to rediscover it (the exact bug we fix). Locked decision.
- The resume path (`input.resume`) is unchanged — the session already holds context.
