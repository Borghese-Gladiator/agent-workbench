# 010 — Project memory has a lifecycle: promotion in, eviction out

For TASK-116 and TASK-117. **This extends ADR-009; it does not reopen it.** Project memory
stays markdown projected from SQLite, the repo stays the source of truth, and there is still
no `AgentMemory` store, no memory graph and no vector store.

## The problem

Project memory had no lifecycle. Two holes, and they are the same hole seen from both ends.

**Nothing said what was worth remembering.** Any fact a run produced could be written, so the
store only ever grew. A superseded fact and a current one sat side by side with nothing to
separate them, and `queryMemory` handed both to the next planner.

**Nothing said when to forget.** `supersededBy` existed as a column and `invalidateFacts`
could set it from changed paths, but no rule said when a fact had gone stale on its own —
contradicted by a later fact on the same subject, or simply never confirmed again across many
commits.

And memory was written **only at closeout**. A session that crashed, parked, or cold-re-entered
lost everything it learned, which is a direct contributor to the non-convergence pattern in the
`qa-cold-reentry-nonconvergence` learning.

## What we borrowed, and what we declined

**Memory-OS** (layered memory with explicit promotion/eviction between layers) and **autoagent**
(a typed memory graph maintained automatically) both solve this. We take the **lifecycle idea**
from Memory-OS and the **write-as-you-learn** idea from the auto-memory writeup.

We decline the rest. No layered store — we have one table and a markdown projection, and a
promotion *rule* does not require a promotion *tier*. No memory graph, no vector store: ADR-009
settled that, and nothing here changes the reasoning.

## Decision

### 1. Promotion — what earns a place in project memory

A fact is promoted when **all** of these hold:

- **It outlives the task.** It describes the repository, not this run. "`bin/pytest` pins the
  main checkout's venv" is repository knowledge; "slice 3 failed twice" is run state.
- **It was learned, not read.** It cost something to discover — a failure, a surprising
  constraint, a convention that is not written down. A fact restatable from the code in one
  grep does not earn a row; the repo already holds it.
- **It has provenance.** At least one `sourcePaths` entry and an `observedAtSha`, so a reader
  can check whether it is still true.
- **It is falsifiable.** A concrete claim a future run could discover to be wrong. Vague advice
  cannot be superseded, so it can never be evicted, so it accumulates forever. Measured in words,
  not characters — a character count would reject a short but perfectly checkable fact.

Implemented as `qualifiesForPromotion` — pure, so the rule is testable and the same in every
caller.

### 2. Eviction — when a fact stops counting

A fact is superseded (never deleted — ADR-009 invariant #4 keeps it addressable) when:

- **A later fact explicitly replaces it.** The incoming fact names the id it supersedes, and the
  old one is marked with the replacement's id. Replacement is explicit on purpose: an earlier draft
  matched facts by a bag-of-words "same subject" key, and a key that guesses will eventually
  mis-match — silently retiring a correct, unrelated fact. Data loss is a far worse failure than a
  duplicate row.
- **Its source paths changed.** Already implemented by `invalidateFacts`; this ADR only names
  it as the same lifecycle.
- **It went unconfirmed across a staleness horizon.** An `inferred` fact not re-observed in
  `STALE_AFTER_OBSERVATIONS` later recordings is evicted. `declared` and `validated` facts are
  exempt: one is written down in the repo, the other was proven by running something, and neither
  stops being true because nobody tripped over it lately. An inference that nothing re-confirms is
  exactly what should age out.

Eviction is **not** deletion, and the markdown projection keeps rendering superseded facts under
a `## Superseded` heading. A reader can always see what we used to believe.

### 3. Capture at the moment, not at closeout

High-signal moments write immediately, so a session that never reaches closeout still leaves its
knowledge behind. The set is deliberately bounded — an unbounded capture rule is how a memory
store fills with noise:

| Moment | Kind | Why it is high-signal |
| --- | --- | --- |
| A phase loops back after a failure | `pitfall` | Something bit us, and it will bite the next run |
| A start command is validated by booting it | `command` | Expensive to rediscover; TASK-65 exists because of it |
| An adversarial review raises a blocking finding | `risk` | A real defect class this repo is prone to |
| Verification fails on the environment, not the code | `pitfall` | The `validation-false-negatives-worktree-env` case |

Closeout still runs and still compiles. It is no longer the only writer.

## Consequences

- Project memory can shrink. A run that supersedes a stale fact makes the next planner's context
  smaller as well as more correct.
- `queryMemory`'s default `supersededBy IS NULL` filter becomes the eviction boundary, so nothing
  downstream had to change to honor it.
- The promotion rule is a gate, not a suggestion: a fact that fails it is not written.
- Facts captured mid-run are visible while the task is still running, which makes a parked task's
  memory inspectable with `awb memory` rather than only after it finishes.
