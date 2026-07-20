# Human review — <run_id>

<!--
Persona-keyed hub for the human reviewer. Replaces handoff.md for staged runs
(TODO §1c). Keep this file SHORT — routing + a smoke checklist + a timeline.
The transition validating → human_review fails if the two required headings
below are missing.
-->

## Where to start

- Want to see diffs? → `stages/4_building/build.md`
- Want to verify QA? → `stages/5_validating/qa/report.md` (+ `qa/commands.txt`)
- Want to confirm each AC is tested? → `stages/4_building/build.md` § Acceptance criteria coverage
- Want to argue with decisions? → `stages/3_planning/plan.md` § Decisions & assumptions, then `stages/5_validating/review.md`
- Want to see what's next? → `stages/6_followups/follow-ups.md`

## Suggested first checks

<!--
REQUIRED. Ordered, copy-pasteable checklist from clean checkout to verified
working feature in ~10 minutes.

Format (see TODO §1c):
1. Automatable steps first as a single fenced bash block (install, build,
   tests, server start). Don't interleave commands with prose.
2. Then numbered manual / browser steps, each with exact UI actions and
   concrete test data.
3. Close with "If steps 1–N pass, the run is delivered."
-->

```bash
# Automatable steps — fill in.
```

1. <manual step 1>
2. <manual step 2>

If steps 1–N pass, the run is delivered.

## Run timeline

<!--
REQUIRED. Chronological summary rendered from events.jsonl. Folded in from
the old audit.md (TODO §1b). For this pass the audit module still writes
audit.md at run root; copy or link its content here.
-->
