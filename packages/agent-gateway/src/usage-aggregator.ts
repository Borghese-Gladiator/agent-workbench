import type { ModelUsage } from '@awb/domain';

/** Accumulates ModelUsage events across an agent session's turns into totals, optionally broken down by model. */
export class UsageAggregator {
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalCachedInputTokens = 0;
  private totalCostUsd = 0;
  private readonly byModel = new Map<string, { inputTokens: number; outputTokens: number }>();

  record(usage: ModelUsage): void {
    this.totalInputTokens += usage.inputTokens;
    this.totalOutputTokens += usage.outputTokens;
    this.totalCachedInputTokens += usage.cachedInputTokens ?? 0;
    this.totalCostUsd += usage.costUsd ?? 0;

    const existing = this.byModel.get(usage.model) ?? { inputTokens: 0, outputTokens: 0 };
    existing.inputTokens += usage.inputTokens;
    existing.outputTokens += usage.outputTokens;
    this.byModel.set(usage.model, existing);
  }

  totals(): { inputTokens: number; outputTokens: number; cachedInputTokens: number; costUsd: number } {
    return {
      inputTokens: this.totalInputTokens,
      outputTokens: this.totalOutputTokens,
      cachedInputTokens: this.totalCachedInputTokens,
      costUsd: this.totalCostUsd,
    };
  }

  breakdownByModel(): Record<string, { inputTokens: number; outputTokens: number }> {
    return Object.fromEntries(this.byModel);
  }
}
