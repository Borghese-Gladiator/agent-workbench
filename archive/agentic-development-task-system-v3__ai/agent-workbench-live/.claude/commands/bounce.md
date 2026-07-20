---
description: Bounce an Agent Workbench run from human_review back to building. Asks the user structured questions, writes a change-request.md artifact, then transitions state. Use when the user wants changes before accepting.
---

# /bounce

LLM-bearing. Gathers structured feedback from the human, writes (or appends to) `runs/$RUN_ID/change-request.md`, then transitions `human_review -> building`.

## Step 1 — verify state and load context

Run this first (deterministic) to confirm the run is bounceable:

```bash
agent-workbench run-show "$RUN_ID"
```

If `status` is not `human_review`, stop and tell the user — `/bounce` only applies in `human_review`. Do not edit `metadata.yaml` directly.

Then read for context:

- `runs/$RUN_ID/handoff.md` — what the agent handed off
- `runs/$RUN_ID/review.md` — self-review findings
- `runs/$RUN_ID/implementation-summary.md` — what was built
- `runs/$RUN_ID/diff-summary.md` — what changed in code

Also check whether `runs/$RUN_ID/change-request.md` already exists. Count the existing `## Bounce ` headings in it — that determines the next bounce number `N` (1 if file does not exist, otherwise `existing_count + 1`).

## Step 2 — ask the user structured questions

Use `AskUserQuestion` to ask **all four** of these in a single message:

1. **Scope** (single-select): *Which parts need rework?*
   - Implementation
   - Tests
   - Docs
   - Multiple
2. **Severity** (single-select): *How significant?*
   - Tweak (small diff)
   - Rework (partial redo)
   - Restart (rebuild from plan)
3. **Plan/brief impact** (single-select): *Does the plan or brief need updating first?*
   - No, just rebuild
   - Yes, update plan
   - Yes, update brief
4. **Specifics** (single-select with `Other` for free text): *What exactly needs to change?*
   - (Use `Other` to capture the detailed description — this is the body of the change-request)

Do not skip any question. Do not invent answers.

## Step 3 — write or append change-request.md

Compose a section with this exact structure (replace placeholders, keep headings):

```markdown
## Bounce N — <ISO 8601 UTC timestamp> — <requested_by>

**Scope:** <answer 1>
**Severity:** <answer 2>
**Plan/brief impact:** <answer 3>

### Specific changes requested

<answer 4 — the free-text specifics>

### References

- Handoff: `runs/$RUN_ID/handoff.md`
- Review: `runs/$RUN_ID/review.md`
- Implementation summary: `runs/$RUN_ID/implementation-summary.md`
```

If `N > 1`, prepend a one-line note: `_Previous bounce raised: <one-line summary of the prior section's Specific changes>_.`

**File-handling rules:**

- If `runs/$RUN_ID/change-request.md` does not exist: write a new file starting with `# Change Request — $RUN_ID\n\n` followed by the section above.
- If it does exist: append a horizontal rule (`\n\n---\n\n`) followed by the new section. Preserve all prior content verbatim.

Use real newlines, not literal `\n`.

## Step 4 — finalize the transition

Compose a one-line `bounce_reason` summarizing the request (e.g. `"Pair-ranking logic incorrect; rework hand evaluator"`). Then:

```bash
agent-workbench bounce "$RUN_ID" \
  --reason "<one-line summary>" \
  --requested-by "$USER" \
  --change-request-path "runs/$RUN_ID/change-request.md"
```

That verifies the artifact exists, records `change_request_path` as transition evidence, emits a `BounceRequested` event, and flips state to `building`. The original branch and worktree are preserved.

If the CLI rejects the call (e.g. file missing/empty, status changed), stop and report — do not retry blindly.

## Next step

The run is back in `building`. Use `/start $RUN_ID` or the agent's resume flow to pick it up; the rebuild pass should read `runs/$RUN_ID/change-request.md` for the latest feedback.

## Reference

See `docs/lifecycle.md` § `human_review` → `building`.
