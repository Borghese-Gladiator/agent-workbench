import { createHash } from 'node:crypto';

/**
 * The single source of truth for every network identity a stack occupies: the four service ports,
 * the OTel collector's container name, the Temporal task queue, and the derived Temporal/daemon/OTel
 * URLs. Every process (CLI, daemon, worker, vite) resolves from here so a multi-worktree run can move
 * all of them together. Each field reads its env var, falling back to the historical single-instance
 * default — so `awb up` with no overrides behaves exactly as before.
 */
export interface RuntimeConfig {
  daemonPort: number;
  temporalPort: number;
  uiPort: number;
  otelOtlpPort: number;
  otelUiPort: number;
  otelContainerName: string;
  taskQueue: string;
  /** `host:port` the Temporal client + worker connect to. */
  temporalAddress: string;
  /** Base URL the CLI + worker reach the daemon at. */
  daemonUrl: string;
  /** OTLP/HTTP endpoint the worker + daemon export spans to. */
  otelEndpoint: string;
}

export const DEFAULT_DAEMON_PORT = 4417;
export const DEFAULT_TEMPORAL_PORT = 7233;
export const DEFAULT_UI_PORT = 5317;
export const DEFAULT_OTEL_OTLP_PORT = 4318;
export const DEFAULT_OTEL_UI_PORT = 3000;
export const DEFAULT_OTEL_CONTAINER = 'awb-otel-lgtm';
export const DEFAULT_TASK_QUEUE = 'awb-task-queue';

function envPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`${name} must be an integer port in 1–65535, got "${raw}"`);
  }
  return n;
}

function envString(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw;
}

export function resolveRuntimeConfig(): RuntimeConfig {
  const daemonPort = envPort('AWB_DAEMON_PORT', DEFAULT_DAEMON_PORT);
  const temporalPort = envPort('AWB_TEMPORAL_PORT', DEFAULT_TEMPORAL_PORT);
  const otelOtlpPort = envPort('AWB_OTEL_OTLP_PORT', DEFAULT_OTEL_OTLP_PORT);
  return {
    daemonPort,
    temporalPort,
    uiPort: envPort('AWB_UI_PORT', DEFAULT_UI_PORT),
    otelOtlpPort,
    otelUiPort: envPort('AWB_OTEL_UI_PORT', DEFAULT_OTEL_UI_PORT),
    otelContainerName: envString('AWB_OTEL_CONTAINER', DEFAULT_OTEL_CONTAINER),
    taskQueue: envString('AWB_TASK_QUEUE', DEFAULT_TASK_QUEUE),
    // Derive URLs from the resolved ports unless explicitly overridden, so setting only a port moves
    // the URL with it (the common case) while an explicit URL still wins (e.g. a remote Temporal).
    temporalAddress: envString('AWB_TEMPORAL_ADDRESS', `127.0.0.1:${temporalPort}`),
    daemonUrl: envString('AWB_DAEMON_URL', `http://127.0.0.1:${daemonPort}`),
    otelEndpoint: envString('OTEL_EXPORTER_OTLP_ENDPOINT', `http://127.0.0.1:${otelOtlpPort}`),
  };
}

/**
 * A short, stable, filesystem/DNS-safe tag derived from a checkout's identity (its workspace root
 * path). Deterministic per root and distinct across roots, so two worktrees derive different tags
 * without coordination.
 */
export function deriveIsolationTag(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, 8);
}

/**
 * The env overrides that isolate one stack, derived from `seed` (the checkout's workspace root).
 * Ports come from a deterministic 8-wide block offset off the defaults by the tag, keeping each
 * stack's ports contiguous and collision-resistant across worktrees; the queue + OTel container +
 * data dir get a `-<tag>` suffix. Returns only the vars that are NOT already set, so an explicit
 * env override the user passed always wins over the derived value.
 */
export function isolatedOverrides(seed: string, dataDirBase: string): Record<string, string> {
  const tag = deriveIsolationTag(seed);
  // A per-stack offset in [1, 200], multiplied by a 10-port stride so blocks never overlap and stay
  // well below the ephemeral range. Deterministic from the tag.
  const offset = (parseInt(tag, 16) % 200) + 1;
  const stride = 10;
  const base = offset * stride;
  const derived: Record<string, string> = {
    AWB_DAEMON_PORT: String(DEFAULT_DAEMON_PORT + base),
    AWB_TEMPORAL_PORT: String(DEFAULT_TEMPORAL_PORT + base),
    AWB_UI_PORT: String(DEFAULT_UI_PORT + base),
    AWB_OTEL_OTLP_PORT: String(DEFAULT_OTEL_OTLP_PORT + base),
    AWB_OTEL_UI_PORT: String(DEFAULT_OTEL_UI_PORT + base),
    AWB_OTEL_CONTAINER: `${DEFAULT_OTEL_CONTAINER}-${tag}`,
    AWB_TASK_QUEUE: `${DEFAULT_TASK_QUEUE}-${tag}`,
    AWB_DATA_DIR: `${dataDirBase}-${tag}`,
  };
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(derived)) {
    if (process.env[key] === undefined || process.env[key]!.trim() === '') out[key] = value;
  }
  return out;
}
