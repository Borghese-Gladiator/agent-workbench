export type Price = { input: number; output: number; cacheRead: number };

export const PRICES: Record<string, Price> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
};

const BY_LENGTH = Object.keys(PRICES).sort((a, b) => b.length - a.length);

export function priceOf(model: string): Price | null {
  const key = BY_LENGTH.find((k) => model.startsWith(k));
  return key ? PRICES[key] : null;
}

export function usageCost(model: string, u: Record<string, unknown>): number | null {
  const p = priceOf(model);
  if (!p) return null;
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  const usd =
    n(u.input_tokens) * p.input +
    n(u.cache_creation_input_tokens) * p.input * 1.25 +
    n(u.cache_read_input_tokens) * p.cacheRead +
    n(u.output_tokens) * p.output;
  return usd / 1_000_000;
}
