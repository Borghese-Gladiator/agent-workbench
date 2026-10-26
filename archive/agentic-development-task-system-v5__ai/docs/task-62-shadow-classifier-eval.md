# TASK-62 — Shadow size-classifier evaluation

## Question

Which local model is good enough to replace (or shadow) the authoritative Haiku
size classifier? Weigh accuracy against cost, penalizing **under-sizing** (a run
that skips plan/program-design it needed) more than over-sizing.

## Corpus

`docs/task-62-corpus.json` — 40 curated prompts (10 S / 15 M / 15 L), balanced
across four buckets:

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
  --models llama3.2:latest,qwen3:30b,qwen3-coder:30b,gemma4:26b --runs 3
```

(Use the exact Ollama tags pulled locally — `llama3.2:latest`, `gemma4:26b` here,
not the generic `llama3.2:3b` / `gemma` labels.)

## Results (40-case corpus, 3 runs/prompt, local Ollama)

| model | accuracy | agreement | cost-weighted error | under-sized |
| --- | --- | --- | --- | --- |
| `qwen3-coder:30b` | **82.5%** | **99.2%** | **14** | **7 / 40** |
| `gemma4:26b` | 80.0% | 90.8% | 16 | 8 / 40 |
| `llama3.2:latest` | 60.0% | 78.3% | 31 | 13 / 40 |
| `qwen3:30b` | 0.0% | 0.0% | 170 | 40 / 40 |

Reference: the corpus is 10 S / 15 M / 15 L; a model that answered "M" for
everything would score ~37% accuracy with a low under-sized count, so accuracy
below ~40% is worse than a constant guess.

## Recommendation (per model)

- **`qwen3-coder:30b` — promote to shadow-default; candidate for authoritative
  after a live cross-check.** Best on every axis: 82.5% accuracy, 99.2%
  self-consistency (near-deterministic), the lowest cost-weighted error (14), and
  only 7/40 under-sized. The high agreement matters most — a shadow classifier
  that flip-flops run-to-run is useless. Promote it as the default
  `AWB_SHADOW_CLASSIFIER_MODEL` now; before making it *authoritative* (replacing
  Haiku), run it in shadow against live tasks and confirm its 7 under-sized cases
  aren't concentrated on the borderline M–L bucket that actually ships risk.
- **`gemma4:26b` — keep as shadow.** A close second (80.0% / 90.8% / err 16 /
  8 under-sized) and a fine fallback, but its lower agreement and one extra
  under-size don't beat qwen3-coder. No reason to promote it over the leader; keep
  it available as an alternate shadow model.
- **`llama3.2:latest` — decline (as authoritative); acceptable only as a cheap
  shadow.** 60% accuracy and 13/40 under-sized is disqualifying for anything that
  gates plan/program-design — one in three L/M tasks would be under-sized and skip
  the ceremony it needed. Its only merit is speed/size; keep it only if a
  larger model can't be hosted.
- **`qwen3:30b` — decline (harness-incompatible, not evaluated on merit).** It
  scored 0/40 because it is a *thinking* model: under Ollama's `format: 'json'`
  grammar constraint (the exact path `classifyWithOllama` uses) it returns an
  **empty** `response` — its output goes to a suppressed thinking channel — so
  every prediction parses as unavailable and is scored as a max under-size. This
  is a real integration finding: the shadow classifier's JSON-mode generate call
  cannot use thinking models as-is. To evaluate qwen3:30b fairly, the runner would
  need to drop `format: 'json'` and strip `<think>` blocks before parsing;
  qwen3-**coder** (non-thinking) returns clean JSON on the same path and is the
  better fit regardless.

**Bottom line:** promote `qwen3-coder:30b` as the shadow default; keep `gemma4:26b`
as fallback; `llama3.2` and `qwen3:30b` decline for authoritative use.

## Captured run (QA evidence)

Raw output of the run the table above is derived from (`--runs 3`, local Ollama,
2026-08-17):

```
llama3.2:latest             60.0%     78.3%       31          13   (done 22:54)
qwen3:30b                    0.0%      0.0%      170          40   (done 23:05)
qwen3-coder:30b             82.5%     99.2%       14           7   (done 23:12)
gemma4:26b                  80.0%     90.8%       16           8   (done 23:22)
```

Reproduce with the command under "Runner" above; numbers vary slightly run-to-run
below the agreement figure (sampling), but the ranking is stable.
