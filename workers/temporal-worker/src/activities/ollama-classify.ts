import { sizingInstruction, parseSizingOutput, type SizingInput, type SizeClassification } from '@awb/planning';

/** Default small local model for the shadow size classifier (TASK-51); override with AWB_SHADOW_CLASSIFIER_MODEL. */
export const DEFAULT_SHADOW_CLASSIFIER_MODEL = 'llama3.2:3b';
const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434';
const OLLAMA_TIMEOUT_MS = 20_000;

/**
 * True when the shadow (local) classifier is enabled — gated behind `AWB_CLASSIFIER_SHADOW=1` so
 * normal real runs make a single (Haiku) classification call; the local second opinion is opt-in for
 * evaluation sessions (TASK-61).
 */
export function shadowClassifierEnabled(): boolean {
  return process.env.AWB_CLASSIFIER_SHADOW === '1';
}

export function shadowClassifierModel(): string {
  return process.env.AWB_SHADOW_CLASSIFIER_MODEL || DEFAULT_SHADOW_CLASSIFIER_MODEL;
}

function ollamaHost(): string {
  return process.env.AWB_OLLAMA_HOST || DEFAULT_OLLAMA_HOST;
}

/**
 * Classifies task size against a LOCAL model via Ollama's HTTP API directly (TASK-51 shadow path).
 * This is deliberately NOT routed through a coding-agent adapter (Pi/CLI/streaming/watchdog) — size
 * classification is a single prompt-in / JSON-out completion, so it uses Ollama's `/api/generate`
 * with `format: json` and nothing else. Returns `undefined` on ANY failure (Ollama down, timeout,
 * unparseable) — the shadow is observe-only and must never block or fail the task.
 */
export async function classifyWithOllama(
  input: SizingInput,
  model: string = shadowClassifierModel(),
): Promise<SizeClassification | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
  try {
    const response = await fetch(`${ollamaHost()}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: sizingInstruction(input), stream: false, format: 'json' }),
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { response?: string };
    // Ollama returns the model's text in `response`; with format:json it is a JSON string we parse
    // through the same forgiving parser the Claude path uses.
    return body.response ? parseSizingOutput(body.response) : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
