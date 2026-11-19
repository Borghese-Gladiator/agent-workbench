---
name: standup
description: Use when the user asks for a standup update, or when a scheduled job runs it. Reads the work of the last working day and the open work from git, GitHub, the awb tasks and Linear. Prints the standup text in the fixed format with the sections yesterday, today and blocked. Never posts to Slack.
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

Collect from each source. Use only these sources.

1. **Commits.** For each git repo in `~/GitHub` and `~/Klaviyo/Repos` (one level deep), run `git -C <repo> log --all --since=<yesterday> --until=<today> --author="$(git -C <repo> config user.email)" --format=%s`. A worktree shares its repo, so `--all` covers it.
2. **PRs.** Run `gh search prs --author @me --updated ">=<yesterday>" --json title,url,state,isDraft,repository`. A merged PR is done work. An open PR is work in progress.
3. **Tasks.** Run `awb tasks --since 2d --json`. A task with the status `done` is done work.
4. **Tickets.** Call `mcp__linear-server__list_issues` with `assignee: "me"` and `updatedAt` since yesterday. A ticket that moved to a done state is done work.

If one source fails, skip it and continue. Do not write that it failed.

## 3. Collect what is next

1. Linear tickets of the user in a started state (`In Progress`, `In Review`).
2. Open draft PRs of the user, and PRs that wait for the user.
3. Tasks with the status `waiting` or `doing` in `awb tasks --status waiting --json` and `awb tasks --status doing --json`.

## 4. Collect the blockers

A blocker is one of these:
- A PR of the user with `reviewDecision` `CHANGES_REQUESTED`, or with a failed check.
- An awb task with the status `failed`.
- A Linear ticket of the user in a blocked state, or with a label `blocked`.

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
- Join the commit, the PR and the ticket of one piece of work into one item. Put the ticket id or the PR link at the end of the line.
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
  "timeoutMin": 10,
  "allowedTools": [
    "Read", "Glob", "Grep",
    "Bash(date:*)", "Bash(git -C:*)", "Bash(ls:*)", "Bash(gh search prs:*)", "Bash(awb tasks:*)",
    "mcp__linear-server__list_issues", "mcp__linear-server__get_issue"
  ]
}
```

To see the text, run `awb schedule run standup`, then `awb schedule output <run id>`.
