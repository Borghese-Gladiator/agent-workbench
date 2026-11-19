# Review comment format

The skill posts exactly **one** top-level review comment. No inline/line-anchored comments.

The visible body is a **summary only** — short enough to read in a few seconds. All depth
(mechanism, consequence, derivation, permalinks, suggested code, counter-arguments) goes in
a collapsed `<details>` block. The visible body must stay readable and complete on its own;
the `<details>` block is for someone who wants to verify the claim, not to complete it.

## Structure — single issue

Use this when there is exactly one KEPT finding.

```
**CLAUDE says:** <one, at most two, short sentences — the claim and why it matters. No
mechanism, no code, no permalink.>

<details>
<summary>Additional context</summary>

<the full depth: derivation, permalinks, suggested code shape, counter-argument.>

</details>
```

## Structure — multiple issues

Use this when there are 2+ KEPT findings. Each item is bolded and capped at one short
sentence — a label, not an explanation.

```
**CLAUDE says:** <optional one-line framing, e.g. "A few issues to address before this
becomes the <X> path:">

1. **<short bold claim>** <at most one short sentence of summary.>
2. **<short bold claim>** <at most one short sentence of summary.>
3. **<short bold claim>** <at most one short sentence of summary.>

<Optional, unbolded: "Non-blocking: <one short sentence>" for a lower-priority note.>

<details>
<summary>Additional context</summary>

1. <the depth for item 1: mechanism, consequence, permalinks, suggested code, counter-argument.>
2. <the depth for item 2: ...>
3. <the depth for item 3: ...>

</details>
```

## Rules

1. **Only the bold spans are `**CLAUDE says:**` and each numbered item's short claim.** No
   verdict phrase, no `## AI collab review` header, no signature line.

2. **The visible body is a summary, never the argument.** One sentence per item — what the
   issue is, not why, not how, not the fix. If a sentence needs a permalink, a code sample,
   or the word "because" followed by more than a few words of mechanism, that content moves
   to `<details>`.

3. **Depth lives in `<details><summary>Additional context</summary>...</details>`, numbered
   to match the visible list:**
   - The mechanism and concrete consequence (specific input/state/lines that make it real).
   - SHA-pinned permalinks (`https://github.com/<owner>/<repo>/blob/<HEAD_SHA>/<path>#L<line>`).
   - A minimal suggested code shape, in a fenced block, if one is worth showing.
   - The fair counter-argument, stated honestly, if one exists.
   - Overlap notes: findings dropped because a human reviewer or bot already raised them.
   - Findings dropped during pruning because they could not be verified.

4. **Cap at ~3-4 numbered items.** More than that means the review needs pruning harder, not
   a longer list.

5. **No signature line.** Do not append the robot signature to the review body.

6. **Reference shape** (visible body only — this is what a reader sees without opening
   `<details>`):

   > **CLAUDE says:** A few issues to address before this becomes the Dashboard/Composer
   > integration path:
   >
   > 1. **Please avoid copying the fetched widget collection into local state.** It becomes
   >    a second source of truth that never updates when the query result changes.
   > 2. **Save and Delete need to block each other in both directions.** Right now Save can
   >    still run while a Delete is pending.
   > 3. **The PR description says the sparkle action reopens the widget's chart in
   >    Composer, but the callback doesn't pass widget or origin context.**
   >
   > Non-blocking product question: Delete is immediate while layout edits wait for Save —
   > is that asymmetry intentional?

   Everything past the one-sentence claim in each item — the `useState(initialWidgets)`
   detail, the `dashboard-id` remount point, the mutation-guard suggestion, the atomic-DELETE
   question — belongs in `<details>`, not in this visible list.

## Event mapping

- Any blocking correctness/security concern → `REQUEST_CHANGES` only if the user explicitly
  asks for it. Default is always `COMMENT`.
- Never auto-`APPROVE`. Approval is the human's to give.
