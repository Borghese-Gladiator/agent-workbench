# Source: Slack

The item is a thread, or a message that links to another source.

## Read
1. Read the thread with `mcp__slack__slack_read_thread`. Read all replies. A reply can say "resolved" or "duplicate".
2. Find the ids in the messages: a Sentry URL, a Linear ticket, a GitHub link. For each id, load the source file for that id and triage it there. The Slack message is then the `Source` column.
3. A message with no id is a question or a report. Treat the message text as the item. Find the code it names.

## Verdict
Use the same verdicts as the other sources. A thread that a person already answered is a `skip` with the permalink of the answer.

## Rules
- A bot message that says "resolved" is an ignored message, not an item.
- Do not post in the thread. The `respond` skill posts.
