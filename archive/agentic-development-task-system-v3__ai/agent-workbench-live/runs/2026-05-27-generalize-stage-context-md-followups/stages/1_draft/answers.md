# Answers

## Q1
**Question:** What's the scope of this single run for §5?
**Answer:** All three siblings now — ship `plan-context.md`, `followups-context.md`, AND `shape-context.md` in this one run. Closes §5 in one shot; per-file code is bounded by the build-context.md / validate-context.md template.

## Q2
**Question:** What's the call on shape-context.md specifically?
**Answer:** Build it for consistency. The §5 contract is "every LLM-bearing stage has a `<stage>-context.md`"; skipping shape would leave the contract uneven. Shape's code is the thinnest of the three (inline raw-idea + answers + template skeleton + the two shaping rules), so the cost is low.
