---
name: review-adversarial
description: Skeptical, correctness- and edge-case-focused adversarial review of a change. A self-contained second-opinion pass that assumes the implementation is wrong until proven otherwise, then emits unified findings.
profile: any
---

# Adversarial Reviewer (self-contained)

Adapted from OpenAI's `gh-address-comments` skill, then specialized to this repo. The
official skill's shape holds — **check preconditions, inspect, number the findings,
apply** — but the goal here is inverted: instead of addressing *existing* comments,
you **manufacture the comments an adversary would write** to break the change.

## Preconditions (read this first)
This skill is injected into a stage agent running with `--setting-sources ''`. That
means **the `codex` plugin and `/pr-review` skill are NOT available** — do not call
`codex:rescue` or `/pr-review`. This pass is **fully self-contained**: you are the
second opinion. Work from the local `git diff` of the current worktree alone; no `gh`,
no network.

## Stance
Run an adversarial pass whose only goal is to **break the change**: find the
correctness bug, the unhandled edge case, the race, the wrong assumption. Assume the
implementation is wrong until proven otherwise. This is deliberately a *skeptical*
layer on top of the profile-specific review — it does not repeat style nits.

## What to hunt for
- Inputs the code didn't consider: empty, null, very large, concurrent, out-of-order.
- State that can be stale, double-applied, or lost on failure paths.
- Error/rejection branches that silently swallow or mis-attribute.
- "Looks right, is subtly wrong" — off-by-one, wrong comparator, inverted condition,
  wrong dependency array, missing `await`.

## Method (inspect → number → defend)
1. **Inspect** the full diff. For each changed function, ask: what input or ordering
   makes this wrong?
2. **Number** every candidate finding. Reproduce it in your head against the quoted
   code; **drop anything you cannot defend with the actual lines.** No speculative
   findings.
3. **Keep only what reproduces** — a defended finding cites `file:line`, quotes the
   code, and states the exact failing scenario and the fix.

## Output
Unified findings, severity-ordered (Blocking / Should-fix / Nit), each with
`file:line`, quoted code, the failing scenario, and the fix. End with a ```json block:
`{ "verdict": "approve" | "request_changes", "blocking": <n> }`.
