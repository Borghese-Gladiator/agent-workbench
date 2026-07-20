# agent-workbench-live

The working implementation of Agent Workbench. Get a run from "a vague
idea" to "a branch ready for review" in about 10 minutes.

The design lives one level up (`../architecture.md`, `../docs/lifecycle.md`, `../schemas/`). This folder is the running system.

## Implementation status

See `../docs/TODO.md` for the full implementation plan. Sections checked off in order.

---

## Prerequisites

- Python 3 (stdlib only for the core CLI — no `pip install` needed for everything except the live board).
- `git` on `PATH`.
- A target git repo to work against (or a path where one should be created).
- **Optional**: `pip install -r requirements-board.txt` to enable the live TUI under `agent-workbench board`. The static fallback (`board --static`) stays stdlib-only.

## 1. Add the CLI to your PATH

From inside this folder (`agent-workbench-live/`):

```bash
cd /path/to/agentic-development-task-system-v2__ai/agent-workbench-live
export PATH="$PWD/bin:$PATH"
```

Verify:

```bash
agent-workbench doctor
```

You should see `doctor: PASS`. If it fails, run `agent-workbench doctor` and follow the missing-file hints.

Make it permanent (optional):

```bash
echo 'export PATH="/path/to/agent-workbench-live/bin:$PATH"' >> ~/.zshrc
```

## 2. Sanity-check the test suite

```bash
cd /path/to/agent-workbench-live
python3 -m unittest discover -s tests -v
```

You should see a passing run (`OK` at the bottom). If anything fails, stop and report it — the system isn't safe to use against your code.

## 3. Run #1: a tiny existing-repo run

