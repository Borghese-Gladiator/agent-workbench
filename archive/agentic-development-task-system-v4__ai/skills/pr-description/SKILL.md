---
name: pr-description
description: Writes the delivery artifact (PR description or squash-commit summary) for the workbench delivery_prep stage. Use at delivery preparation. Reads the real branch diff + prior task artifacts and fills a fixed template where the overall change and how it was validated are obvious at a glance, and Changes Overview is a terse, file-centric list — not a re-explanation of the code. Branches on the project's delivery policy.
---

# Delivery Writer (PR description / squash-commit summary)

Write the delivery artifact for this task from the **real branch diff** and the task's
prior artifacts. The body you produce is used verbatim — for a PR it becomes the
`gh pr create --body`; for a merge it is the squash-commit message. So it must stand on
its own: a reviewer who never saw the task should grasp WHAT changed, WHY, and HOW it was
validated in under a minute — then read the code for the rest.

The daemon prepends one line naming the **active delivery policy** for this task. Follow
that line: `create_pr` → fill the PR template below; `merge_to_master` → write the tight
squash-commit summary instead. If absent, default to `create_pr`.

## The template (create_pr — fill it exactly)

Produce this structure verbatim, replacing the angle-bracket parts. Omit a section only
if it has nothing real to say (see each section's rule).

```
<ticket link, if the task references one — else omit this line>

# Description
<1–3 sentences: what this PR does and why. State any user-visible behavior change
("After this PR, X is no longer possible"). No bullet list here, no file names.>

### Changes Overview
- `<path/to/file>`<— optional: one short clause ONLY if the file's role is non-obvious>
  - <0–2 sub-bullets, ONLY for a genuinely non-obvious change in this file>
- `<path/to/next/file>`
...

# Manual Test Plan
<the REAL checks from the validation_report (commands + pass/fail) and the
demo_evidence E2E verdict, as numbered items. Add a collapsed <details> Manual Test
Script block ONLY if a real runnable snippet exists in the artifacts — otherwise omit
the block entirely. Do NOT invent a script.>
```

## Changes Overview — the rule that matters most

This section is a **true overview**, not documentation. Bias HARD toward omission:

- **It is a list of the files changed.** Every changed file gets a line, as a `code`-
  formatted path. That list alone is most of the value.
- **Default to NO sub-bullets.** A path on its own line is the norm. The diff explains
  itself; the reviewer will read it.
- **Add a sub-bullet ONLY when the change is non-obvious from the path** — a behavior
  change, a removed flag/contract, a subtle gotcha. Never to restate what the code plainly
  says, never to narrate a rename/move, never one bullet per function.
- **Group trivial companions on one line** (e.g. a deletion + its `__init__.py` unwiring,
  a setting + its registration): `` `a.py` + `__init__.py` — remove task wiring``.
- If you're tempted to explain a line of code, **delete the sub-bullet** — that's what the
  code review is for.

Litmus test: if a sub-bullet would still make sense pasted under a *different* file, it's
too vague — cut it. If it just paraphrases the diff, cut it.

## Manual Test Plan — reuse, don't invent

This section is **assembled from real artifacts in your context**, never fabricated.
There is no separate "manual test script" deliverable — so do not write a plausible-
looking one. Build it from what actually ran:

- **`validation_report`** — the static checks (typecheck / test / lint): the exact
  commands and their pass/fail. List these as numbered items. This is the spine of the
  section and is always present.
- **`demo_evidence`** — the E2E/QA verdict (PASS/FAIL), the scenarios exercised, and the
  video/trace paths if any. Cite the verdict; reference the paths. Present only when the
  task ran the QA stage (claude runtime); omit if there's no demo_evidence.
- **A `<details>` Manual Test Script block** — include ONLY if a real, runnable snippet
  exists in the artifacts (e.g. the execution plan or self-review captured a paste-able
  repro, or a persisted QA spec). Quote it verbatim with its real output. If no such
  snippet exists, **omit the block** — do not author one from scratch.
- **If a check is missing** (no E2E ran, lint skipped), say so plainly. Honest gaps beat
  invented coverage.

## How to write

1. **Get the diff.** Run `git diff <base>...HEAD --stat` then `git diff <base>...HEAD`
   (base is the project default branch). The `--stat` IS your Changes Overview file list;
   the full diff tells you which (few) files actually need a sub-bullet.
2. **Assemble the Manual Test Plan from artifacts (see the reuse rule above).** The
   execution plan, validation_report, demo_evidence, and self-review are in your context.
   Pull the real commands + outcomes from validation_report and the E2E verdict from
   demo_evidence. Only embed a Manual Test Script block if a real snippet exists in the
   artifacts. Never invent validation that didn't happen; if a check is missing, say so.
3. **Write Description last-to-first.** Lead with the one-sentence overall change, then
   why, then any behavior change. Keep it to a short paragraph — no file names here.

## The bar (exemplar — note how little Changes Overview says)

```
[CORE-591 — remove funnel-summary feature flag and legacy code](https://linear.app/...)

# Description
Deletes the legacy per-channel Funnel Summary widgets and the
`reporting_enable_multi_channel_funnel_widget` flag. After this PR, Funnel Summary by
Email/SMS/Push can no longer be created — only BY_CHANNEL remains.

### Changes Overview
- `custom_analytics/dashboard_service.py` — drop EMAIL/SMS/PUSH from FUNNEL_SUMMARY; remove the flag gate
- `custom_analytics/widget_processors/funnel_summary_processor.py`
- `custom_analytics/widget_processors/__init__.py`
- `app/tasks/performance_dashboards.py` + `app/tasks/__init__.py` — delete task wiring
- `settings/settings_celery.py`
- `tests/custom_analytics/widget_processors/conftest.py`
- `tests/custom_analytics/widget_processors/test_funnel_summary_processor.py`

# Manual Test Plan
1. `bin/pytest -m unit tests/custom_analytics/...` — touched suites green (from validation_report).
2. E2E: PASS — funnel-summary creation flow exercised (from demo_evidence).
3. Run the script below; confirm EMAIL/SMS/PUSH raise and only BY_CHANNEL remains.

<details><summary>Manual Test Script</summary>

(verbatim snippet + before/after output — present ONLY because the artifacts carried it)
</details>
```

Note: seven files changed, but only three lines carry a clause and none has a sub-bullet —
the deletions and the test files speak for themselves. Items 1–2 are quoted from the real
validation_report / demo_evidence; the script block appears only because a real snippet
existed. With no such snippet, drop the block and keep items 1–2.

## Output (merge_to_master)

For `merge_to_master`, skip the PR template. Write a tight squash-commit summary: a
subject line, a short file-centric change list (same omission rule), and a one-line
validation. No `# Description` / `### Changes Overview` / `# Manual Test Plan` headings —
those are PR-only scaffolding.

```
Cache report-builder column metadata per workspace

- `report-builder/columns.ts` — memoize getColumnDefs by workspaceId
- `report-builder/useWorkspaceSettings.ts` — invalidate on settings mutation

Validated: turbo test --filter=@klaviyo/report-builder (3 new cases), green.
```

## Required json block

End with the required ```json block — the daemon enforces `summary` and `changes`:

`{ "policy": "create_pr" | "merge_to_master", "summary": "<one-line overall change>", "changes": ["<changed file path>", ...], "validation": ["<command/result or manual step>", ...] }`

- `summary` MUST be a single concrete sentence (mirrors the Description's lead line).
- `changes` MUST be non-empty and list the **changed file paths** from the real diff (the
  Changes Overview list) — not prose, not invented files.
- `validation` MUST cite real checks (or state explicitly that a check is missing) — do
  not fabricate.
