---
name: triage
description: Use when the user asks to triage a problem or a comment, or to triage a Slack channel, a time range, or a list of links. The source can be a Sentry issue, a Linear ticket, a GitHub issue, PR or review comment, or a Slack thread. Gives each item one verdict with evidence. Writes a triage report for a batch. Does not fix and does not reply.
argument-hint: "<url | list of links | slack channel> [time range]"
---

# Triage

The result is one verdict for each item, with evidence. A batch also gets a report.

Triage does not change code and does not post. The `fix` skill changes code. The `respond` skill posts replies.

## 1. Find the source

Read the first URL or the channel name. Load the source file for each item.

| The item is | Read |
|---|---|
| A Sentry URL, issue id or short id | `sources/sentry.md` |
| A Linear ticket | `sources/linear.md` |
| A GitHub issue, PR, or review comment | `sources/github.md` |
| A Slack thread | `sources/slack.md` |
| A Slack channel, or a list of links | Step 2 |

## 2. Collect the items (a batch)

- **Slack channel.** Read the channel for the time range (default: the last 24 hours) with the Slack MCP tools. Read the threads too: a reply can say "resolved" or "duplicate".
- **Links.** Use the list as it is.

From each message, get the item ids and the permalink. A message with no item goes to "Ignored messages" with one reason, for example "bot message: alert resolved" or "question, not a problem".

## 3. Remove duplicates

- The same item id is one item. Keep all the permalinks.
- Two Sentry issues with the same exception type and the same fault frame are one item. Keep the issue with the most events.
- An item that an earlier run handled is a `skip` with the reason "done in <file>". To find them, read `$AWB_HOME/triage/*.md` and `$AWB_HOME/sentry/*/proof.md`. `AWB_HOME` defaults to `~/.awb`.

## 4. Triage each item

Use the source file. It tells you how to read the item, who owns it, and how severe it is.

Give each item one verdict:

| Verdict | Meaning | Next skill |
|---|---|---|
| `fix` | A code fault in a repo on this machine. A unit test can reproduce it. | `fix` |
| `answer` | A question, or a report of correct behavior. | `respond` |
| `request` | A feature request, or a change of scope. | `respond` |
| `route` | Another team owns it. Name the team and the evidence. | `respond` |
| `skip` | No action. Give the reason and the evidence. | none |

Each verdict has evidence: a file and line, a CODEOWNERS line, a number from Sentry, or a linked ticket. "Looks like noise" is not evidence.

A monitor alert that is not a Sentry issue is a `skip` with the reason "alert, no alert source yet", unless the alert names one code path and an error.

## 5. Write the verdict record

For each item, write one line to `$AWB_HOME/triage/<YYYY-MM-DD>-<channel or "links">.md`. Write the file again after each item, so that a stopped run still has a report.

```md
# Triage: <channel or links>, <time range>

## Run
Start <time> · end <time> · <n> messages · <n> distinct items

## Summary
fix <n> · answer <n> · request <n> · route <n> · skip <n>

## Items
| Item | Source | Verdict | Severity | Owner | Evidence |

## Ignored messages
| Permalink | Reason |
```

The `fix` skill and the `respond` skill read this record. They do not repeat the triage.

## 6. Report in the chat

Show the table in short form, one row for each item, and give the report path.

To act on the verdicts, offer the next skill: `fix` for the `fix` items, and `respond` for the `answer`, `request` and `route` items. Do not start them before the user agrees.

## Rules

- Do not post to Slack, GitHub or Linear. Do not change a Sentry issue. Do not change code.
- Every verdict has evidence.
- Name the owner team in the report, also for a `fix` in code that another team owns.
- Use `issue` for a Sentry issue, `ticket` for a Linear ticket, and `alert` for a monitor alert. Do not use `bug` for all three.
- For a `linear.app/klaviyo/...` link, use the Linear MCP. For a `klaviyo.atlassian.net/...` link, use the Atlassian MCP. Do not use curl.
