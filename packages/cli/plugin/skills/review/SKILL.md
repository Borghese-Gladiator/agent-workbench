---
name: review
description: Review a GitHub pull request and post the review as ONE short top-level comment on the PR — backed by deep code investigation, with evidence and permalinks hidden in a collapsed details block. Use when the user wants a review actually posted to a PR (not just a local report), or says "review with comments", "post comments on this PR", "leave a review on <PR URL>". Investigates the surrounding code (not just the diff), drafts the comment locally for approval, then submits it.
---

# PR Review With Comments

Reviews a GitHub PR and **posts one short review comment to GitHub**. Distinct from
`code-review`, which writes a local report and posts nothing.

The visible comment reads like a person wrote it by hand: a few short, direct paragraphs,
no bot framing. All the depth — permalinks, derivations, suggested code, counter-arguments —
goes in a collapsed `<details>` block so the comment stays short but the evidence is still
there for anyone who wants it.

## Guardrails (read first)

- **Draft-then-confirm is mandatory.** Never submit to GitHub before showing the user the
  full drafted comment and getting explicit approval. Posting is outward-facing and hard to
  reverse. Honor a `--post` flag only if the user includes it to skip the confirmation.
- **Default event is `COMMENT`.** Never auto-`APPROVE`. Only use `REQUEST_CHANGES` if the
  user explicitly asks.
- **Never change the PR's draft state.** Do not run `gh pr ready`, do not clear the draft
  flag through the API, and do not request reviewers. Only the user moves a PR into In
  Review — even when a task list they approved mentions "undraft" or "mark ready". Do the
  rest, leave it in draft, and say so.
- **Every factual claim needs evidence.** No permalink or concrete fact → the claim doesn't
  ship. If you couldn't verify it in the code, drop it and record it in the prune table
  (step 4). Never keep an unverified claim by hedging it.
- **The visible body is a summary, never the argument.** `**CLAUDE says:**` leads it; each
  finding gets at most one bolded short claim and one short sentence. No verdict phrase, no
  signature line. See `references/summary-format.md`.
- **Depth always goes in `<details>`, never the visible body.** Mechanism, consequence,
  permalinks, suggested code, counter-arguments — all hidden. The visible list must stay
  short even when the finding is deep; that depth is what `<details>` is for.
- **One comment, not several.** No line-anchored inline comments. Everything lives in the
  single top-level review body.

## Workflow

