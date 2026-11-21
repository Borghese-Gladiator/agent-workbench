---
name: standup
description: Use when the user asks for a standup update, or when a scheduled job runs it. Reads GitHub commits and PRs, awb tasks and Linear tickets. Prints the standup text. Never posts.
argument-hint: "[date]"
---

# Standup

The result is the standup text and nothing else. Only read. Do not post or change anything.

## Sources

Yesterday is the last working day before today (on Monday, Friday). Get today with `date +%F`.

First call `ToolSearch` with `select:mcp__linear-server__list_issues`.

1. Commits: `gh search commits --author @me --author-date ">=<yesterday>" --json repository,commit --limit 50`
2. PRs: `gh search prs --author @me --updated ">=<yesterday>" --json title,url,state,isDraft,repository`
3. Tasks: `awb tasks --since 2d --json`
4. Tickets: `mcp__linear-server__list_issues` with `assignee: "me"`, `updatedAt: "-P30D"`, `limit: 50`, `fields: ["title","url","status","statusType","updatedAt","startedAt"]`. Use only the tickets with `updatedAt` in the last 4 days for the yesterday and today sections.

## Wording

- PR `state` merged: "Merged ...". Open and not a draft: "in review". Open draft: "in progress (draft PR)". Check `state` first.
- Write a ticket as done only when its `statusType` is `completed`. Otherwise use the Linear status name.
- Blockers: a PR with changes requested or a failed check, a failed task, or a ticket with status Blocked. Each needs a link or an id.

## Stale tickets

Linear has no date for the last status change. Use `updatedAt` as the date. Count the days from `updatedAt` to today.

A ticket is stale when its `statusType` is `started` or `unstarted`, and `updatedAt` is 7 or more days ago. Skip `backlog`, `completed` and `canceled` tickets. Sort the oldest first.

## Output

Fill in this template. Keep the blank line before each emoji line.

```
:yesterday:
- <done item with PR link or ticket id>
- <done item with PR link or ticket id>

:today:
- <next item with PR link or ticket id>
- <next item with PR link or ticket id>

:construction:
- <blocker with link or id>

:hourglass:
- <ticket id> <title>: <status name> for <N> days
```

One line for each item. If there is no blocker, write `- nothing blocking`. If there is no stale ticket, write `- nothing stale`. Add no other text.
