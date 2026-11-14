# TODO

v6 is a proof of concept. The acceptance test passes (`e2e/acceptance.sh`), but these items stand between it and an MVP.

## Gate

The gate proves a claim in a browser, or with a repo test for logic that no page shows.

- [ ] **Red on the base commit.** Run the test claims on the base commit too. A claim passes only if its test fails on the base and passes on the head. This refuses a test that passes on any code.
- [ ] **Test claims carried forward in a stack.** Task N also runs the passing test claims of the tasks below it. A replan change must not break an earlier claim.

## Test writer

- [ ] **Seed data for the proof app.** The app starts with an empty `AWB_HOME`, so the writer's sub-agents build state through the UI. That cost 13.15 USD and 7.88 USD in the UI stack. Add a `## seed` run-file section that makes a fixture once and caches it in `$AWB_HOME/repos/<repo>.seed/`, keyed by a hash of the seed script and the schema. If the cache exists, do nothing. Each proof copies the cache into its fresh temp home, so tests cannot change the shared seed. The writer prompt says which seed data exists. For awb itself: a stack with a done task, a failed task with gate rows, and a session with tool events.
- [ ] **Writer rerun for claims with no test.** In the same `awb prove`, if a claim has no test after the writer ends, run the writer once more for only those claims, then run the gate. In the UI stack, the writer ended "success, 0 turns" with C3 untested.
- [ ] **Record the cost of a writer that times out.** A timed-out writer writes no result line, so `writerEnd` returns no cost. On 2026-11-05 a stack task showed 1.52 USD, the task session only.
- [ ] **Fit the time limits together.** The task session (45 min) can start the writer (30 min) more than once, for example after `awb prove --rewrite`. Give the writer the time that is left in the session, or do not count writer time in the session limit.
- [ ] **Attach to a running proof.** A second `awb prove` for the same task gets a 409 "already running", and the agent loses the result of the first. Let `awb prove` wait for the running proof and print its result. Tell the playbook to run `awb prove` in the background.

## Runner

- [ ] **Configurable retries.** A transient API error (connection refused, overloaded, 5xx) stops the stack today. The runner resumes the session with `claude --resume` up to N times. Set N with `awb run --retries N` and `awb retry <id> --retries N`, default 1.
- [ ] **Stop a stack or a task.** `awb stop <stack id>` stops the run and every task in it. `awb stop <task id>` stops one task, in a stack or alone; the later tasks of its stack stay `waiting`. Kill only the process group of that session and its writer. Today the only way is to kill process groups by hand, and two stacks can share one group.
- [ ] **Delete stack base branches.** Each stack run leaves a base branch on GitHub. `e2e/acceptance.sh` must delete it after the PRs are retargeted or closed.
