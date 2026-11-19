# Source: GitHub

The item is an issue, a PR, or a comment on a PR (a review comment or a top-level comment).

## Read
- Issue: `gh issue view <n> --json title,body,comments,labels`.
- PR comment: `gh pr view <n> --json title,body,comments,reviews` and `gh api repos/<owner>/<repo>/pulls/<n>/comments`.
- Read the code at the head commit of the PR, not the diff alone: `gh api repos/<owner>/<repo>/pulls/<n> --jq .head.sha`.

## Verdict for a review comment
- `fix`: the comment is right, and the code at the head commit shows it. Quote the file and line.
- `answer`: the comment is a question, or the code already handles the case. Quote the file and line.
- `request`: the comment asks for a change outside the scope of the PR.
- `skip`: a bot comment that repeats a human comment, or a comment that a later commit already fixed. Name the commit.

## Rules
- A human reviewer's thread is theirs. Triage it, but record `answer` or `fix` only. Do not draft a disagreement.
- Verdicts for a bot comment follow the same evidence rule: no file and line, no verdict.
