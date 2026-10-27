# V2 spike results

Date: 2026-10-22. Target: `browser-games__ai`, Tic-Tac-Toe scoreboard. Draft PR: https://github.com/Borghese-Gladiator/browser-games__ai/pull/50

Tools: `@playwright/test` 1.61.1 in the target repo, Playwright Test Agents from `init-agents --loop=claude`, Claude Code 2.1.308 in headless mode (`claude -p`).

## Setup differences from the plan

- I built a new feature (a scoreboard) instead of reusing a past PR. It was cheaper and kept the test honest. The claims were written before the code.
- The repo has its own heavy Playwright config (gateway plus four players). I added `playwright.proof.config.js` (Vite only) and pointed the MCP server at it with `-c` in `.mcp.json`.
- I ran the agents in separate headless sessions that started without the code context. The feature code came from a different session.

## Results

| Experiment | Result | Evidence |
| --- | --- | --- |
| 1. Happy path | **Pass** | 11 tests from 6 claims. I ran them: 11 passed. The gate passed 6 of 6 claims. Each claim has a video and a trace. The assertions check counters and status text, not only that a page loads. Session cost about 0.91 USD. |
| 2. Planted bug (X wins not counted) | **Pass** | 5 tests failed. The gate failed C1, C2, C4, C5, C6. The healer session changed no files. It named the buggy line and said that editing tests would hide the bug. Cost about 0.21 USD. |
| 3. Independence (a draw counts twice) | **Pass** | A fresh session wrote tests from scratch. It had a deny rule for reading `games/`, `packages/` and `portal/`. Only the C3 test failed. It asserts "Draws shows 1". The source was not edited. No test was skipped. Cost about 1.15 USD. |
| 4. Comparison with v5 `exercise` | **Not run** | It needs a live v5 run with real tokens. Run it only if you want the numbers. |

## Findings

1. **The proof design works on this case.** Playwright Test Agents plus a 60-line gate give claim-linked video and trace. The gate caught both planted bugs.
2. **The healer did not hide the bug in one run.** I limited it to `proof-tests/` and gave it no instruction to make tests pass at any cost. The docs say it may skip tests. A single sample does not show that this never happens. Keep the gate rule that rejects `skipped` and `fixme`.
3. **Prompt limits matter.** The prompts said "edit only these folders" and "do not change the test to match the app". Put both rules in the v6 `prove` step. I did not test what happens without them.
4. **Scope of the read ban was not audited.** I set deny rules for `Read(games/**)` and so on. I did not check the session log to prove that it never read the source by another tool.
5. **Extra tests under one claim id can fail the claim.** In experiment 2 a negative reload test was titled with `C1`. It made C1 fail even though the "starts at zero" test passed. This is the safe direction. Decide in v6 if it is wanted.
6. **The agent's final message is not proof.** In experiment 3 the final message talked about an old Vite server and did not list the tests. In experiment 1 the agent said it did not re-run the tests. The gate and my own run of the tests were the proof. This supports the v6 rule that only code decides.
7. **The plan file has stale paths.** The planner wrote test paths under `tests/`, but the config uses `proof-tests/`. The generator followed the prompt. The v6 playbook must state the folder.
8. **Setup cost is real.** Steps that were needed: install Chromium, add a config, edit `.mcp.json`, edit the seed file. The full repo `npm run lint` fails on an old nested worktree folder in the target repo.

## Limits of this spike

- One small feature, one repo, simple UI, three runs.
- No test on a large app such as fender. No test of state that needs login or a database.
- No test of the rest of v6: the `ag` launcher, hooks, task list, delivery.

## Decision

Go for phase 1, with these changes to the plan:

1. Keep the gate as written. Add one check: reject a test file that changed after the gate saved the commit.
2. Put the folder rules and "do not change the test to match the app" into the `prove` step text.
3. Run a second spike on fender before phase 4 (task DAG), to check app complexity and start-up cost.
4. Run experiment 4 only if you want a cost and time comparison with v5.
