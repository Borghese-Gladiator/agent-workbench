---
description: Run an Agent Workbench validation pass. Self-review + QA + audit + handoff. Use when a run is in building and the implementation is complete enough for review.
---

# /validate

LLM-bearing. Self-reviews the worktree, runs QA, renders the audit, writes the handoff, then advances `building -> validating -> human_review`.

## Step 1 — stage templates and start validating

```bash
agent-workbench validate "$RUN_ID" --init
```

That:
- transitions `building -> validating`
- stages `review.md`, `qa/report.md`, `HUMAN_REVIEW.md` (staged runs) or `implementation-summary.md` / `diff-summary.md` / `review.md` / `qa/report.md` / `handoff.md` (legacy flat runs)
- creates `qa/{artifacts,recordings,traces}/` and `qa/commands.txt`
- **pass-2**: writes `stages/5_validating/validate-context.md` and `stages/5_validating/blast-radius.txt` (deterministic Python; no LLM call). These are the curated entry point for the rest of the steps below.
- **pass-2**: if the building session crossed the staleness threshold, prints a fresh-session handoff block. **Exit Claude Code and restart in a fresh session** when you see that block — the new session bootstraps from `validate-context.md` and has everything it needs.

## Step 2 — read the curated context

Read `runs/$RUN_ID/stages/5_validating/validate-context.md`. That file is the curated entry point: it carries the original task, acceptance criteria, filtered plan decisions/assumptions, the diff (or a summary if too large), files changed, commands run, test results, and known issues — all built deterministically from the existing artifacts.

**Do NOT re-read** `brief.md`, `plan.md`, `build.md`, or `qa/report.md` separately if `validate-context.md` already covers what you need. Read them directly only when `validate-context.md` points you at a specific section that needs a deeper look.

For multi-file exploration (more than 3 files for understanding, not editing), route through an `Explore` subagent — see `agent-workbench-live/AGENTS.md` § "Subagent discipline".

## Step 3 — review

Be adversarial. The reviewer is not the builder. Answer from `validate-context.md`:

- Did the implementation satisfy the brief?
- Did it accidentally expand scope?
- Are there fragile assumptions?
- Missing tests?
- Security / data loss / migration risks?
- What should the human review first?

Write `review.md` with a Decision (`approve` | `request_changes` | `block`) and any findings.

### Blast radius

Read `runs/$RUN_ID/stages/5_validating/blast-radius.txt`. That file has the depth-1/2/3 caller tree, pre-computed by `validate --init` from `git diff` + `git grep`. Summarize anything notable in `review.md` under a `## Blast radius` heading. Flag any depth-2/3 file that lives OUTSIDE what `brief.md`'s expected-scope section anticipated.

The CLI's `validate` command separately handles depth-1 scope creep — if it finds any, it appends a `## Scope creep check` section to `review.md` for you; mention it in your Blast radius narrative if so.

## Step 4 — QA

Pick QA passes appropriate for the repo (any of):

- unit tests
- integration tests
- lint / typecheck
- Playwright (MCP or direct)
- smoke scripts

For each command, append it to `qa/commands.txt` (one per line) and put outputs/screenshots in `qa/artifacts/` or `qa/recordings/`.

Write `qa/report.md` summarizing results: what ran, what passed, what failed, what was not tested.

## Step 5 — handoff

Write `handoff.md`. Keep it short:

- branch + worktree paths
- what was built
- what works
- what doesn't / known issues
- a short ordered list of things the human should check first

## Step 6 — finalize the transition

```bash
agent-workbench validate "$RUN_ID" --tests-passed true --known-issues 0
```

That:
- emits `ReviewCompleted` (decision parsed from `review.md`)
- emits `QACompleted`
- renders `audit.md` from events + artifacts
- emits `AuditRendered`
- verifies the `Documentation touched` claims in `build.md` against the worktree diff (TODO §1d); unverified claims are appended to `review.md` as a `## Documentation claims` section
- **staged runs**: transitions `validating -> followups`. The human handoff is NOT emitted here — `/followups` does that. Next step is to run `/followups` to brainstorm forward-looking candidates for future runs.
- **flat-layout legacy runs only**: emits `HumanHandoffCreated` and transitions `validating -> human_review` directly.
- prints branch, worktree, audit path

## Next step

Tell the user:
- **staged runs**: run `/followups` next to write `follow-ups.md` (1–5 candidate next-run ideas).
- **flat-layout legacy runs**: the run is in `human_review`. They can `/complete`, `/bounce`, or `/abandon`.

## Reference

`docs/lifecycle.md` § `validating` and § `human_review`.
