# Follow-ups

---
title: Record original branch on MergeConflict to ease recovery
motivation: F-001 from this run's review.md flagged that the conflict path leaves the parent branch checked out in the target repo. A human running `complete` from inside that directory will see their checked-out branch change underfoot. Recording the original branch in the `MergeConflict` event payload (and printing a recovery hint pointing at it) would let humans `git checkout -` back to where they were after they resolve the conflict.
suggested_scope: Extend `MergeConflict` payload with an optional `original_branch` field, populate it in `lib/cli/cmd_complete._do_merge`, mention it in the error message printed to stderr. Add one test in `tests/test_e2e.py::TestE2ECompleteMerge` asserting the payload field. No schema-required change — keep it `payload_optional`.
category: tech_debt
---

Could also batch with adding the same field to `WorktreeMerged` so audit-time analytics can see "this run touched my real workspace" — but defer until someone actually needs it.

---
title: Cross-run lock for concurrent completes against the same target repo
motivation: The per-run lock prevents two `complete`s on the same run from racing, but two `complete`s on DIFFERENT runs that target the same repo (a common pattern when multiple worktrees share one parent clone) can interleave their parent-branch checkouts. Today this is a latent issue the plan's R1 risk acknowledges; this run did not fix it because it was out of scope. As more concurrent runs ship, the chance of a real collision grows.
suggested_scope: Add a target-repo-level lock keyed on `realpath(repo_path)` that wraps the parent-branch checkout + merge + restore sequence. Should NOT replace the per-run lock — they nest. Test by spawning two `complete` subprocesses against the same repo with overlapping merge windows and asserting both succeed sequentially.
category: bug_risk
---

This would also let `cmd_start` reuse the same lock when creating new worktrees — currently two `start`s against the same repo can race on `git worktree add`.

---
title: Drop the legacy `local-branch:` completion_ref shape from new runs entirely
motivation: After this work, new runs default to `merge:<sha>`. The `--no-merge` escape hatch and explicit `--completion-ref` overrides are the only paths that produce `local-branch:` going forward. The board badge surfaces those runs as `⚠ unmerged`. After ~3 months of operation, the legacy shape should be deprecated outright — refuse it in `lib/metadata.save`'s validator, force humans to either merge or use a stricter override syntax.
suggested_scope: Add a soft warning in `cmd_complete` when `--no-merge` is used. After a deprecation window, tighten `schemas/run-metadata.yaml` to require `completion_ref` to match `^(merge:[0-9a-f]{40}|accepted-local-worktree:.+)$` — `local-branch:` becomes invalid. One run to add the warning, a separate later run to flip the strictness.
category: scope_extension
---

Not urgent. The badge is sufficient pressure for now.

---
title: Surface unmerged-done runs on the CLI `agent-workbench list` output too
motivation: The board renders `⚠ unmerged` for legacy `local-branch:` completion_refs, but only inside the Textual UI. Operators who script against `agent-workbench list` (the plain-text output) would still see the run as a clean `done`. A small parity gain: have `list` mark such runs with a `*` or `(unmerged)` suffix.
suggested_scope: One change in `lib/cli/cmd_list.py` (the rendering loop). One test in `tests/test_cmd_list.py`. No schema or events impact.
category: refactor
---

Trivial. Could ride alongside any other small CLI-polish run.

---
title: Add lifecycle.md to the v3 monorepo's docs/ root and link from CLAUDE.md
motivation: The lifecycle reference (`docs/lifecycle.md`) is canonical but discoverable only by reading repo-root `AGENTS.md`. This run updated the `done` section but no automated check confirms agents actually read it before running `complete`. A pointer from the project `CLAUDE.md` would close the gap; a hash-check at `agent-workbench validate` time could even fail validation when `lifecycle.md` has changed and the agent hasn't re-acknowledged.
suggested_scope: Add a `## Lifecycle reference` line to repo-root `CLAUDE.md`. Optional stretch: add `@context/lifecycle.md` import via the context-library mechanism. Skip the hash-check stretch — over-engineered for current scale.
category: docs
---
