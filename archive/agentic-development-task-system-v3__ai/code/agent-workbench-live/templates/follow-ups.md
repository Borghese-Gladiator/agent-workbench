# Follow-ups

<!--
TODO §1f. Forward-looking candidates for FUTURE runs. This file is
brainstormed by an LLM after validating completes; the candidates are NOT
executed by the current run. Each entry is a YAML frontmatter block with
the four required keys below.

Categories (pick one per entry):
- tech_debt: cleanup, refactor pressure, deprecated patterns
- scope_extension: things the brief explicitly deferred or stretch goals
- bug_risk: edges that look brittle; specific failure modes you didn't fix
- refactor: structural improvements that the current change made obvious
- docs: doc/comment work that the current change implied but didn't land
- deferred_from_bounce: items removed from the brief/plan via a /bounce
  and not picked up in the current run's scope (so they survive)
- no_followups: explicit "this run has nothing forward-looking" SENTINEL.
  If used, it must be the SOLE entry in the file. Empty file is invalid.

Replace the example entries below with 1–5 real entries.
-->

---
title: <short imperative title>
motivation: <why this matters; reference a concrete pain or risk>
suggested_scope: <one-run-sized chunk; what would be in vs. out>
category: tech_debt
---

Optional free-form prose explaining the candidate in more depth.

---
title: <another candidate>
motivation: <why>
suggested_scope: <scope>
category: scope_extension
---

More prose if useful.
