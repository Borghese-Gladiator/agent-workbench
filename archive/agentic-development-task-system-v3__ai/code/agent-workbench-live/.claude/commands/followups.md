---
description: Brainstorm forward-looking candidates for FUTURE runs after a run finishes validating. Writes follow-ups.md; does NOT execute anything. Use when a staged run is in `followups` (validate just transitioned it).
---

# /followups

LLM-bearing. Reads the just-finished run's artifacts and writes 1–5 forward-looking mini-briefs (or one explicit `no_followups` sentinel) to `follow-ups.md`. **Nothing is executed.** The output is a candidate list for future `/new-run` invocations.

This is a separate stage from `validating` on purpose: validation is backward-looking ("did this run satisfy the brief?"), follow-ups are forward-looking ("what's the next bite worth taking?"). Mixing them biases the review.

## Step 1 — stage the template (only if not already in `followups`)

If `agent-workbench show "$RUN_ID"` reports status `validating`:

```bash
agent-workbench followups "$RUN_ID" --init
```

That:
- transitions `validating -> followups` and stages `follow-ups.md` at the run root
- writes `runs/$RUN_ID/stages/6_followups/followups-context.md` — the curated entry point for this stage (TODO §5)

Skip if status is already `followups` (the template lives at `runs/$RUN_ID/follow-ups.md` from a prior `/validate` step's `--init` shortcut, or from a previous `/followups` attempt).

## Step 2 — read the curated context

Read `runs/$RUN_ID/stages/6_followups/followups-context.md`. That file carries brief's Non-goals, plan's Risks, review's Decision + findings, qa report's Known issues, build's Deviations from plan, and the `follow-ups.md` schema — all built deterministically from the prior artifacts.

**Do NOT re-read** `brief.md`, `plan.md`, `build.md`, `review.md`, or `qa/report.md` separately if `followups-context.md` already covers what you need. Reach directly for the source artifacts only when the curated sections are insufficient (e.g. you need to scan a full `Files changed` list, or correlate a finding with a specific file the reviewer flagged).

For bounce-deferred candidates and the events-log filter, the curated context can't help yet — read those directly:

1. `runs/$RUN_ID/events.jsonl` filtered to `BounceRequested` — items the human explicitly removed from scope via `/bounce`. These are prime candidates for the `deferred_from_bounce` category.
2. `runs/$RUN_ID/archive/2_shaping/brief-v*.md` and `archive/3_planning/plan-v*.md` (if any exist) — earlier versions superseded by a bounce. Items present in v1 but missing from the current canonical files are deferred-from-bounce.

## Step 3 — write follow-ups.md

Replace the template at `runs/$RUN_ID/follow-ups.md` with 1–5 entries. Each entry is a YAML frontmatter block:

```
---
title: <short imperative title>
motivation: <why this matters; reference a concrete pain or risk>
suggested_scope: <one-run-sized chunk; what would be in vs. out>
category: tech_debt | scope_extension | bug_risk | refactor | docs | deferred_from_bounce | no_followups
---

Optional free-form prose explaining the candidate in more depth.
```

Rules:

- **Forward-looking only.** Things to do in a FUTURE run, not corrections to this run.
- **One-run-sized.** Each candidate should be a 1–3 day chunk a single agent could plausibly implement. If it's bigger, split it.
- **Distinguish in-run findings from bounce deferrals.** If something was dropped from scope via `/bounce`, use `category: deferred_from_bounce`. Don't let those silently disappear between briefs.
- **Empty file is INVALID.** If the run genuinely has nothing to surface, write exactly one entry with `category: no_followups` and a motivation explaining the absence (e.g. "Self-contained docs change; no surface for follow-ups.").
- **No duplicates.** Each title must be unique within the file.
- **No execution.** Do not implement any of these. The whole point of this stage is to surface candidates, not act on them.

## Step 4 — finalize the transition

```bash
agent-workbench followups "$RUN_ID"
```

That:

- validates every frontmatter entry (required keys, valid category, no duplicate titles, sentinel-or-real exclusivity)
- emits `FollowupsRecorded` with `{path, entry_count, categories}`
- emits `HumanHandoffCreated`
- transitions `followups -> human_review` (the engine validates `HUMAN_REVIEW.md` carries `## Suggested first checks` and `## Run timeline`)
- moves `follow-ups.md` into `stages/6_followups/`

If validation fails it prints the errors and stops. Fix the file and re-run the command.

## Next step

Step 4's CLI invocation writes a deterministic five-section banner to `runs/$RUN_ID/stages/6_followups/stop-banner.txt` (it also prints to stdout, but the file is the durable source of truth). The banner carries the HUMAN_REVIEW.md path, summary of changes, testing line, diffstat, and the three slash-form decisions.

Show the user the banner by reading `stages/6_followups/stop-banner.txt` and relaying it **verbatim inside a fenced code block** — do not paraphrase its sections under different headings, do not re-summarize "what landed" / "validation" / "follow-ups" from other artifacts, and do not invent prose around it.

Add at most one sentence after the banner, and only if there is a real blocker the human needs to know before deciding (e.g. a known merge conflict surfaced in `review.md`). Otherwise: banner alone.

## Reference

`docs/lifecycle.md` § `followups`. TODO §1f.
