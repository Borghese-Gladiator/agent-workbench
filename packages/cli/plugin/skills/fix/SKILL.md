---
name: fix
description: Use when the user gives one Sentry issue (URL, id or short id), or a `fix` verdict from the triage skill, and asks to reproduce it, fix it, or prove a fix. Writes a regression test that fails with the same exception and frame as the Sentry event, fixes the code, and records the before and after output. Ends with a skip reason when no code fix is correct.
argument-hint: "<sentry-url-or-short-id>"
---

# Fix

The source today is a Sentry issue. If a triage record for the item exists in `$AWB_HOME/triage/`, read its owner and fault frame, and do not repeat steps 1 and 2 for them.

The result is one of these:
- **Fixed:** a branch with two commits (a test commit, then a fix commit) and a proof file with the before and after output.
- **Skipped:** a reason and evidence. No branch.
- **Not reproduced:** what you tried. No fix.

Do not write a fix before a test fails with the same error as the Sentry event. A fix with no matching failure proves nothing.

## 1. Get the issue

Call `mcp__sentry__get_sentry_resource` with the URL. For the events, call `mcp__sentry__search_issue_events`. If the Sentry tools are missing or ask for auth, stop and tell the user to authenticate the Sentry MCP server (`/mcp`).

Record these values. Quote them, do not paraphrase:
- the short id, the title, the culprit, the transaction
- the exception type and the message
- first seen, last seen, the event count, the users affected, the release
- the full traceback, and the local variables of each in-app frame
- the request data and the tags of one recent event

## 2. Find the fault frame

The fault frame is the deepest frame in code that a Klaviyo repo owns. Third-party and stdlib frames are symptoms. Keep moving up the trace until you find an in-app frame.

Map the path to a repo. For `app`, strip the runtime prefix (`/opt/app/`) to get `src/learning/app/...`. For k-repo, strip `/opt/venv/lib/python*/site-packages/` and add `python/` in front. Use the mapping table and the owner lookup in `../triage/sources/sentry.md`.

The **match key** is the exception type, the file and the function of the fault frame. Step 6 uses it.

## 3. Fix or skip

Skip when one of these is true. Write the evidence for each skip.

