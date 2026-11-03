# Agent Workbench v6: addendum for triage
Status: draft for review. Date: 2026-10-28.

This file adds a fourth use case to `PROPOSAL.md`. It does not change that file. When a section here conflicts with `PROPOSAL.md`, this file wins for the triage use case only.

## 1. Use case 4: triage

| What you do | What happens |
| --- | --- |
| In `awb`, ask: "Read #team-alerts and triage the issues and alerts." | The chat reads the channel and investigates each item. It makes one task for each item that needs a fix. Each task gets a full investigation, a fix, a regression test in the repo, and its own draft PR from the default branch. Items that need no fix become `skipped` tasks with a reason. |

Example result:

```
Triage of #team-alerts, 14 messages, 9 distinct issues
  T1  SENTRY-4KX  KeyError in flow_send       done     PR #1201 (draft)
  T2  SENTRY-4M2  timeout in segment export   done     PR #1202 (draft)
  T3  SENTRY-3ZZ  duplicate of T1             skipped  same root cause as T1
  T4  monitor 881 p99 latency, list API       skipped  infra, owner is #platform
  T5  SENTRY-4N7  null deref in fender table  failed   regression test does not fail on base
  ...
```

## 2. Changes to the data model

### 2.1 Independent stacks

In `PROPOSAL.md`, tasks in a stack are always stacked. Each task branches from the task below it, and a failure stops the stack. That is correct for a big feature, and wrong for triage. Ten unrelated fixes must not stack.

Add one field to a stack: `mode`.

| Mode | Branch of each task | When a task fails |
| --- | --- | --- |
| `stacked` (default) | The branch of the task below it. | The stack stops. |
| `independent` | The default branch. | The runner continues with the next task. |

The chat makes one `independent` stack with ten tasks. You do not make N stacks. The runner, the worktrees and the `claude -p` sessions stay the same as in `PROPOSAL.md` section 2.3. Only the base branch and the stop rule change.

### 2.2 Concurrency

An `independent` stack has no order dependency, so its tasks can run at the same time. Add `--concurrency <n>` to `awb run`. The default is 1. The maximum is 5. More than 5 concurrent sessions overloads the host (v6 dogfood, 2026-08-18).

### 2.3 Task fields

A task in `PROPOSAL.md` has only `title` and `claims`. A triage task needs three more fields:

| Field | Content | Why |
| --- | --- | --- |
| `repo` | The repo that owns the fault. | One channel has alerts for `app`, fender and k-repo. The stack can hold tasks for many repos. |
| `source` | The Sentry issue id, the alert id, and the Slack permalink. | The chat uses it to find duplicates, and to skip items that an earlier triage run already has. |
| `context` | The investigation: stack trace summary, root cause, the fix plan, the reproduction steps. | The runner already starts a fresh session for each task. It passes this field in the prompt with the claims. Without it, the fresh session must do the investigation again. |

This is not a new session mechanism. It is more data in the prompt that the existing runner sends.

### 2.4 Status `skipped`

Add `skipped` as a terminal status. It means "investigated, and no PR is correct." Examples: noise, a duplicate, an infra problem, a fault in the code of another team, a fault that is already fixed on the default branch.

`PROPOSAL.md` section 3.4 says that the agent has no command to set a status. `skipped` is the one exception, because it opens no PR and cannot go around the gate. Add the command `awb task skip <id> --reason <text> --evidence <text>`. Both values are required. The daemon refuses an empty value.

A skip does not wait for your review. The task becomes `skipped` at once, and the stack continues. The reason and the evidence go into the triage report (section 2.5), so that you can read them later.

### 2.5 Triage report

Each triage stack has one report. You read it after the run. It never blocks the run.

- **Where.** The daemon writes `$AWB_HOME/stacks/<stack id>/report.md`. The web UI shows it on the Stacks view. `awb show <stack>` prints its path.
- **When.** The daemon writes it again each time a task in the stack reaches a terminal status. The last write is when all tasks are terminal.
- **Who writes it.** The daemon, from the rows in the store. The agent does not write the report, so it cannot leave out a task.

