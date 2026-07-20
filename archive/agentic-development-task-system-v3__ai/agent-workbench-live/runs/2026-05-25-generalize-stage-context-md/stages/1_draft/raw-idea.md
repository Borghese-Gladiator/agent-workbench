# Generalize the `*-context.md` cross-stage contract

Today `validate-context.md` is the only stage-boundary curated entry point — it's written deterministically by `validate --init` from prior artifacts (brief, plan, build, qa) so the reviewer reads one file instead of four. The pattern works (it's load-bearing for cache discipline; see the pass-1 dogfood's 121.8M `cache_read` tokens) and should be generalized to every LLM-bearing stage. Each `--init` step writes a `<stage>-context.md` containing exactly what the next stage needs, filtered from prior artifacts, with anchors pointing back to the full versions when the agent wants to go deeper.

## Why

Twofold leverage:

1. **Cache footprint.** File reads in the master session stick in the prefix forever. Today the builder typically reads `brief.md` + `plan.md` + occasional `decisions.md` lookups; the reviewer (without the curated context) would read all of those plus the QA report plus the build summary. Each is a permanent prefix cost. One curated file per stage collapses that into a single read.
2. **Subagent-readiness.** A self-contained `<stage>-context.md` is the natural input for an Agent-tool subagent — the master spawns the subagent with that one file as context, the subagent's reads don't pollute the master's prefix, the master gets back structured findings. This is the same pattern the existing `Explore` rule uses; the cross-stage contract makes it the default shape for every LLM-bearing stage.

## What each file contains

**`shape-context.md`** (written by `shape --init`)
- Original raw idea (verbatim from `raw-idea.md`)
- Answers from `answers.md` if present
- `brief.md` template skeleton inlined with one-line section descriptions
- The two shaping rules: no code reading, no questions

This one is thinnest — shaping has the least prior context to filter. The win is mostly inlining the template so the agent doesn't context-switch into `templates/`.

**`plan-context.md`** (written by `plan --init`)
- Full `brief.md` (small, load-bearing)
- Repo map: top-level dirs, detected languages, build/test commands from `agent-workbench.yaml` policies or inferred from the worktree
- `brief.md`'s "Files likely to change" lifted inline (the planner should validate or refute this)
- `plan.md` template skeleton with section descriptions
- Rules reminder: may read code, may not ask questions, record assumptions

**`build-context.md`** (written by `start` or on `building` entry — decision needed)
- Brief's Acceptance criteria + Non-goals (the scope-creep anchors)
- Plan's Proposed changes + Files likely to change + Test plan + Definition of done
- Filtered Decisions & assumptions from `plan.md#decisions--assumptions`
- Worktree path, branch name, base ref SHA (already in metadata, surfaced inline for the agent)
- `build.md` template skeleton
- Rules reminder: stay bounded by brief, record deviations in `build.md`

Highest leverage of the five. Today the builder typically re-reads brief and plan back-to-back at the start of the session, then dives into the worktree. `build-context.md` collapses those two reads into one curated file.

**`validate-context.md`** — already exists. This is the design template.

**`followups-context.md`** (written by `followups --init`)
- Brief's Non-goals (frequent source of follow-up candidates)
- Plan's Risks section
- Review's Decision + findings
- QA's Known issues
- Build's Deviations from plan
- `follow-ups.md` schema (category enum, frontmatter rules)
- Rules reminder: read-only, 1–5 entries or `no_followups` sentinel

## Tasks (in priority order)

1. **Build `build-context.md` first** — highest leverage, lowest risk. Mirror `validate-context.md`'s deterministic-Python shape. Decide whether it's written by `start` (at the `ready → building` boundary) or on first `/build` invocation; `start` is cleaner because the file is ready before the LLM session begins.
2. **Build `plan-context.md` next.** Will require some new code: detecting repo languages and surfacing build/test commands from `agent-workbench.yaml` policies. Some overlap with `repo-map`-style work the planner does today; the goal is to make that deterministic and front-loaded.
3. **Build `followups-context.md`.** Likely thin — most of what it needs is already in the staged artifacts; the deterministic builder is mostly a filter + headline rollup.
4. **Build `shape-context.md` last** (or skip if the inlined-template gain doesn't justify the code).
5. **Wire each into the corresponding `.claude/commands/*.md`** — step 1 reads `<stage>-context.md` rather than the prior artifacts directly. Mirror `validate.md` step 2 language: "Do NOT re-read X if `<stage>-context.md` already covers what you need."
6. **Document the contract in `docs/lifecycle.md`** — add a `*-context.md` row to each stage's table, sibling to "Reads" and "Produces."
7. **Tests:** each new `<stage>-context.md` builder gets unit tests mirroring `tests/test_validate_context.py`'s shape — synthetic prior artifacts → assert generated context has expected sections + anchor links.

## Acceptance

- Every LLM-bearing stage (`shape`, `plan`, `build`, `validate`, `followups`) has a `<stage>-context.md` generated by `--init` before the agent reads anything.
- A spot-check of three runs after the change shows the master session's prefix during each stage growing primarily from the curated file plus the worktree code the agent actively edits — not from re-reads of prior artifacts.

## Non-goals

Changing the artifact contents themselves (brief/plan/build/review keep their current sections); merging stages or changing the lifecycle; replacing template-driven artifact authoring with anything generative; building a `repo-map.md` artifact separate from `plan-context.md`'s repo-map section (keep it inline for now).

## Files likely to change

- `agent-workbench-live/lib/validate_context.py` (reference shape for the new builders)
- `agent-workbench-live/lib/cli/cmd_start.py` and/or `cmd_build.py` (where `build-context.md` gets written)
- `agent-workbench-live/lib/cli/cmd_plan.py` (`--init` writes `plan-context.md`)
- `agent-workbench-live/lib/cli/cmd_shape.py` (`--init` writes `shape-context.md`)
- `agent-workbench-live/lib/cli/cmd_followups.py` (`--init` writes `followups-context.md`)
- New `agent-workbench-live/lib/build_context.py`, `plan_context.py`, `followups_context.py`, `shape_context.py` (mirror `validate_context.py`)
- New `tests/test_build_context.py`, `test_plan_context.py`, `test_followups_context.py`, `test_shape_context.py`
- `agent-workbench-live/.claude/commands/build.md`, `plan.md`, `shape.md`, `followups.md` (point at the curated context first)
- `docs/lifecycle.md` (document the contract)

## Origin

Surfaced 2026-05-25 in a design conversation comparing agent-workbench to a proposed planner/implementer/reviewer/PR-writer system. The proposed system's "shared durable context, not many independent workers" framing matched what `validate-context.md` already does — but agent-workbench only built that pattern for the validate boundary. Generalizing is straightforward and the cache-discipline payoff is concrete.

See `docs/TODO.md` §1 for the full origin context.
