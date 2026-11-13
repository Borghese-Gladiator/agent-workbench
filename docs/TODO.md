# TODO

v6 is a proof of concept. The acceptance test passes (`e2e/acceptance.sh`), but these items stand between it and an MVP. Do the sections in order: the CLI (with awb on awb), then the UI.

## 1. CLI and core, with awb on awb

The gate proves a claim in a browser, or with a repo test for logic that no page shows.

- [ ] **Red on the base commit.** Run the test claims on the base commit too. A claim passes only if its test fails on the base and passes on the head. This refuses a test that passes on any code.
- [ ] **Test claims carried forward in a stack.** Task N also runs the passing test claims of the tasks below it. A replan change must not break an earlier claim.
- [ ] **Seed data for the proof app.** The app starts with an empty `AWB_HOME`, so the writer's sub-agents build state through the UI. That cost 13.15 USD and 7.88 USD in the UI stack. Add a `## seed` run-file section that makes a fixture once and caches it in `$AWB_HOME/repos/<repo>.seed/`, keyed by a hash of the seed script and the schema. If the cache exists, do nothing. Each proof copies the cache into its fresh temp home, so tests cannot change the shared seed. The writer prompt says which seed data exists. For awb itself: a stack with a done task, a failed task with gate rows, and a session with tool events.
- [ ] **Writer rerun for claims with no test.** In the same `awb prove`, if a claim has no test after the writer ends, run the writer once more for only those claims, then run the gate. In the UI stack, the writer ended "success, 0 turns" with C3 untested.
- [ ] **Configurable retries.** A transient API error (connection refused, overloaded, 5xx) stops the stack today. The runner resumes the session with `claude --resume` up to N times. Set N with `awb run --retries N` and `awb retry <id> --retries N`, default 1.
- [ ] **Stop a stack or a task.** `awb stop <stack id>` stops the run and every task in it. `awb stop <task id>` stops one task, in a stack or alone; the later tasks of its stack stay `waiting`. Kill only the process group of that session and its writer. Today the only way is to kill process groups by hand, and two stacks can share one group.

## 2. Web UI

Today the UI is mostly read-only. Add actions and the observability data.

- [ ] Do not add a form to start a stack. The chat writes a stack better than a form can.

## Known facts from the acceptance run

- A full run (single, bug, stack, ask) cost about 6 USD and took about 75 minutes on 2026-11-03. On 2026-11-05 it cost about 16 USD, mostly the test writer (9.55 USD), because the turn timer claims are slow for the writer (one writer: 4.56 USD). The stack part passed only with `AWB_WRITER_TIMEOUT_MIN=45 AWB_TASK_TIMEOUT_MIN=120`.
- The time limits do not fit together. A task session (45 min) can start the test writer (30 min) more than once, for example after `awb prove --rewrite`. In the 2026-11-05 stack run, the writer timed out on a claim about a live countdown, the rewrite started a second writer, and the session reached 45 min while it worked. Fix: give the writer the time that is left in the session, or do not count writer time in the session limit. A retry with `AWB_WRITER_TIMEOUT_MIN=45 AWB_TASK_TIMEOUT_MIN=120` checks if the limits are the only cause.
- `awb prove` can run longer than the agent's Bash call may wait. In the 2026-11-05 stack run, the writer ran more than 5 minutes, the agent's call gave up, and its next `awb prove` was refused with "a proof run for task ... is already running". The proof went on, but the agent lost its result. Fix: let `awb prove` attach to a running proof and wait for its result, and tell the playbook to run `awb prove` in the background.
- A writer that times out writes no result row, so its cost is not recorded. The 2026-11-05 stack task shows 1.52 USD, which is the task session only.
- Each stack run leaves a base branch on GitHub. The acceptance script must delete it after the PRs are retargeted or closed.
