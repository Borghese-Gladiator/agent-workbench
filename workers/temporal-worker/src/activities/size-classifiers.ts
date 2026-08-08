import { sizingInstruction, parseSizingOutput, type SizingInput, type SizeClassification } from '@awb/planning';
import type { CodingAgentAdapter } from '@awb/agent-gateway';

/**
 * The two size classifiers (TASK-51), colocated as sibling functions with the same shape:
 * `(input, opts) => Promise<SizeClassification | undefined>`. One authoritative (Claude/Haiku, via the
 * agent SDK — works under the workbench's ambient Claude login, no API key), one local shadow (Ollama,
 * direct HTTP). Both parse through the shared `parseSizingOutput` and return `undefined` on any failure
 * — a classifier never invents a size; the contract's `size ?? 'M'` default is the single degradation
 * policy. `classifier-support.ts` orchestrates: runs them, compares, logs.
 */

/** The small/fast Claude model used for the authoritative classification. Cheap by design. */
export const SIZE_CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';

/** Default small local model for the shadow classifier; override with AWB_SHADOW_CLASSIFIER_MODEL. */
export const DEFAULT_SHADOW_CLASSIFIER_MODEL = 'llama3.2:3b';
const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434';
const OLLAMA_TIMEOUT_MS = 20_000;

export interface ClaudeClassifierOpts {
  adapter: CodingAgentAdapter;
  taskId: string;
  cwd: string;
  model: string;
  allowedTools: string[];
  disallowedTools: string[];
}

/**
 * Authoritative size classification via a tiny Claude model (Haiku) through the agent adapter. Returns
 * `undefined` when the call fails or the output is unparseable.
 */
export async function classifyWithClaude(
  input: SizingInput,
  opts: ClaudeClassifierOpts,
): Promise<SizeClassification | undefined> {
  try {
    const session = await opts.adapter.createSession({
      role: 'planner',
      taskId: opts.taskId,
      cwd: opts.cwd,
      contextPayload: {},
      allowedTools: opts.allowedTools,
      disallowedTools: opts.disallowedTools,
      model: opts.model,
    });
    let text = '';
    const execution = await opts.adapter.execute(
      session,
      { instruction: sizingInstruction(input), stopConditions: { maxTurns: 1 } },
      (event) => {
        if (event.type === 'message') text += event.text;
      },
      new AbortController().signal,
    );
    await opts.adapter.dispose(session);
    // The answer usually lands in the result summary; fall back to streamed message text.
    return parseSizingOutput(execution.summary) ?? parseSizingOutput(text);
  } catch {
    return undefined;
  }
}

/**
 * True when the shadow (local) classifier is enabled — gated behind `AWB_CLASSIFIER_SHADOW=1` so
 * normal real runs make a single (Claude) classification call; the local second opinion is opt-in for
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
 * Shadow size classification against a LOCAL model via Ollama's HTTP API directly — deliberately NOT
 * routed through a coding-agent adapter (Pi/CLI/streaming/watchdog), since classification is a single
 * prompt-in / JSON-out completion. Returns `undefined` on ANY failure (Ollama down, timeout,
 * unparseable) — observe-only, must never block or fail the task.
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
