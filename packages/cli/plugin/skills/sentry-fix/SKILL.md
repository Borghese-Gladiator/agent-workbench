---
name: sentry-fix
description: Use when the user gives one Sentry issue (URL, id or short id) and asks to reproduce it, fix it, or prove a fix. Writes a regression test that fails with the same exception and frame as the Sentry event, fixes the code, and records the before and after output. Ends with a skip reason when no code fix is correct.
argument-hint: "<sentry-url-or-short-id>"
---

# Sentry fix

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

Map the path to a repo. For `app`, strip the runtime prefix (`/opt/app/`) to get `src/learning/app/...`. For k-repo, strip `/opt/venv/lib/python*/site-packages/` and add `python/` in front. If the `sentry-triage` skill is available, use its mapping table and its owner lookup.

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
6. If the test passes, or fails in a different way, it does not reproduce the issue. Change the test and amend the test commit. After 3 tries, stop with "not reproduced". Report each try and its output.

Save the command and its output. This is the **before** result.

## 7. Fix

Make the smallest change at the root cause. Do not change the test. Commit: `fix: <what changed> (<SHORT-ID>)`.

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

## 10. Report

Give the user: the result (fixed, skipped or not reproduced), the branch, the two commit SHAs, the proof file path, and the before and after output in short form.

`awb ship` proves only browser claims today, so it cannot ship this branch, and `gh pr create` is denied in `awb`. Tell the user that the branch is ready for a PR, and that the PR body can come from the proof file.

For an error in fender with a browser path, the fix also needs a browser claim. Follow the playbook feature flow: write a claim for the correct behavior, then run `awb prove` and `awb ship`.

## Rules

- Do not write to Sentry or Slack. Do not resolve, assign or comment on an issue.
- Do not weaken a test so that it passes.
- Every number in the proof file comes from Sentry or from a command output.
