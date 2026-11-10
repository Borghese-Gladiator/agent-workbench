---
name: bug-triage
description: Use when the user asks to triage bugs, Sentry issues or alerts from a Slack channel, a time range, or a list of links. Removes duplicates, gives each item a fix or skip verdict with evidence, runs sentry-fix on the fix items, and writes a triage report.
argument-hint: "<slack channel | list of links> [time range]"
---

# Bug triage

The result is a triage report, and one `sentry-fix` result for each item with the verdict `fix`.

## 1. Collect the items

- **Slack channel.** Read the channel for the time range (default: the last 24 hours) with the Slack MCP tools. Read the threads too: a reply can say "resolved" or "duplicate".
- **Links.** Use the list as it is.

From each message, get the Sentry issue ids, the alert ids, and the permalink. A message with no issue or alert goes to "Ignored messages" with one reason, for example "bot message: alert resolved" or "question, not a bug".

## 2. Remove duplicates

- The same Sentry issue id is one item. Keep all the permalinks.
- Two issues with the same exception type and the same fault frame are one item. Keep the issue with the most events, and record the other as a duplicate.
- An item that an earlier run handled is a skip with the reason "done in <report or proof file>". To find them, read `$AWB_HOME/triage/*.md` and `$AWB_HOME/sentry/*/proof.md`. `AWB_HOME` defaults to `~/.awb`.

## 3. Triage each item

For each Sentry item, get the issue (steps 1 to 3 of the `sentry-fix` skill). If the `sentry-triage` skill is available, use it for the owner team and the severity.

Give each item a verdict:
- `fix`: a code fault in a repo on this machine, and a unit test can reproduce it.
- `skip`: use the skip reasons of `sentry-fix` step 3, plus "duplicate of <item>". Each skip has a reason and evidence.

A monitor alert that is not a Sentry issue is a `skip` with the reason "alert, no alert-debug skill yet", unless the alert names one code path and an error.

## 4. Fix

1. Sort the `fix` items by severity, then by event count.
2. Run the `sentry-fix` skill on each item, one at a time. Each fix uses its own worktree and branch from the default branch. Before the next item, run `ExitWorktree({action: "keep"})`.
3. Do at most 5 items in one run. List the rest as "not started".
4. When `sentry-fix` ends with "not reproduced", record the item as `failed` and continue with the next item.

## 5. Write the report

Write `$AWB_HOME/triage/<YYYY-MM-DD>-<channel or "links">.md`. Write it again after each item, so that a stopped run still has a report.

```md
# Triage: <channel or links>, <time range>

## Run
Start <time> · end <time> · <n> messages · <n> distinct items

## Summary
fixed <n> · skipped <n> · failed <n> · not started <n>

## Fixed
| Item | Source | Repo | Root cause (one sentence) | Branch | Proof file |

## Skipped
| Item | Source | Reason | Evidence |

## Failed
| Item | Source | What was tried |

## Not started
| Item | Source | Severity |

## Ignored messages
| Permalink | Reason |
```

## 6. Report in the chat

Show the table from the report in short form, one row for each item, and give the report path.

## Rules

- Do not post to Slack, and do not change a Sentry issue. Post only when the user asks.
- Every skip has evidence. "Looks like noise" is not evidence.
- A fix in code that another team owns is still a `fix`. Name the owner team in the report.
