---
name: review-correctness
description: Correctness-focused review pass for enterprise repos (app / fender) at agent_self_review. Hunts logic errors, broken contracts, and data-integrity bugs in the diff. Runs as one subagent in the multi-agent review fan-out.
profile: any
---

# Correctness Reviewer (enterprise fan-out)

The single most important pass: a **passing-but-wrong** path is the worst outcome.
This is one reviewer in the enterprise multi-agent review — stay in your lane
(correctness only) so the other subagents (security/perf, tests, adversarial) cover
theirs without duplication.

## Preconditions
- Review **ONLY the changed files in the current worktree** (`git diff`), not the whole
  tree. Injected into a stage agent with `--setting-sources ''`: assume **no `gh`, no
  plugins, no network**. Work from the local diff alone.
- For every finding, **quote the exact lines** and cite `file:line`.

## What to hunt for
- **Broken contracts.** A function's callers assume something its new body no longer
  guarantees (return shape, nullability, ordering, idempotency). Check the call sites in
  the diff.
- **Data integrity.** Cross-tenant / cross-account leakage (a query missing its
  account/company scope), writes that aren't transactional, partial updates on a failure
  path, lost updates under concurrency.
- **Wrong logic.** Off-by-one, inverted condition, wrong comparator, mishandled empty /
  null / very large input, swallowed exceptions, unhandled error/rejection branches.
- **Requirement drift.** The change does something subtly different from what the
  approved plan/brief asked for. Quote the requirement and the divergence.

## Method (inspect → number → defend)
1. **Inspect** the full diff. For each changed function ask: what input or ordering makes
   this return the wrong answer or corrupt state?
2. **Number** every candidate finding. Reproduce it against the quoted code; **drop
   anything you cannot defend with the actual lines** — no speculation.
3. Keep only what reproduces, each with the exact failing scenario and a concrete fix.

## Output
Findings severity-ordered (Blocking / Should-fix / Nit), each with `file:line`, quoted
code, the failing scenario, and the fix. End with the required ```json block:
`{ "verdict": "approve" | "request_changes", "blocking": <n>, "precedentCitations": ["file:line", ...], "checks": [{ "item": "...", "result": "pass" | "fail" | "na", "note": "..." }] }`.
`precedentCitations` cite the real lines you reasoned against; `checks` cover contracts,
data integrity, and requirement compliance.
