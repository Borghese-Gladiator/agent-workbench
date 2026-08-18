# TASK-62 — Shadow size-classifier evaluation

## Question

Which local model is good enough to replace (or shadow) the authoritative Haiku
size classifier? Weigh accuracy against cost, penalizing **under-sizing** (a run
that skips plan/program-design it needed) more than over-sizing.

## Corpus

`docs/task-62-corpus.json` — ~40 curated prompts, balanced across four buckets:

- **clear-S** — atomic, local, one obvious direction.
- **clear-L** — public contract / schema / security / migration / cross-system.
- **borderline S–M** — coordinated edits in one area (M is the "when unsure" default).
- **borderline M–L** — bounded work that a schema/contract/persistence concern can tip to L.

Each case carries `{prompt, expected, rationale}`; the rationale names the
deciding evidence (blast radius / boundary), never prompt length.

## Runner

`scripts/size-classifier-eval.mjs` (read-only). For each model it runs every
prompt N times and reports:

- **accuracy** — majority vote vs expected.
- **agreement** — self-consistency across the N runs.
- **cost-weighted error** — `scoreSizeComparison`: 0 correct, +1/rank over-sized,
  +2/rank under-sized (unavailable = max under-size). Shared verbatim with the
  live shadow path in `classifier-support.ts`, which now records `underSized` +
  `costWeight` on the `size-classifier-shadow` semantic event.

```
node scripts/size-classifier-eval.mjs \
  --models llama3.2:3b,qwen3:30b,gemma,qwen3-coder:30b --runs 5
```

## Results (fill after running against pulled models)

| model | accuracy | agreement | cost-weighted error | under-sized |
| --- | --- | --- | --- | --- |
| llama3.2:3b | | | | |
| qwen3:30b | | | | |
| gemma | | | | |
| qwen3-coder:30b | | | | |

## Recommendation (per model)

_Promote to authoritative / keep as shadow only / decline — a model is
promotable only if it beats Haiku's agreement with a low under-sized count; a
high cost-weighted error disqualifies it regardless of raw accuracy._
