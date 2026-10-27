# tests

Unit + integration tests for `agent-workbench-live`. Pure-stdlib; run with
the bundled `unittest`:

```
PYTHONPATH=. python -m unittest discover -s tests -p "test_*.py"
```

(Run from `agent-workbench-live/`.)

## Layout

```
tests/
  _helpers.py          Shared fixtures (tmp workbench root, cache resets).
  test_<module>.py     Unit tests, one per lib/ module.
  test_integration.py  Multi-step CLI integration tests (happy/bounce/abandon).
  test_e2e.py          Full LLM-free end-to-end smokes (TODO §1).
  fixtures/
    e2e/<scenario>/    Canned artifacts that drive E2E runs.
```

## E2E tests

`test_e2e.py` exercises every LLM-bearing stage (`shape`, `plan`, `validate`,
`followups`) without a model in the loop. Each test spins up a throwaway
git repo + a temp workbench root, then subprocesses the CLI exactly as a
human would when running the slash commands. Instead of authoring brief.md
/ plan.md / build.md / review.md / qa/report.md / HUMAN_REVIEW.md /
follow-ups.md by hand, the CLI itself materializes them from a fixture
directory pointed at by the `AGENT_WORKBENCH_STUB_LLM` env var.

### How `AGENT_WORKBENCH_STUB_LLM` works

When the env var is set to a fixture directory, the `--init` step of each
LLM-bearing subcommand (and the default mode of `followups`) overwrites
the just-staged template with the fixture's canned content. The hook
lives in `lib/stub_llm.py`:

- `shape --init` → copies `<fixture>/shaping/brief.md` to `runs/<id>/brief.md`.
- `plan --init` → copies `<fixture>/planning/plan.md`.
- `validate --init` → copies `<fixture>/building/build.md` BEFORE the
  build.md check, then `<fixture>/validating/{review.md, qa/report.md,
  HUMAN_REVIEW.md}` after templates are staged.
- `followups --init` (and `followups` default if invoked from status
  `followups`) → copies `<fixture>/followups/follow-ups.md`.

Slash command bodies (`.claude/commands/*.md`) stay unchanged — the
stubbing fires from inside the CLI's existing `--init` Bash step. The
env var is **opt-in**: nothing happens when it is unset.

A missing fixture file under `<fixture>/<stage>/` is treated as "no
content to materialize" for that step. This lets a scenario like
"abandon at draft" skip authoring shaping/planning/etc. fixtures
entirely.

### Adding a new E2E scenario

1. Create `tests/fixtures/e2e/<scenario>/` with the canned artifacts you
   want each stage to land. The minimum set for a run that reaches
   `human_review` is:

   ```
   raw-idea.md
   shaping/brief.md
   planning/plan.md
   building/build.md
   validating/review.md
   validating/qa/report.md
   validating/HUMAN_REVIEW.md
   followups/follow-ups.md
   ```

   For abandon scenarios, only the stages the run actually traverses
   need fixtures.

2. Add a test method in `test_e2e.py` that calls `_new_run(fixture, ...)`
   and then drives the CLI step-by-step with `stub_fixture=fixture`. Use
   the existing classes (`TestE2EHappyPath`, `TestE2EBounceLoop`,
   `TestE2EAbandon`) when your scenario fits one of those shapes;
   otherwise add a new subclass of `E2ECase`.

3. Assert state transitions, expected artifacts, and event ordering via
   `read_events` / `transitions_seen` / `event_types` helpers in the
   module.

### Constraints baked into the fixtures

- `follow-ups.md`'s `category:` must be one of `VALID_CATEGORIES` in
  `lib/followups.py` (`tech_debt`, `scope_extension`, `bug_risk`,
  `refactor`, `docs`, `deferred_from_bounce`, `no_followups`).
- `review.md`'s `## Decision` line must be one of `approve`,
  `request_changes`, `block` for `ReviewCompleted.review_decision` to
  parse — but the state machine doesn't gate on the value, so a
  `request_changes` review still transitions to `followups` (bounce is
  a human action issued from `human_review`).
- `brief.md`'s `## Files likely to change` (or `## Scope`) section
  drives the §1g scope-creep check. Empty section = no check.
- `build.md`'s `## Documentation touched` drives the §1d doc-claims
  check.

### Running the E2E suite alone

```
PYTHONPATH=. python -m unittest tests.test_e2e -v
```

Each test takes ~1 second (subprocessed CLI calls dominate).
