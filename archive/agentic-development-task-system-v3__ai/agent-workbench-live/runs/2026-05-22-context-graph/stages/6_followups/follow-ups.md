# Follow-ups

<!--
Note: an earlier "Wire context imports into the remaining slash commands"
entry was removed when the per-command `Context:` lines were reverted
in this run. If drift later argues for explicit imports, the path is
documented in build.md § Deviations from plan.
-->

---
title: Project-specific overlay for the workbench-itself stdlib-unittest convention
motivation: DR-003 in plan.md deliberately kept `@context/languages/python/testing.md` describing the generic Poetry + pytest default. That leaves the workbench-itself convention (stdlib `unittest`, `tests/_helpers.ROOT`, no pytest) documented only in `agent-workbench-live/AGENTS.md`. A future agent dropping into the workbench-itself codebase has to read two places to understand "no, here we use unittest."
suggested_scope: Either (a) add `agent-workbench-live/context/local/python-testing.md` overlay that points back at AGENTS.md and overrides the generic default, plus a `Context:` import in any workbench-itself slash command that touches tests; or (b) a single `local/` section in `context/README.md` pointing at the AGENTS.md anchors. No change to the generic Python files.
category: docs
---

Avoids a future "wait, you said pytest" mismatch when an agent reads only the context file. Pick (a) or (b) when the friction first shows up.

---
title: Lint-style test for AGENTS.md not inlining the context file list
motivation: The brief is emphatic that AGENTS.md must reference `@context/README.md` and NOT inline the file list. The current invariant suite checks the leaf files and the README index, but not the AGENTS.md surfaces. A drive-by edit that inlines a couple of paths into AGENTS.md would slip past CI.
suggested_scope: Add one assertion to `tests/test_context_library.py` (or a new test): grep the two AGENTS.md files for `@context/` paths that match a leaf file (not the README). If any leaf path appears in AGENTS.md text outside the README index, fail with a pointer to which line. Keep the rule narrow — referencing `@context/README.md` is fine; enumerating leaves is not.
category: bug_risk
---

Locks in the brief's "do not inline" rule before it has a chance to rot.

---
title: Extend the four-marker template to a frontmatter or schema-checked form
motivation: Today the template is enforced by substring match: `Applies when:` must appear somewhere in the file. That catches the gross case (missing marker) but not finer-grained drift — e.g. an `Applies when:` followed by an empty line, or markers in the wrong order, or a renamed `Do also:` masquerading as compliance.
suggested_scope: Optional. Either (a) require markers as proper headings (`## Applies when`) and assert order + non-empty body via the test, or (b) add a tiny YAML frontmatter block (`applies_when: …`, `do: […]`) that the test parses. Choose only if drift actually starts happening; right now it's hypothetical.
category: tech_debt
---

Defer until we see real-world drift. Listed so a future audit notes that "stronger enforcement" has been considered.