Pick a real repo to target (anything is fine — we won't touch its working tree). Create a one-line idea file:

```bash
mkdir -p /tmp/aw-demo
echo "Add a hello endpoint." > /tmp/aw-demo/idea.md
```

Create the run:

```bash
agent-workbench new-run \
  --repo-path /path/to/some/repo \
  --worktree-name hello-endpoint \
  --idea-file /tmp/aw-demo/idea.md
```

The CLI prints a `run_id` like `2026-05-18-hello-endpoint`. **Save it** — you'll pass it to every subsequent command. (Tip: `RUN_ID=$(agent-workbench new-run ...)`.)

## 4. Walk the lifecycle

The 8-state lifecycle:

```text
draft -> shaping -> planning -> ready -> building -> validating -> human_review -> done
```

Each step has a CLI command. The three LLM-bearing steps (`shape`, `plan`, `validate`) work in **two phases**: `--init` (stage templates + transition in) and a finalizer (verify the artifacts + transition out).

### Shape

```bash
agent-workbench shape "$RUN_ID" --init
```

This transitions `draft -> shaping` and stages `runs/$RUN_ID/brief.md` from the template. **Now you (or an agent) writes the brief**: open `runs/$RUN_ID/brief.md` and fill out Goal, User-facing behavior, Acceptance criteria, Non-goals, Constraints, etc. Code-blind — don't read the target repo yet.

When the brief is complete:

```bash
agent-workbench shape "$RUN_ID"
```

That verifies `brief.md` is non-empty and transitions `shaping -> planning`.

### Plan

```bash
agent-workbench plan "$RUN_ID" --init
```

Stages `plan.md`, `preflight.md`, `assumptions.md`, `decisions.md` from templates. **Now write the four artifacts** — this is the phase where you may read the target repo. Use `ASM-001`, `ASM-002` headings in `assumptions.md` and `DR-001`, `DR-002` in `decisions.md`.

When all four are complete:

```bash
agent-workbench plan "$RUN_ID"
```

That parses out the assumption / decision IDs into `events.jsonl`, emits `PreflightCompleted`, and transitions `planning -> ready`. Inspect the result:

```bash
agent-workbench show "$RUN_ID"
```

### Start

You (the human) approve and create the branch + worktree:

```bash
agent-workbench start "$RUN_ID" --approved-by "$USER"
```

This:

- Verifies all five pre-implementation artifacts are non-empty.
- Runs `git worktree add -b agent/hello-endpoint <worktree_path> HEAD` against your target repo.
- Transitions `ready -> building`.
- Prints the worktree path.

`cd` into the printed worktree path. Implement your change there with normal commits. **Do not edit the original checkout.**

### Validate

When implementation is "complete enough for review":

```bash
agent-workbench validate "$RUN_ID" --init
```

This transitions `building -> validating` and stages five more templates (`implementation-summary.md`, `diff-summary.md`, `review.md`, `qa/report.md`, `handoff.md`) plus QA folders.

Fill those out — see `docs/lifecycle.md` § `validating` for the contract. The `review.md` should be adversarial (the reviewer is not the builder), and `qa/report.md` should record what you ran.

When done:

```bash
agent-workbench validate "$RUN_ID" --tests-passed true --known-issues 0
```

This:

- Emits `ReviewCompleted` (decision parsed from your `review.md`).
- Emits `QACompleted`.
- Renders `runs/$RUN_ID/audit.md` from the events + artifacts.
- Emits `HumanHandoffCreated`.
- Transitions `validating -> human_review`.

### Complete or bounce

Inspect the handoff:

```bash
agent-workbench handoff "$RUN_ID"
```

If you like what you see, accept:

```bash
agent-workbench complete "$RUN_ID" --accepted-by "$USER"
```

That transitions `human_review -> done`.

If you want changes:

```bash
agent-workbench bounce "$RUN_ID" \
  --reason "tests are too thin around edge cases" \
  --requested-by "$USER"
```

That transitions `human_review -> building`. The branch and worktree are preserved. Re-implement, then `validate --init` and `validate` again.

If you want to stop entirely:

```bash
agent-workbench abandon "$RUN_ID" --reason "..." --abandoned-by "$USER"
```

Artifacts are preserved; the run is terminal.

## 5. Inspect anything

```bash
agent-workbench list                    # all runs
agent-workbench list --status building  # filter
agent-workbench show "$RUN_ID"          # metadata + artifact paths
agent-workbench events "$RUN_ID"        # event log
agent-workbench events "$RUN_ID" --type TransitionApplied
agent-workbench events "$RUN_ID" --raw  # one JSON per line
```

## 6. Using the slash commands (if you're in Claude Code)

If you `cd` into `agent-workbench-live/` from a Claude Code session, the slash commands under `.claude/commands/` become available:

- **Thin wrappers**: `/new-run`, `/start`, `/handoff`, `/complete`, `/bounce`, `/abandon`, `/runs`, `/run-show` — these just front the CLI so the model picks the right invocation.
- **LLM-bearing**: `/shape`, `/plan`, `/validate` — these contain the prompts that tell the model what to read, what to write, and how to finalize. Use these instead of writing artifacts by hand.

## 7. Starting a brand-new repo

If you don't have a repo yet:

```bash
agent-workbench new-run \
  --new-repo-path /Users/me/projects/my-new-thing \
  --worktree-name bootstrap \
  --idea-file /tmp/aw-demo/idea.md \
  --scope-kind bootstrap
```

This creates the repo at the given path with a monorepo scaffold (`README.md`, `docs/`, `backend/`, `frontend/`) and an initial commit, then creates the run pointing at it. From here the lifecycle is identical.

## Where things live

```text
agent-workbench-live/
  AGENTS.md             # how an AI agent should operate here
  README.md             # this file
  agent-workbench.yaml  # workbench config (paths, defaults, policies, gates)
  bin/agent-workbench   # the CLI
  lib/                  # Python modules (stdlib only)
    config.py           # workbench config loader
    metadata.py         # runs/<run_id>/metadata.yaml read/write
    events.py           # append-only event log
    transitions.py      # the state machine
    locks.py            # per-run filesystem lock
    repos.py            # git + worktree manager
    audit.py            # render audit.md
    run_ids.py          # run_id / slug / branch / worktree naming
    yaml_io.py          # stdlib YAML reader/writer (flat subset)
  schemas/              # transition + metadata + event schemas
  templates/            # artifact stubs
  .claude/commands/     # slash commands
  scripts/              # deterministic bash glue
  tests/                # unit + integration
  runs/<run_id>/        # one dir per run (created lazily)
    metadata.yaml       # SOURCE OF TRUTH for state
    events.jsonl        # SOURCE OF TRUTH for history
    raw-idea.md
    brief.md
    plan.md
    preflight.md
    assumptions.md
    decisions.md
    implementation-summary.md
    diff-summary.md
    review.md
    qa/
      report.md
      commands.txt
      artifacts/
      recordings/
      traces/
    audit.md
    handoff.md
  worktrees/<repo>/<name>/   # one dir per active worktree
```

## Key rules to remember

1. **Only `draft` may ask the human clarifying questions.** After that, record an assumption, make a decision, or stop.
2. **Never edit `metadata.yaml`'s `status` directly.** Only the transition engine does that. If something looks wrong, use `events`/`show` to inspect.
3. **Implementation happens in the worktree, never in the original checkout.**
4. **A failed command does not auto-abandon a run.** Repair, retry, or hand off with known issues — the audit captures what happened.

## Troubleshooting

- **"current state is terminal"** — the run is `done` or `abandoned`. Start a new run.
- **"missing required evidence"** — `agent-workbench events $RUN_ID --type TransitionRejected --raw` shows the exact `missing_evidence` list.
- **"run is locked"** — a previous mutating command crashed before releasing the lock. Inspect `runs/<run_id>/.lock` and remove it if you're sure no other process is running.
- **`brief.md missing or empty`** — finalizers refuse to advance if their required artifacts are blank. Fill the template first.
- **doctor fails on schemas** — one of `schemas/{events.jsonl,run-metadata.yaml,transitions.yaml}` failed to parse. Re-run `agent-workbench doctor` for the line-level error.

## Reference

- `AGENTS.md` — the contract for any AI agent driving the workbench.
- `../architecture.md` — why the system is shaped this way.
- `../docs/lifecycle.md` — every stage's full contract.
- `schemas/transitions.yaml` — the formal state machine.