### 1. Fetch PR context
Run the fetch script with its **absolute path** (CWD is the user's repo, not the skill dir):
```
${CLAUDE_PLUGIN_ROOT}/skills/review/scripts/fetch_pr_context.sh <PR_URL>
```
Writes `pr.json`, `files.json`, `review_comments.json`, `reviews.json`, `combined_comments.md`
to `<repo>/pr_context/`. If it fails (unauthenticated `gh`, bad URL), stop and tell the user.

Capture the **head commit SHA** for permalinks:
```
gh api repos/<owner>/<repo>/pulls/<number> --jq .head.sha
```
Any permalink you use in `<details>` uses `blob/<HEAD_SHA>/...`, never `blob/master`.

### 2. Locate the code and investigate
This is the phase that separates this skill from a linter. For the changed files **and their
dependencies**:
- Check out / read the code at HEAD in the local repo (prefer `~/Klaviyo/Repos/fender` or
  `~/Klaviyo/Repos/app` if the PR is in one — you have the real files). Use `Explore`/`Grep`/
  `Read` to trace: where a constant is defined, what a prop's type actually permits, which
  mount sites exist, whether a guard already handles a case, whether a shared predicate
  already encodes the concept.
- For every candidate finding, run the **validation-first protocol** (below) and gather the
  exact `file#Lline` locations that prove the claim.
- Prefer fewer, deeper findings. A good review makes one or two real points with a clear
  derivation, not a checklist of nits.

### 3. Run repo tooling on changed files
Fold failures in as findings (types → blocking; lint → recommendation). Never let a tooling
problem block the review; note it and continue.
- **fender:** `turbo check-types --filter="@klaviyo/<package>"`, `turbo lint --filter="@klaviyo/<package>" -- <file>`. Always bare `turbo`, never `yarn turbo`. Never repo-wide.
- **app:** `mypy` on changed `src/learning/` files; `bin/pytest -m unit <path>`.

### 4. Prune unproven findings
Write `pr_context/HYPOTHESES.md` before you draft anything. Every candidate finding from
steps 2 and 3 gets one row:

| # | Claim | Proof | Verdict |
|---|-------|-------|---------|
| 1 | the claim, one line | the command you ran and its result, or the `file:Lline` you read at HEAD | KEEP / DROP |

- A row whose Proof column names no command and no `file:Lline` is a **DROP**. You did not
  verify it, so it does not ship.
- **Never soften an unproven claim into a hedge.** "Consider", "it may be worth", and
  "possibly" are how an unverified finding survives the prune. Delete the row instead.
- Read the table again after you write it. Delete every row you cannot defend from the
  Proof column alone.
- Only KEEP rows can appear in the comment (visible body or `<details>`).

### 5. Overlap check
Compare each KEEP finding against existing PR comments/reviews (`review_comments.json`,
`reviews.json`, bot comments from CodeRabbit/Cursor).

- **A human reviewer's open thread is theirs. Drop the point.** This holds even when you
  disagree with them, and even when you have evidence they lack. Report the disagreement to
  the user separately — do not fold it into the posted comment.
- **A bot already raised it → drop it.** Never re-post the same point as if novel.
- **You observed a symptom a human reported, and you found the cause** → this is the one
  case worth keeping. Credit their observation in `<details>`, not in the visible lead.

### 6. Draft the comment locally
Write to `pr_context/DRAFT_REVIEW.md` per `references/summary-format.md`:
- The visible body: `**CLAUDE says:**`, then either one short claim (single finding) or a
  numbered list capped at ~3-4 items (multiple findings), each item one bolded short claim
  plus at most one short sentence. No verdict label, no signature, no mechanism, no code.
- A trailing `<details><summary>Additional context</summary>...</details>`, numbered to
  match the visible list, with the permalinks, derivations, suggested code,
  counter-arguments, and dropped/overlap notes.

Build the machine payload at `pr_context/review_payload.json` for `scripts/post_review.py`:
```json
{
  "pr_url": "https://github.com/<owner>/<repo>/pull/<number>",
  "event": "COMMENT",
  "body": "<the full comment markdown from DRAFT_REVIEW.md>"
}
```
No `comments` array — this skill posts a review body only, never line-anchored comments.

### 7. Confirm, then post
Show the user `DRAFT_REVIEW.md`. State the target PR and the `event` (default `COMMENT`).
Ask for approval unless `--post` was given.

On approval, dry-run first, then post:
```
python3 ${CLAUDE_PLUGIN_ROOT}/skills/review/scripts/post_review.py --payload pr_context/review_payload.json --dry-run
python3 ${CLAUDE_PLUGIN_ROOT}/skills/review/scripts/post_review.py --payload pr_context/review_payload.json
```
Report the posted review URL.

## Validation-first protocol (every finding)
Before a finding earns a place in the comment:
1. **Read the actual file at HEAD**, not the stale diff.
2. **Check surrounding context** — already guarded/handled elsewhere?
3. **Check codebase precedent** — a convention the repo already uses is not a novel defect.
   (Biggest false-positive source.)
4. **Articulate a concrete failure/consequence** — specific input, state, or the exact lines
   that make the claim true. Can't? Drop it.
5. **Gather the permalinks** that prove it. A claim without evidence does not ship.

## What a good comment contains
Per `references/summary-format.md`, read it before drafting. In short: `**CLAUDE says:**` +
a one-sentence claim per finding (numbered if more than one) → `<details>` with permalinks,
derivation, minimal suggested code, and the honest counter-argument.

## Finding discipline
- Keep the visible body to one-sentence claims only — cap at ~3-4 numbered items.
- Rank by impact. A no-op condition that lets you delete a whole file beats three style nits.
- If the PR is genuinely clean, say so briefly. Do not manufacture findings.

## Operating rules
- Ground every claim in the actual code at HEAD; cite files/lines/permalinks in `<details>`.
- Prune before you draft. A finding with no command output and no `file:Lline` gets deleted,
  not hedged. See step 4.
- Never post before the user approves the draft (unless `--post`).
- Never auto-approve; default `event` is `COMMENT`.
- Never post onto a thread a human reviewer already opened. See step 5.
- Suggested fixes are minimal, concrete shapes — the smallest edit that expresses the idea.
- Match `code-review`'s severity/precedent rigor; this skill differs only in **output channel**
  (posted comment) and **depth expectation** (permalink-backed investigation, kept out of the
  visible body).
