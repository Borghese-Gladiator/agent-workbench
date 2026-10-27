# V2 spike plan: can Playwright prove that a feature works?

This plan tests the riskiest idea in `docs/v6-proposal.md` before any v6 code exists. Time budget: 1 to 2 days.

## What I verified on 2026-10-22

| Question | Answer | Evidence |
| --- | --- | --- |
| Does Playwright ship planner, generator and healer agents? | Yes. Added in v1.56. | Official docs, `playwright.dev/docs/test-agents` |
| Does the setup command exist? | Yes: `npx playwright init-agents --loop=claude`. Other loops: `codex`, `copilot`, `opencode`, `vscode`. | I ran it with `@playwright/test` 1.64.1 |
| What does it write? | `.claude/agents/playwright-test-{planner,generator,healer}.md`, `.mcp.json`, `seed.spec.ts`, `specs/README.md`. | I ran it. |
| Which MCP server do the agents use? | `playwright-test`, started with `npx playwright run-test-mcp-server`. | The generated `.mcp.json` |
| Does Playwright give video, trace and a JSON report? | Yes. With `video: 'on'`, `trace: 'on'` and the `json` reporter, each result lists a `video` and a `trace` path. | I ran two tests. One passed. One failed on purpose. |
| Does the report link a test to a claim? | Yes, through the test title (for example `C1: ...`). Tags such as `@C1` also exist. | The report has `title` and `tags` fields. |
| Does the planted failure show in the report? | Yes. Status `failed`. Video and trace exist for the failing test too. | I ran it. |

What I did not verify: the quality of tests that the agents write on a real repo. The spike tests this.

## Facts that change the design

1. **The healer can hide a bug.** The docs say it may skip a test if it believes the feature is broken. A skipped test must never count as proof. The gate must fail a claim whose test is skipped or marked `fixme`.
2. **The healer edits test code.** It can weaken an assertion until the test passes. The spike must check for this (experiment 2).
3. **Browsers are not installed by default.** Run `npx playwright install chromium` once. Without it, every test fails with "Executable doesn't exist".
4. **`init-agents` overwrites files.** It replaced `.mcp.json` in other people's repos. Run it in a clean branch. Re-run it after each Playwright upgrade.
5. **The seed file is empty.** It must start the app, or the config needs a `webServer` entry. The planner runs the seed first.
6. **The agents default to the Sonnet model** (`model: sonnet` in the agent files). Change it in the file if you want another model.

## Target

Use a small repo with a real browser UI and a past feature that the workbench built. My notes list `browser-games__ai` (PRs #7, #8, #11). It is small and its dev server starts fast. Do not use fender for the first spike. It is too heavy.

I need from you: the local path of the target repo, and one past PR to use.

## Setup (30 minutes)

1. Create a spike branch from the commit before the PR.
2. Cherry-pick the PR code onto a second branch, `spike-feature`. Keep the branch before the PR as `spike-base`.
3. In the repo, run `npm i -D @playwright/test@1.64.1`.
4. Run `npx playwright install chromium`.
5. Run `npx playwright init-agents --loop=claude`.
6. Edit `playwright.config.ts`:
   - `use: { video: 'on', trace: 'on' }`
   - `reporter: [['json', { outputFile: 'proof/report.json' }]]`
   - `webServer: { command: '<repo start command>', url: '<app url>', reuseExistingServer: true }`
7. Edit `seed.spec.ts` so that it opens the app home page.
8. Write `claims.md` by hand: 3 to 5 claims with ids `C1`, `C2`, and so on. Each claim is one sentence that a browser test can prove false.

## Gate script (about 60 lines)

File: `spike/gate.mjs`. It reads `proof/report.json` and `claims.md`. It prints a table and exits non-zero if any claim fails.

A claim passes only if all of these are true:

1. At least one test title contains the claim id.
2. Every such test has status `passed`.
3. No such test is `skipped`, and no test file has `test.fixme` or `test.skip` for that id.
4. The `video` and `trace` files exist on disk.
5. The `git rev-parse HEAD` value equals the SHA saved in `proof/sha.txt` when the tests ran.

Do not add more checks in the spike. Add them in v6 only if the spike shows a need.

## Experiments

### Experiment 1: happy path

1. Check out `spike-feature`.
2. Start a fresh Claude Code session in the repo. Do not reuse the session that wrote any code.
3. Prompt: "Use the playwright-test planner on claims.md. Then use the generator. Put the claim id at the start of each test title. Then use the healer until all tests pass. You must not edit files outside `specs/` and `tests/`."
4. Save the SHA: `git rev-parse HEAD > proof/sha.txt`.
5. Run `npx playwright test`.
6. Run `node spike/gate.mjs`.

Pass: the gate passes every claim, and you can watch each video and see that it shows the claim.

### Experiment 2: planted bug (the important one)

1. Check out `spike-feature`. Break the behavior of claim C2 in the source code. Commit the break.
2. Run `npx playwright test` with the tests from experiment 1. Run `node spike/gate.mjs`.
3. Pass: the gate fails C2.
4. Now run the healer on the failing test. Use the same session prompt as before, with the healer only.
5. Run the gate again. Run `git diff` on `tests/`.
6. Pass: the gate still fails C2. The healer did not skip the test. It did not weaken the assertion.
7. If the healer hides the bug, record exactly how. This tells us which gate check to add.

### Experiment 3: independence

1. Break claim C3 in a different way (change a value, not remove a feature).
2. Generate tests from scratch on the broken branch. Use a fresh session and the same `claims.md`.
3. Pass: the generated test for C3 fails. The agent did not write a test that matches the broken code.

### Experiment 4: comparison with v5

1. Run the same task through the v5 workbench `exercise` phase on `spike-base`. Use `awb task create`.
2. Compare: claims covered, whether it caught the planted bug, total tokens, total minutes.
3. Record the numbers in a table.

## Decision rule

| Result | Decision |
| --- | --- |
| Experiments 1, 2 and 3 pass | Go. `spike/gate.mjs` becomes `proof/` in v6. Start phase 1. |
| 1 passes, 2 fails (healer hides the bug) | Go, with a stricter gate. Block the healer from editing assertions, or remove the healer and use a human-free retry limit. Run experiment 2 again. |
| 1 fails (poor tests or no video link) | Try `@playwright/mcp` with the Claude Code agent and a hand-written prompt. Run experiments 1 and 2 again. If this also fails, stop. Re-think the proof design. |
| 3 fails (tests copy the bug) | Add a rule: the test session reads only `claims.md` and the running app, never the diff. Run again. |

## Deliverables

1. `spike/gate.mjs`.
2. `spike/RESULTS.md`: the table of experiments, the comparison table and the decision.
3. The three test files from experiments 1 to 3, as examples for the v6 playbook.

## Cost

I expect 3 to 6 Claude sessions of moderate size, plus one v5 task run for the comparison. I did not measure this. Watch the token count in experiment 1 and stop if it passes a budget that you set.
