# 003 — Deterministic completion policy, not agent self-report

## Decision

No agent session can advance the task lifecycle. Agents (planner, plan
critic, builder, verifier, QA, reviewer) only ever return a
`PhaseAttemptResult` — a candidate plus evidence, or a repair/replan/
await-human/blocked/cancelled outcome. A pure, deterministic function,
`evaluatePhaseCompletion(candidate, context)`, is the only code path that
decides a phase is complete and the lifecycle should advance.

## Why

This is the single most direct fix for v4's stated archival reason:
"Lifecycle stages were not enforced well enough. Tasks would move through
towards completion." An agent claiming success is not evidence of success —
it can be wrong, it can hallucinate a passing test, or it can simply not run
one and report as if it had. Making completion a property of *evidence*
(exact candidate SHA, exact environment digest, exact policy version, a
concrete evidence/finding ID list) rather than a property of an agent's
closing message removes an entire class of "the agent said it was done" bugs
by construction.

This also directly targets the second archival reason — "QA artifacts were
different every time... it was RNG if it produced something I could use to
actually verify functionality." Exercise-phase completion requires a
recorded video/trace *and* passing structured assertions tied to the exact
candidate SHA; a video alone is explicitly insufficient — `deriveQaStatus()`
in `packages/qa/src/shared.ts` is the single place that pass/fail is decided.

## Alternatives considered

- **Trust the agent's final message/exit status** (closer to how earlier
  iterations worked, informally). Rejected for the reason above.
- **A second "verifier" agent that decides completion.** Rejected: still an
  agent decision, still capable of the same class of error, just one layer
  removed. The completion *policy* itself needs to be deterministic code that
  inspects concrete evidence records, not another model call.

## Consequences

- Every phase needs an explicit, enumerable completion checklist that can be
  expressed as boolean/count checks over a
  `CompletionContext` snapshot — see `packages/workflow/src/completion-context.ts`
  and `evaluate-completion.ts`. Adding a new completion requirement means
  editing that pure function and its test table, not adjusting a prompt.
- Evidence records must carry exact identifiers (`candidateSha`,
  `environmentDigest`, `contractVersion`, `planVersion`, `policyVersion`) so
  the completion policy can check "is this evidence about the thing that
  currently exists," not just "does passing evidence exist somewhere."
- This pushes real engineering cost onto the workbench (writing and
  maintaining `evaluatePhaseCompletion` and the invalidation cascade) instead
  of onto prompt engineering — a deliberate trade given prompt-only
  enforcement is exactly what didn't hold up across v1–v4.
