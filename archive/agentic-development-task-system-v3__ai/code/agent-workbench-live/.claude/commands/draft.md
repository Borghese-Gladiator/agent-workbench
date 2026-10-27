---
description: Run an Agent Workbench draft pass. Read raw-idea.md, decide whether material intent ambiguity exists, ask the human via AskUserQuestion if so, write answers.md, then transition draft -> shaping. The only stage that may ask the human questions.
---

# /draft

LLM-bearing. Sits between `/new-run` (which only persists `raw-idea.md`) and `/shape` (which authors the brief code-blind). This is the **only** stage allowed to ask the human clarifying questions; subsequent stages convert unknowns into recorded assumptions or decisions instead.

## Step 1 — verify state and stage the answers template

Run this first (deterministic):

```bash
agent-workbench draft "$RUN_ID" --init
```

That:
- verifies `status=draft`
- copies `templates/answers.md` into `runs/$RUN_ID/answers.md`
- emits an `ArtifactWritten` event

If it fails (e.g. status is wrong), stop and tell the user. Do not edit `metadata.yaml` directly.

## Step 2 — decide whether to ask

Read `runs/$RUN_ID/raw-idea.md`.

Ask **only** if a clarification would **materially change** one of:

- **Goal** — the actual outcome the user wants.
- **Target repo / area** — which codebase or subsystem is touched.
- **User-facing behavior** — what end users see or do differently.
- **Acceptance criteria** — how success is measured.

Do **not** ask about:

- Implementation choices the repo's conventions can settle (`/plan` will record those as decisions).
- Style, naming, or formatting questions.
- Anything you can reasonably assume and record as an Assumption in `brief.md` later.

If the raw idea is already specific on all four bars above, **skip to Step 4 with no answers.md**.

## Step 3 — ask (only if Step 2 said to)

Use `AskUserQuestion` to ask the clarifying questions in a single message. Keep it to **at most 4 questions**. Each question must:

- Tie back to one of the four "material change" bars above.
- Offer 2–4 concrete options the user can pick from. Use single-select unless the answers are genuinely independent. The user can always pick `Other` to free-text.

Then **write `runs/$RUN_ID/answers.md`** with one `## Qn` block per question, using this exact structure:

```markdown
# Answers

## Q1
**Question:** <the question as asked>
**Answer:** <the user's chosen option, plus any Other free-text>

## Q2
...
```

Real newlines, not literal `\n`. Overwrite the staged template — do not append.

## Step 4 — finalize the transition

If you asked questions and wrote `answers.md`, leave it on disk. If you decided not to ask, **delete** the staged template:

```bash
rm "runs/$RUN_ID/answers.md"
```

Then run:

```bash
agent-workbench draft "$RUN_ID"
```

That:
- verifies `status=draft` and that `raw-idea.md` is non-empty
- includes `answers_path` as transition evidence iff `answers.md` exists at the run root
- transitions `draft -> shaping`
- moves `raw-idea.md` (and `answers.md` if present) into `stages/1_draft/`

## Next step

Auto-chain: immediately invoke `/shape $RUN_ID` once the CLI confirms `draft -> shaping`. The human gates are still only `ready` (handled by `/start`) and `human_review`.

## Rules

- **At most 4 questions.** If you'd ask more, you're confusing material ambiguity with implementation detail. Trim to the four bars above.
- **Do NOT read code.** This stage is code-blind. If you need code to decide, defer the question to `/plan`'s assumption log.
- **Do NOT fabricate answers.** If you skipped asking, just don't write `answers.md`. The CLI handles that case explicitly.
- **Do NOT edit `metadata.yaml`.** Only the CLI may set status.

## Reference

`docs/lifecycle.md` § `draft`.
