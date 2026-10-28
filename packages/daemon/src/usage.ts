import { readFileSync } from "node:fs";

export type Usage = { input: number; output: number; cache_read: number; cache_creation: number };

export function tokenTotals(transcriptPath: string): Usage {
  const byId = new Map<string, Record<string, unknown>>();
  for (const line of readFileSync(transcriptPath, "utf8").split("\n")) {
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = row.message?.usage;
    if (usage) byId.set(row.message.id ?? row.uuid, usage);
  }
  const total: Usage = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  for (const u of byId.values()) {
    total.input += n(u.input_tokens);
    total.output += n(u.output_tokens);
    total.cache_read += n(u.cache_read_input_tokens);
    total.cache_creation += n(u.cache_creation_input_tokens);
  }
  return total;
}