| Reason | Evidence to write |
|---|---|
| Already fixed on the default branch | The commit or the current code at the fault line on `origin/HEAD` |
| Infra, load, or an external service (timeout, connection reset, out of memory) | The frames and the event pattern, for example "all events in one hour on one cluster" |
| Only third-party or stdlib frames, and no in-app frame calls them wrongly | The frames |
| The fault is in a repo that is not on this machine | The repo and the path |
| Not possible in a unit test (a race, one account's bad data that you cannot make) | Why |

If the issue is a skip, write the proof file (step 9) with only the Source and Skip sections, and stop.

## 4. Make a worktree

Use the `worktrees` skill. Branch: `awb/sentry-<short id in lower case>`, from `origin/HEAD`.

For `app`: run the import check from the `worktrees` skill before step 6. A test that runs the code of the main checkout gives a false result.

## 5. Find the root cause

Read the code at the fault frame and its callers. Use the local variables and the request data of the event. Write in two sentences why this input causes this exception. If the same function has other callers that have the same problem, fix the shared function, not one caller.

## 6. Write the test and get the "before" result

1. Write the smallest unit test that calls the fault path with the input of the event. Put it where the repo keeps its tests (for `app`, `tests/` mirrors `src/`). Use the repo's test style: for `app`, `pytest` with `parametrize` and fixtures.
2. The test asserts the correct behavior. It does not assert that the exception occurs.
3. Commit only the test: `test: reproduce <SHORT-ID>`.
4. Run only that test. For `app`, run the unit marker: `-m unit <test path>`.
5. The test must fail with the match key: the same exception type, raised in the same file and function. Compare the traceback with step 2.
   A log event (a Sentry issue from a `logger.error` call, with no exception) has no traceback. For a log event, the match key is the `logger` tag and the source logger. Capture the events with the real `sentry_sdk`: make a `sentry_sdk.Client` with a `transport` that appends each event to a list. The test then fails when the list has an event with the same `logger` tag as the Sentry issue.
6. If the test passes, or fails in a different way, it does not reproduce the issue. Change the test and amend the test commit. After 3 tries, stop with "not reproduced". Report each try and its output.

Save the command and its output. This is the **before** result.

## 7. Fix

Make the smallest change at the root cause. Do not change the test. Commit: `fix: <what changed> (<SHORT-ID>)`.

Do not put `Fixes <SHORT-ID>`, `Resolves <SHORT-ID>` or a similar line in a commit message. Sentry reads these lines, and it resolves the issue when the commit merges. The short id in the title in parentheses is safe. Sentry ignores it.

The PR body comes from `awb ship`, not from the repo PR template. Do not add a `Fixes <SENTRY-SHORT-ID>` line to a commit.

## 8. Get the "after" result

1. Run the same command as in step 6. It must pass. This is the **after** result.
2. Run the repo checks for the paths that the diff touches: lint, typecheck, and the unit tests of those folders. Fix each failure, and commit again.

## 9. Write the proof file

Write `$AWB_HOME/sentry/<SHORT-ID>/proof.md`. `AWB_HOME` defaults to `~/.awb`. The file stays outside the repo.

```md
# <SHORT-ID>: <title>

## Source
<Sentry link> · <count> events · <users> users · first seen <date> · last seen <date> · release <release>

## Root cause
<file>:<line> `<function>`: <two sentences>

## Fix
<what changed and why>

## Before (test commit <sha>, without the fix)
$ <command>
<the failing output: the assert or exception line and the fault frame. Keep it short.>
Match key: <exception type> in <file> `<function>`: same as Sentry.

## After (fix commit <sha>)
$ <command>
<the passing output>

## Repo checks
| Command | Result |
|---|---|

## Not proven
<anything that the test does not cover, for example other inputs or production state>

## Check it yourself
git checkout <test sha>   # the test fails
git checkout <fix sha>    # the test passes
```

## 10. Create a ticket

If the repo PR template asks for a ticket link (the `app` template asks for a Linear link), find a ticket for the error first. Search with `mcp__linear-server__list_issues` for the Sentry issue ID. If a ticket exists, use its link and go to step 11.

If no ticket exists, create one with `mcp__linear-server__save_issue`. Do not ask the user for the team, the project, or approval. Use team `Advanced Reporting`, project `Advanced Reporting Bugs and Tech Debt`, and state `Backlog`. Use a different team or project only when the user named one. Fill each section from the proof file with this template. Put the Sentry link in Resources. Then show the ticket link to the user, and use it in the PR body.

```md
## Description

## Acceptance Criteria

## Implementation/Design

## Monitoring

## Other

## Resources
```

## 11. After the PR opens

Open the PR only as a draft (`gh pr create --draft`). Then confirm it: `gh pr view <number> --json isDraft` must give `true`.

Find each ticket that the PR body links (for example `Fixes https://linear.app/klaviyo/issue/ADV2-896/...`). For each Linear ticket, set the status to "In Progress" with `mcp__linear-server__save_issue` (`id`, `state: "In Progress"`). Do not change a ticket that is already `started`, `completed` or `canceled`. Check the current status first with `mcp__linear-server__get_issue`. If the team has no "In Progress" status, tell the user, and do not pick a different status.

## 12. Report

Give the user: the result (fixed, skipped or not reproduced), the branch, the two commit SHAs, the proof file path, and the before and after output in short form.

If the user asks for a PR, ship the branch with `awb ship`. Do not run `gh pr create` yourself.

1. Make sure that a run file with a `## test` section exists for the repo (see the playbook, step 4). The test command must write JUnit XML.
2. Create a task with one test claim. Send it on stdin to `awb stack set`:
   ```sh
   awb stack set <<'EOF'
   {"tasks":[{"title":"fix: <what changed> (<SHORT-ID>)","context":"<what the user sees, who it affects, the Sentry link>","description":"<the cause, the fix, and what the PR does not change>","claims":[{"id":"C1","proof":"test","text":"<the input of the event> no longer raises <exception type> in <function>"}]}]}
   EOF
   ```
3. Run `awb prove`. A separate session writes its own test from the claim. The gate runs that test on the base commit and on your fix. The claim passes only when the test fails on the base and passes on the fix.
4. If the claim fails, fix the code, commit, and run `awb prove` again. Do not edit the proof tests.
5. Run `awb ship`. It opens the draft PR.
6. Do step 11.

Never run `gh pr ready`, and never request reviewers.

For an error in fender with a browser path, the fix also needs a browser claim. Add it as a second claim (without `"proof":"test"`) to the same task.

## Rules

- Do not write to Sentry or Slack. Do not resolve, assign or comment on an issue. A `Fixes <SHORT-ID>` line in a commit is a write to Sentry, so do not add one. Do not edit the PR body after `awb ship`.
- Do not weaken a test so that it passes.
- Every number in the proof file comes from Sentry or from a command output.
