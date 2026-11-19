# Surface: GitHub

## Read
- PR, comments and reviews: `gh pr view <n> --json title,body,comments,reviews,isDraft` and `gh api repos/<owner>/<repo>/pulls/<n>/comments`.
- Use the head commit SHA for every permalink: `gh api repos/<owner>/<repo>/pulls/<n> --jq .head.sha`.

## Post
| Target | Command |
|---|---|
| Reply to a review comment | `gh api repos/<owner>/<repo>/pulls/<n>/comments/<id>/replies -f body=...` |
| Top-level PR or issue comment | `gh pr comment <n> --body-file <file>` or `gh issue comment <n> --body-file <file>` |

Write the body to a file first. Show the file to the user. Post from the file.

## Rules
- A human reviewer's open thread is theirs. If the reply is not about a fix that you made, do not post. Tell the user instead.
- A reply to a review comment states what changed and names the commit.
- Do not resolve the thread, do not approve, and do not run `gh pr ready`.
- For a review of the PR itself, use the `review` skill, not this skill.