| Section | Content |
| --- | --- |
| Run | The channel, the time range, the start and end time, the total cost. |
| Summary | The count of tasks for each status: `done`, `skipped`, `failed`. |
| Fixed | One row for each `done` task: the source link, the repo, the root cause in one sentence, the draft PR link. |
| Skipped | One row for each `skipped` task: the source link, the reason, the evidence. Example evidence: "Same stack frame and root cause as T1", or "Error rate follows the deploy of service X; no code path in this repo". |
| Failed | One row for each `failed` task: the source link, the failed gate rules, the path to the transcript. |
| Ignored messages | The Slack messages that the chat did not turn into a task, with one reason each. Example: "Bot message: alert resolved". |

The Ignored messages section exists because a message that never becomes a task has no row in the store. The chat sends this list to the daemon with `awb stack set`, as a stack field.

## 3. Changes to proof

### 3.1 What exists, and why it is not sufficient

`PROPOSAL.md` already has two kinds of tests:

1. **Repo checks.** The agent runs the repo lint, typecheck and unit tests before it asks for proof. This is advice in the playbook. The gate does not check it.
2. **Proof tests.** A fresh test writer writes Playwright tests for each claim. They live in `$AWB_HOME` and never enter the repo. The gate checks them.

For a bug fix, the correct proof is a regression test that is in the repo, fails on the base commit and passes at `HEAD`. Neither kind gives that. The repo checks prove that nothing else broke, but the gate ignores them. The proof tests are browser tests that stay out of the PR. Most Sentry errors are backend errors with no browser path.

### 3.2 New proof type: `repo-test`

Add a proof type to each claim: `browser` (the current design), `api` (the current design), or `repo-test` (new).

For a `repo-test` claim, the gate passes only when all of these are true:

1. The claim names one or more test ids in the repo test suite.
2. The test files are in the diff of the task branch.
3. On the base commit, with only the test files applied, the named tests fail.
4. At `HEAD`, the named tests pass.
5. The repo unit test command from `.awb/run.md` passes at `HEAD`, for the paths that the diff touches.
6. Rules 4 and 5 of `PROPOSAL.md` section 4.3 (clean source, no test change after the run starts) still apply.

Rule 3 is the important one. It proves that the test reproduces the bug. It is also the cheaper answer to open question 2 in `PROPOSAL.md`.

### 3.3 Fixes with a browser path

When a fix changes code that a user sees in the browser, the task must have a `repo-test` claim and a `browser` claim. The `browser` claim follows `PROPOSAL.md` section 4: a Playwright video and a trace of the fixed behavior. This rule applies to every fender fix. The gate refuses a fender task that has no `browser` claim.

A fender fix needs the `app` stack and a seeded login to start (`PROPOSAL.md` section 3.8). If the app cannot start, the task becomes `failed`, not `done` without a video.

### 3.4 Repo checks become a gate rule

For every proof type, the gate runs the lint, typecheck and unit test commands from `.awb/run.md`, on the paths that the diff touches. A failure fails the gate. This makes "Draft PR with tests" a rule in code, not advice.

### 3.5 PR body for a bug fix

| Section | Content |
| --- | --- |
| Source | The Sentry link, the event count, the first and last time seen, the Slack permalink. |
| Root cause | The fault, the file and the line. |
| Fix | What changed and why. |
| Proof | The regression test ids, the fail result on the base commit, the pass result at `HEAD`. |
| Repo checks | The lint, typecheck and unit test commands and their results. |
| Not proven | Any claim with no proof, and the reason. |

## 4. New skills

The existing `sentry-triage` skill finds the owner team, the repo and the severity of one issue. It does not investigate the root cause, write a fix or write a test. Write three new skills:

