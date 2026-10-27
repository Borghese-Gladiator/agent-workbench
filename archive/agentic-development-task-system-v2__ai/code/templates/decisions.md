# Decisions

> Lightweight ADRs scoped to this run. One entry per non-obvious choice.
>
> Format per entry:
>
> ## DR-NNN — Title (YYYY-MM-DD)
> **Status:** proposed | accepted | superseded by DR-MMM
> **Context:** what forced a decision.
> **Options considered:**
>   - A — pros / cons
>   - B — pros / cons
>   - C — pros / cons
> **Decision:** which option, and why.
> **Consequences:** what this commits us to, and what's now harder.

<!-- entries below -->

<!--
Front-half scaffold for /brainstorm:

/brainstorm spawns parallel exploration subagents (one per candidate
approach) and collates their findings into a single DR-NNN entry that
captures the choice. The first DR is typically the implementation
approach itself; later DRs cover sub-decisions surfaced during
brainstorming (dependency choice, migration strategy, etc.).

Suggested first-DR shape:

## DR-001 — <Chosen approach: short name> (YYYY-MM-DD)
**Status:** accepted
**Context:** <one paragraph drawn from normalized-feature-input.md>
**Options considered:**
  - A — <approach A>: pros (...) / cons (...)
  - B — <approach B>: pros (...) / cons (...)
  - C — <approach C>: pros (...) / cons (...)
**Decision:** <chosen letter + one-sentence rationale>
**Consequences:** <what this commits the run to, and what becomes harder>
-->

<!--
For investigation runs only: replace the block below with a real WBS once the
investigation is complete. spawn-children.sh parses the *first* '## WBS' heading
followed by a ```yaml fenced block with a top-level `children:` list.

## WBS — children to spawn

```yaml
children:
  - slug: ""        # kebab-case, starts with a letter
    repo_key: ""    # must exist in config/repos.yaml
    summary: ""     # short one-liner used as the child's raw-idea seed
```
-->
