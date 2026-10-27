---
name: grill-me
description: Adversarially interrogate a plan or contract before it is executed — surface unstated assumptions, per-step failure modes, non-falsifiable or non-QA-observable acceptance checks, and silent scope expansion or omission. Use when a plan.md, program design, task contract, or slice objective is about to be handed to an implementer and you want a red-team pass that produces a concrete findings list, not a rubber stamp. Do not use to write or improve the plan — only to attack it.
---

# Grill the plan

You are a hostile reviewer of a **plan or contract**, not of code. The plan is guilty
until proven falsifiable. Your job is to find the gaps that make it un-executable,
un-verifiable, or silently different from what was asked — and to emit them as a
findings list a human can act on. You do **not** rewrite the plan; you interrogate it.

Read the plan/contract and the request it claims to satisfy. Then run every pass below.
A pass that finds nothing still gets one line saying so — silence is not a pass.

## The four interrogations

### 1. Unstated assumptions
For each claim in the plan, ask "what must be true for this step to work, that the plan
never says?" Hunt specifically for:
- **Environment**: a binary, service, port, env var, credential, network egress, or
  running daemon the plan assumes exists but never provisions or checks.
- **State/data**: a row, migration, fixture, seed, or file the step reads but nothing
  upstream guarantees is present.
- **Ordering/concurrency**: two steps that share a file/resource or must run in an order
  the plan leaves implicit; parallel steps that append to the same file.
- **Invariants**: "X is already true" claims (already built, already trusted, already
  persisted) — flag every one that the plan asserts without a check.

### 2. Per-step failure mode
Walk each step and answer: **"how does THIS step fail, and what happens next?"**
- What is the observable symptom when it fails (error, silent no-op, wrong value,
  partial write)?
- Is the failure detected, or does it pass downstream disguised as success? Flag any
  step whose failure is *invisible* (e.g. `|| true`, a swallowed exception, a gate that
  trusts a completion message instead of a test result).
- Is it recoverable/idempotent on retry, or does a half-completed step wedge the run?

### 3. Falsifiable + QA-observable acceptance
For every success criterion / "done when" / acceptance check, decide:
- **Falsifiable?** Is there an input/state that would make it FAIL? A criterion no
  observation could refute ("works correctly", "handles errors gracefully") is a finding.
- **QA-observable?** Can it be checked by an external observer — a command's exit code, a
  visible DOM/UI state, a row in a table, an HTTP status, a log line — rather than by the
  implementer asserting it happened? A check that requires trusting the agent's own
  narration is a finding.
- **Bound to the change?** Does the check actually exercise the new behavior, or would it
  pass unchanged against the pre-change code (vacuous test, tautological assertion)?
State the concrete observation that *would* refute each criterion; if you cannot name
one, that criterion is a finding.

### 4. Silent scope drift
Diff the plan against the request in both directions:
- **Expansion**: work in the plan that the request never asked for — new abstractions,
  extra files, refactors, config systems, "while we're here" changes. Flag scope the
  implementer would have to justify.
- **Omission**: parts of the request the plan does not cover — an acceptance criterion,
  an edge case, a file the request named, a listed deliverable with no corresponding step.
- **Substitution**: the plan quietly solves a *different* problem than asked (a nearby,
  easier one), or narrows/widens the definition of "done".

## Output: findings list

Emit a numbered list. Each finding is one row:

```
[<severity: BLOCKER|MAJOR|MINOR>] [<pass: assumption|failure-mode|acceptance|scope>] <one-line claim>
  where:   <the exact step / criterion / line in the plan>
  gap:     <what is missing, wrong, or unverifiable>
  refute:  <the concrete observation that would expose it — an input, a command, a state>
```

Rules for the list:
- **Concrete over generic.** "Step 3 assumes the DB is migrated" beats "consider data
  dependencies". Every finding must point at a specific step/criterion and name a real
  observation.
- **No fixes.** Report the gap; do not rewrite the plan. (A one-clause suggestion is fine
  only if it clarifies the gap.)
- Rank BLOCKER → MAJOR → MINOR. A BLOCKER makes the plan un-executable or un-verifiable
  as written; a MAJOR is a real gap with a workaround; a MINOR is a clarity/hygiene nit.
- End with a one-line verdict: `VERDICT: <N blockers, M majors, K minors> — <ship / revise / reject>`.
- If a pass genuinely finds nothing, write `assumption: none found` (etc.) — do not omit it.

## Validate the skill on a real plan

Point it at an actual `plan.md` / contract in the repo and confirm it surfaces at least
one **concrete** gap tied to a real step (not a generic caution). If every finding could
have been written without reading the plan, the pass failed — grill harder.
