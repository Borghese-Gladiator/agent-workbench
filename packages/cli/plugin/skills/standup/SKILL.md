---
name: standup
description: Use when the user asks for a standup update, or when a scheduled job runs it. Reads the work of the last working day and the open work from GitHub, the awb tasks and the status of the Linear tickets. Prints the standup text in the fixed format with the sections yesterday, today and blocked. Never posts to Slack.
argument-hint: "[date]"
---

# Standup

The result is the standup text, and nothing else. The text is the output of the run. Do not write an introduction or a summary.

This skill only reads. Do not post to Slack, GitHub or Linear. Do not change a ticket or a PR.

## 1. Find the days

- Today is the day of the run. Get it with `date +%F`.
- Yesterday is the last working day before today. On Monday it is Friday. On Tuesday to Friday it is the day before.
- If the user gave a date as the argument, use it as today.

## 2. Collect what was done

First, load the Linear tools. They are not loaded at the start of a scheduled run. Call `ToolSearch` with the query `select:mcp__linear-server__list_issues`. Do this before any other call in this step.

Collect from each source. Use only these sources.

1. **Commits.** Run `gh search commits --author @me --author-date ">=<yesterday>" --json repository,commit --limit 50`. Use `commit.message` for the text. This lists pushed commits only. Do not run `ls`, and do not use `$(...)` in a command: a scheduled run refuses both.
2. **PRs.** Run `gh search prs --author @me --updated ">=<yesterday>" --json title,url,state,isDraft,repository`. Use the PR state to word the item:
   - `state` is `merged`: the work is done. Write "Merged <what>".
   - `state` is `open` and `isDraft` is `false`: the work is in review. Write "<what> is in review".
   - `state` is `open` and `isDraft` is `true`: the work is in progress. Write "<what> is in progress (draft PR)".
   - Never write "merged", "done" or "shipped" for a PR that is open or a draft.
   - A draft PR is never in review. Do not write "get a review" or "move to merge" for a draft PR. Write "finish" or "continue" and "in progress (draft PR)".
   - Check `state` first. A merged PR also has `isDraft` `true`.
3. **Tasks.** Run `awb tasks --since 2d --json`. A task with the status `done` is done work.
4. **Tickets.** Always make this call. Call `mcp__linear-server__list_issues` with `assignee: "me"`, `updatedAt: "-P4D"`, `limit: 25` and `fields: ["title", "status", "statusType", "url", "updatedAt", "completedAt"]`. Use the ticket status to word the item:
   - `statusType` is `completed` and `completedAt` is since yesterday: the work is done.
   - Any other status: write the status name as Linear gives it, for example "In Progress" or "In Review".
   - Never write a ticket as done when its `statusType` is not `completed`.

If one source fails or needs authorization, skip it and continue. Do not write a note, a warning or a request to authorize. The last line of the output is the last bullet of the blocked section.

## 3. Collect what is next

1. Linear tickets of the user in a started state. Always make this call. Call `mcp__linear-server__list_issues` with `assignee: "me"`, `state: "started"`, `limit: 25` and `fields: ["title", "status", "url", "labels"]`.
2. Open PRs of the user from the PR search in step 2. A draft PR is in progress. A PR that is not a draft is in review.
3. Tasks with the status `waiting` or `doing` in `awb tasks --status waiting --json` and `awb tasks --status doing --json`.

## 4. Collect the blockers

A blocker is one of these:
- A PR of the user with `reviewDecision` `CHANGES_REQUESTED`, or with a failed check.
- An awb task with the status `failed`.
- A Linear ticket from the started-state call in step 3 that has the label `blocked`, or a status name with "blocked" in it.

Do not guess a blocker. A blocker needs a link or an id.

## 5. Write the text

Use this format exactly. The emoji codes stay as colon codes.

```
:yesterday:
- <done item>
:today:
- <next item>
:construction:
- <blocker>
```

Rules for the items:
- One line for each item. Start with a verb in the past tense for done items, and in the base form for next items.
- Join the commit, the PR and the ticket of one piece of work into one item. Put the PR link at the end of the line. Keep the ticket id.
- If a ticket and its PR disagree, the PR state wins for the wording, and the ticket status goes in brackets, for example "(Linear: In Progress)".
- Write 3 to 6 items for each section. Merge small items.
- If a section has no item, write `- None`.
- Write the items in plain words. Do not write commit hashes.

## Rules

- The output is only the three sections. No heading, no code fence, no closing line.
- Every item comes from a source in steps 2 to 4. Do not add work that no source shows.
- Do not post. The user posts the text.

## Schedule

Add this job to `$AWB_HOME/schedule.json`. The job runs on Monday to Friday, and it has no Slack tool, so it cannot post.

```json
{
  "name": "standup",
  "at": "09:30",
  "prompt": "/awb:standup",
  "cwd": "/Users/timothy.shee/GitHub/agent-workbench",
  "timeoutMin": 10,
  "allowedTools": [
    "Read", "Glob", "Grep", "ToolSearch",
    "Bash(date:*)", "Bash(gh search commits:*)", "Bash(gh search prs:*)", "Bash(awb tasks:*)",
    "mcp__linear-server__list_issues", "mcp__linear-server__get_issue"
  ]
}
```

`cwd` is required, and it must be a git repo. Change the path to a repo on your machine.

To see the text, run `awb schedule run standup`, then `awb schedule output <run id>`.
