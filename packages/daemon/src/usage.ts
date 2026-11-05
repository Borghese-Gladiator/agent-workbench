import { readFileSync } from "node:fs";
import { usageCost } from "./prices.ts";

export type Usage = { input: number; output: number; cache_read: number; cache_creation: number; cost_usd: number | null };

export function tokenTotals(transcriptPath: string): Usage {
  const byId = new Map<string, { model: string; usage: Record<string, unknown> }>();
  let result: Record<string, any> | null = null;
  for (const line of readFileSync(transcriptPath, "utf8").split("\n")) {
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.type === "result" && row.usage) result = row;
    const usage = row.message?.usage;
    if (usage) byId.set(row.message.id ?? row.uuid, { model: String(row.message.model ?? ""), usage });
  }
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  if (result) {
    const u = result.usage;
    return {
      input: n(u.input_tokens),
      output: n(u.output_tokens),
      cache_read: n(u.cache_read_input_tokens),
      cache_creation: n(u.cache_creation_input_tokens),
      cost_usd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : null,
    };
  }
  const total: Usage = { input: 0, output: 0, cache_read: 0, cache_creation: 0, cost_usd: 0 };
  for (const { model, usage: u } of byId.values()) {
    total.input += n(u.input_tokens);
    total.output += n(u.output_tokens);
    total.cache_read += n(u.cache_read_input_tokens);
    total.cache_creation += n(u.cache_creation_input_tokens);
    const usd = usageCost(model, u);
    total.cost_usd = usd === null || total.cost_usd === null ? null : total.cost_usd + usd;
  }
  return total;
}
