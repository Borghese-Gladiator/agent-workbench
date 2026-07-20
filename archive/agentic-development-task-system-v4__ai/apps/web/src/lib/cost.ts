import type { CostEventPayload, TokenUsage } from '@workbench/core';

/**
 * A cost/turn/token summary for display. Superset shape shared by the live
 * `cost` SSE event (`CostEventPayload`) and the persisted/aggregated views
 * (summed runs) — every field nullable so partial data renders cleanly.
 */
export interface CostSummary extends TokenUsage {
  totalCostUsd: number | null;
  numTurns: number | null;
}

/**
 * The run fields `sumRunCost` reads — a structural subset so it works with
 * either the core or the client `AgentRun` type (both supply these).
 */
export type RunCostFields = CostSummary;

/**
 * Humanize a token count: 0–999 as-is, then whole-number `k` up to 1M, then
 * `M` with one decimal. Whole k keeps the meta line tidy (`22k`, not `22.0k`);
 * sub-1k counts stay exact since they're small enough to read raw.
 */
export function humanTokens(n: number | null): string | null {
  if (n == null) return null;
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Render a cost summary as compact meta segments, e.g.
 * `14 turns · $0.3300 · 22k in · 4k out · 310k cached`. Token segments appear
 * only when present; `cached` is `cacheReadInputTokens` (the spend lever on
 * resumed sessions). Returns `[]` when there's nothing to show.
 */
export function costSegments(cost: CostSummary | null): string[] {
  if (!cost) return [];
  const segs: string[] = [];
  if (cost.numTurns != null) segs.push(`${cost.numTurns} turns`);
  if (cost.totalCostUsd != null) segs.push(`$${cost.totalCostUsd.toFixed(4)}`);
  const input = humanTokens(cost.inputTokens);
  const output = humanTokens(cost.outputTokens);
  const cached = humanTokens(cost.cacheReadInputTokens);
  if (input) segs.push(`${input} in`);
  if (output) segs.push(`${output} out`);
  if (cached) segs.push(`${cached} cached`);
  return segs;
}

/** True when a summary carries any cost/turn/token figure worth rendering. */
export function hasCostData(cost: CostSummary | null): boolean {
  if (!cost) return false;
  return (
    cost.totalCostUsd != null ||
    cost.numTurns != null ||
    cost.inputTokens != null ||
    cost.outputTokens != null ||
    cost.cacheCreationInputTokens != null ||
    cost.cacheReadInputTokens != null
  );
}

/** The live `cost` SSE event payload is already a display-ready summary. */
export function summaryFromCostEvent(p: CostEventPayload): CostSummary {
  return p;
}

/**
 * Sum cost/turns/tokens across a list of runs. A field stays null only when NO
 * run supplied it (so a single mock run with null tokens doesn't read as 0);
 * once any run has a value, nulls in others count as 0.
 */
export function sumRunCost(runs: RunCostFields[]): CostSummary {
  const acc: CostSummary = {
    totalCostUsd: null,
    numTurns: null,
    inputTokens: null,
    outputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
  };
  const add = (a: number | null, b: number | null): number | null => (b == null ? a : (a ?? 0) + b);
  for (const r of runs) {
    acc.totalCostUsd = add(acc.totalCostUsd, r.totalCostUsd);
    acc.numTurns = add(acc.numTurns, r.numTurns);
    acc.inputTokens = add(acc.inputTokens, r.inputTokens);
    acc.outputTokens = add(acc.outputTokens, r.outputTokens);
    acc.cacheCreationInputTokens = add(acc.cacheCreationInputTokens, r.cacheCreationInputTokens);
    acc.cacheReadInputTokens = add(acc.cacheReadInputTokens, r.cacheReadInputTokens);
  }
  return acc;
}
