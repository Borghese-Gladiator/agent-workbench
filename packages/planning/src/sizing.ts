import type { TaskSize } from '@awb/domain';

/**
 * Cheap, model-free signals about a task, gathered at intake before spending a classification call
 * (TASK-51 / WSFF: "size from cheap signals first"). All optional so a caller can supply whatever it
 * has; the heuristic degrades gracefully.
 */
export interface SizingSignals {
  /** The raw task prompt. */
  prompt: string;
  /** Number of files the prompt/plan is expected to touch, if known from the structure map. */
  targetFileCount?: number;
  /** Number of distinct packages/workspaces the change spans, if known. */
  packageSpan?: number;
}

const PROMPT_S_MAX = 160;
const PROMPT_L_MIN = 600;

/**
 * Deterministic S/M/L heuristic over cheap signals (TASK-51). Also the fallback when the tiny-model
 * classifier is unavailable (mock runtime, no model, unparseable output), so classification always
 * yields a size. Bias: cross-package span or many files ⇒ L; a short single-target prompt ⇒ S.
 */
export function classifyTaskSize(signals: SizingSignals): TaskSize {
  const { prompt } = signals;
  const fileCount = signals.targetFileCount ?? 0;
  const span = signals.packageSpan ?? 0;

  // Cross-package or many-file work is Large regardless of prompt length.
  if (span >= 2 || fileCount >= 6) return 'L';

  const len = prompt.trim().length;
  // Small (single-shot) requires POSITIVE evidence of smallness: a short prompt AND a known low file
  // count. A short prompt with an unknown file count is NOT single-shotted — default up to M, since
  // single-shotting a task we can't size is exactly the 2000-line-dump risk WSFF warns against.
  const fileCountKnown = signals.targetFileCount !== undefined;
  if (len <= PROMPT_S_MAX && fileCountKnown && fileCount <= 1 && span <= 1) return 'S';
  // A long prompt (or a handful of files) that isn't cross-package is still Large.
  if (len >= PROMPT_L_MIN || fileCount >= 4) return 'L';
  // Everything in between is Medium.
  return 'M';
}

/**
 * The instruction handed to the tiny-model classifier session (TASK-51). It sees the cheap signals
 * and must emit exactly one size token in a JSON block. Mirrors `plannerInstruction`'s contract:
 * the model has a precise target and the gate/parse can check it.
 */
export function sizingInstruction(signals: SizingSignals): string {
  return [
    'Classify the SIZE of this software task as one of S, M, or L, using the WSFF 80/20 rule:',
    '- S (single-shot): a trivial, single-target change (e.g. a one-line edit, a copy tweak).',
    '- M (medium): a self-contained change to one area needing a short plan, but no separate program design.',
    '- L (large): a multi-file or multi-package feature that deserves a full plan AND a program-design pass.',
    '',
    `Task prompt: ${signals.prompt}`,
    signals.targetFileCount !== undefined ? `Approx files touched: ${signals.targetFileCount}.` : '',
    signals.packageSpan !== undefined ? `Packages/workspaces spanned: ${signals.packageSpan}.` : '',
    '',
    'Respond with ONLY a JSON object as a fenced ```json code block: {"size": "S" | "M" | "L"}.',
  ]
    .filter(Boolean)
    .join('\n');
}

function extractJsonBlock(text: string): string | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  const brace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (brace !== -1 && lastBrace > brace) return text.slice(brace, lastBrace + 1);
  return undefined;
}

/**
 * Parses a classifier session's textual output into a `TaskSize`. Returns undefined when nothing
 * usable is present so the caller can fall back to `classifyTaskSize` — the classifier is advisory,
 * never a hard dependency (external tooling stays model-agnostic per the standing learning).
 */
export function parseSizingOutput(text: string): TaskSize | undefined {
  const block = extractJsonBlock(text);
  const candidate = block ?? text;
  const match = candidate.match(/"?size"?\s*[:=]?\s*"?(S|M|L)"?/i) ?? candidate.match(/\b(S|M|L)\b/);
  const raw = match?.[1]?.toUpperCase();
  return raw === 'S' || raw === 'M' || raw === 'L' ? (raw as TaskSize) : undefined;
}