| Skill | Input | Output |
| --- | --- | --- |
| `bug-triage` | A Slack channel, a time range, or a list of links. | One row for each distinct issue: source, repo, owner team, severity, verdict (`fix` or `skip`), and the skip reason. It removes duplicates. It calls the other two skills for each item. It makes the `independent` stack. |
| `sentry-fix` | One Sentry issue. | The `context` and the claims for one task: the stack trace, the root cause, the reproduction steps, the fix plan, and one `repo-test` claim. Or a skip reason. |
| `alert-debug` | One monitor alert (Datadog, Chronosphere, or a similar tool) that is not a Sentry issue. | The same output as `sentry-fix`. Many alerts end as `skipped`, because the cause is load or infra, not code. |

The skills ship with `awb`, in the same way as the default playbook. `awb` passes them to `claude` with `--plugin-dir`. They do not go into the target repo, so the rule in `PROPOSAL.md` section 3.7 (only two files in the repo) stays true.

## 5. Other items

1. **Data access.** The chat needs the Slack and Sentry MCP servers, and a metrics server for `alert-debug`. `awb` does not configure them. It uses the servers that your `claude` settings already have. `awb doctor` checks that the servers connect and prints the names of the servers that fail.
2. **Repeated runs.** A second triage run on the same channel must not make duplicate tasks. The chat reads `awb tasks --json`, and compares the `source` fields before it makes new tasks.
3. **Cost.** The daemon records the cost of each session, as in `PROPOSAL.md` section 3.9. A triage stack adds the total for each task and for the full stack. `awb show` and the triage report show the totals. There is no budget limit and no alert.
4. **Ownership.** A fix in code that another team owns still opens a draft PR. The PR body names the owner team from CODEOWNERS. The skill can decide to skip instead, with the reason "owned by <team>".
5. **No writes to Slack or Sentry.** The workbench does not post to Slack, and does not resolve, assign or comment on Sentry issues. The triage table is in the chat and in `awb show`. A post to Slack happens only when you ask for it in the chat.
6. **Backend test setup in a worktree.** In `app`, `bin/pytest` uses the venv and the source of the main checkout. A regression test in a worktree can then test the wrong source, and rule 3 of section 3.2 gives a false result. The start recipe for `app` must set the test path to the worktree. Phase 3 of this addendum tests this.
7. **Schedule.** A triage run on a schedule (for example, each morning) is out of scope for this addendum. Add it after the manual run works.

## 6. Build order

These phases come after phase 6 of `PROPOSAL.md`.

| Phase | Output | Test that proves it |
| --- | --- | --- |
| T1 | Stack `mode`, task fields `repo`, `source`, `context`, status `skipped`, `awb task skip`, the triage report. | An `independent` stack of three tasks gives three PRs from the default branch. A planted failure in task 2 does not stop task 3. A skip in task 1 shows in the report with its reason and evidence. |
| T2 | `repo-test` proof type, repo checks as a gate rule, the browser rule for fender, the bug-fix PR body. | A planted bug with a regression test passes. A test that does not fail on the base commit fails the gate. A fender task with no video fails the gate. |
| T3 | `--concurrency` and the cost totals for each stack. | Three tasks run at the same time. The report shows the cost of each task and the total. |
| T4 | The `sentry-fix` skill. | One real Sentry issue in `app` gives a draft PR with a regression test that fails on the base commit. |
| T5 | The `alert-debug` and `bug-triage` skills. | A real channel gives a triage table, draft PRs for the `fix` rows, and `skipped` tasks with reasons for the other rows. A second run makes no duplicate tasks. |

## 7. Decisions

1. A `skipped` verdict does not wait for review. The triage report explains every skip, so that you can read it later (section 2.5).
2. A fender fix needs a `browser` claim with a video, and a `repo-test` claim (section 3.3).
3. There is no budget limit and no cost alert. The daemon records the cost only (section 5, item 3).
