---
name: respond
description: Use when the user asks to reply to, answer, or comment on a Slack thread, a GitHub PR review comment, PR or issue comment, or a Linear ticket comment. Reads the thread and the triage record, drafts one short reply, asks for approval, and posts only the approved reply.
argument-hint: "<url | ticket id | triage record> ..."
---

# Respond

The result is one posted reply for each approved draft. A reply that the user does not approve is not posted.

## 1. Find the surface

| The target is | Read |
|---|---|
| A Slack thread, or a Linear bot post in a Slack channel | `surfaces/slack.md` |
| A GitHub PR, issue, review comment, or issue comment | `surfaces/github.md` |
| A Linear ticket | `surfaces/linear.md` |

## 2. Read before you write

1. Read the target and its whole thread. Do not repeat what a reply already says.
2. If a triage record exists in `$AWB_HOME/triage/` for the item, read its verdict, owner and evidence. If none exists, run the `triage` skill on the item first.
3. Use only facts from the target, the thread, the record, or the code. Do not guess.

## 3. Draft

Use this template. Keep the reply to 4 lines. Use Simplified Technical English.

```
**CLAUDE says:** <one sentence: the verdict in plain words>
**Reason:** <1 or 2 sentences, with the evidence: file, line, query, or linked ticket>
**Next step:** <who does what, or "Suggest close">
```

- For a `fix` verdict, name the commit or the branch in **Next step**.
- For an `answer` verdict, put the answer in **Reason**.
- For a `route` verdict, name the owner team and the CODEOWNERS line.
- The surface file can change the markdown. It cannot change the template.

## 4. Approve

Show each draft. Ask for approval for each target separately with `AskUserQuestion`. Options: post as-is, save as a draft (Slack only), edit, skip.

## 5. Post

Post only the approved drafts. Post in the existing thread, not as a new message. Report each posted link.

## Rules

- The first text must be `**CLAUDE says:**`. No exception.
- Do not post without approval for that target. Approval for one target is not approval for the next.
- Do not resolve a thread. Do not change a ticket status. Do not close an issue. Do this only when the user asks for that action.
- Do not @-mention a person unless the user asks.
- Do not reply to a human review comment with a claim that the human did not make. State what changed and name the commit.
- Do not move a PR out of draft. Do not request reviewers.
