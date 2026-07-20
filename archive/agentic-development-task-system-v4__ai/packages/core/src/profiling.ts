import type { AgentRunEvent } from './agent-runs.js';
import type { Timestamp } from './entities.js';
import type { Stage } from './lifecycle.js';

/**
 * Profiling metrics derived ENTIRELY from the `AgentRunEvent` stream the daemon
 * already persists — no new instrumentation for v1. These are the "6 of 11"
 * metrics not covered by the per-run `TokenUsage` (which lives on `AgentRun`):
 *
 *   1. tool execution latency        (toolLatency)
 *   2. tool-call count + serialism   (toolCalls, batchingRatio)
 *   3. files read / cmds / tests run  (activity)
 *   4. tool-result bytes (PROXY)     (resultBytes — see caveat)
 *   5. repeated reads of a file       (repeatedReads, within & cross-stage)
 *   6. retry / permission waits       (waits)
 *
 * All functions are pure and duck-typed on the event shape so both core's
 * `AgentRunEvent` and the client's structural mirror satisfy them.
 *
 * KNOWN LIMITATIONS (see docs/profiling-metrics-spec.md):
 * - `tool_call` and `tool_result` have NO linking id; they pair by ADJACENCY
 *   (the next `tool_result` after a `tool_call`, by `seq`). Safe because the
 *   workbench runs tools serially within a turn. Unmatched calls are counted.
 * - `tool_result.summary` is a TRUNCATED summary, not the raw body, so
 *   `resultBytes` is a LOWER-BOUND proxy. True bytes need an adapter field.
 */

/** Minimal structural view of one streamed event (duck-typed). */
export interface ProfileEvent {
  seq: number;
  type: string;
  payload: unknown;
  createdAt: Timestamp;
  /**
   * Daemon receive time (parse time), vs `createdAt` (SQLite insert time). Their
   * divergence is the daemon-persist-delay signal `eventGaps` attributes. Null on
   * legacy rows that predate dual timestamps.
   */
  receivedAt?: Timestamp | null;
}

/**
 * Compile-time guarantee that `ProfileEvent` is a structural subset of the real
 * `AgentRunEvent` — so a persisted event always satisfies these functions, and
 * this mirror breaks the build if `AgentRunEvent` ever drops one of these fields.
 */
type _ProfileEventIsSubsetOfAgentRunEvent = AgentRunEvent extends ProfileEvent ? true : never;

/** A `tool_call` payload as emitted by the adapter. */
interface ToolCallPayload {
  name?: string;
  input?: Record<string, unknown>;
}
/** A `tool_result` payload as emitted by the adapter. */
interface ToolResultPayload {
  status?: string;
  summary?: string;
}
/** The terminal `result` payload (carries permission denials). */
interface ResultPayload {
  denials?: string[];
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
function toMs(ts: Timestamp | null | undefined): number | null {
  if (!ts) return null;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

/** Test-runner signatures used to classify a Bash command as "running tests". */
const TEST_COMMAND_RE =
  /\b(pytest|vitest|jest|go test|cargo test|npm (run )?test|pnpm (run )?test|yarn test|turbo (run )?test|rspec|phpunit|mvn test|gradle test)\b/;

/** Path-bearing arg keys, in priority order, across the standard tools. */
const PATH_KEYS = ['file_path', 'path', 'notebook_path'] as const;

/** Pull the path a tool call targets, if any (Read/Edit/Write/NotebookEdit). */
function toolPath(input: Record<string, unknown>): string | null {
  for (const k of PATH_KEYS) {
    const v = input[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/**
 * A `tool_call` paired (by adjacency) with its `tool_result`. `result` is null
 * when the call had no following result before the next call or end of stream.
 */
export interface PairedCall {
  seq: number;
  name: string;
  input: Record<string, unknown>;
  /** ms between the call event and its result event; null if unmatched. */
  latencyMs: number | null;
  /** 'ok' | 'error' | null (unmatched). */
  status: string | null;
  /** Length of the (truncated) result summary string; 0 if none. */
  resultChars: number;
}

/**
 * Walk the event stream and pair each `tool_call` with the next `tool_result`
 * (by `seq` order). The pairing is positional: the workbench executes tools
 * serially, so the first result after a call IS that call's result. A call with
 * another `tool_call` (or end of stream) before any result is left unmatched.
 */
export function pairToolCalls(events: ProfileEvent[]): PairedCall[] {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const pairs: PairedCall[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const ev = ordered[i];
    if (ev?.type !== 'tool_call') continue;
    const p = asObj(ev.payload) as ToolCallPayload;
    const callMs = toMs(ev.createdAt);
    // Find the next tool_result before the next tool_call.
    let result: ProfileEvent | null = null;
    for (let j = i + 1; j < ordered.length; j++) {
      const nxt = ordered[j];
      if (!nxt) break;
      if (nxt.type === 'tool_call') break;
      if (nxt.type === 'tool_result') {
        result = nxt;
        break;
      }
    }
    const rp = result ? (asObj(result.payload) as ToolResultPayload) : null;
    const resMs = result ? toMs(result.createdAt) : null;
    pairs.push({
      seq: ev.seq,
      name: typeof p.name === 'string' ? p.name : '?',
      input: asObj(p.input),
      latencyMs: callMs != null && resMs != null ? Math.max(0, resMs - callMs) : null,
      status: rp ? (typeof rp.status === 'string' ? rp.status : null) : null,
      resultChars: rp && typeof rp.summary === 'string' ? rp.summary.length : 0,
    });
  }
  return pairs;
}

/** Min/median/max/total over a numeric sample (median is the lower-middle). */
export interface LatencyStats {
  count: number;
  totalMs: number;
  minMs: number | null;
  medianMs: number | null;
  maxMs: number | null;
}
function statsOf(samples: number[]): LatencyStats {
  if (samples.length === 0) {
    return { count: 0, totalMs: 0, minMs: null, medianMs: null, maxMs: null };
  }
  const s = [...samples].sort((a, b) => a - b);
  const total = s.reduce((acc, n) => acc + n, 0);
  const mid = Math.floor((s.length - 1) / 2);
  return {
    count: s.length,
    totalMs: total,
    minMs: s[0] ?? null,
    medianMs: s[mid] ?? null,
    maxMs: s[s.length - 1] ?? null,
  };
}

/** Metric 1: tool execution latency, overall and per tool name. */
export interface ToolLatency {
  overall: LatencyStats;
  byTool: Record<string, LatencyStats>;
  /** Slowest individual calls (name + ms), descending, capped at `topN`. */
  slowest: Array<{ name: string; latencyMs: number; seq: number }>;
  /** Calls with no matched result (latency unknowable). */
  unmatched: number;
}
export function toolLatency(pairs: PairedCall[], topN = 5): ToolLatency {
  const matched = pairs.filter((p) => p.latencyMs != null);
  const byToolSamples = new Map<string, number[]>();
  for (const p of matched) {
    const arr = byToolSamples.get(p.name) ?? [];
    arr.push(p.latencyMs as number);
    byToolSamples.set(p.name, arr);
  }
  const byTool: Record<string, LatencyStats> = {};
  for (const [name, arr] of byToolSamples) byTool[name] = statsOf(arr);
  const slowest = matched
    .map((p) => ({ name: p.name, latencyMs: p.latencyMs as number, seq: p.seq }))
    .sort((a, b) => b.latencyMs - a.latencyMs)
    .slice(0, topN);
  return {
    overall: statsOf(matched.map((p) => p.latencyMs as number)),
    byTool,
    slowest,
    unmatched: pairs.filter((p) => p.latencyMs == null).length,
  };
}

/**
 * Metric 2: tool-call volume + serialism. `batches` counts groups of tool calls
 * issued without an intervening `assistant_text` (a low batches:calls ratio means
 * the agent is too serial — one tool per model turn).
 */
export interface ToolVolume {
  toolCalls: number;
  batches: number;
  /** batches / toolCalls; 1.0 = fully serial, lower = more parallel. null if no calls. */
  batchingRatio: number | null;
}
export function toolVolume(events: ProfileEvent[]): ToolVolume {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  let toolCalls = 0;
  let batches = 0;
  let inBatch = false;
  for (const ev of ordered) {
    if (ev.type === 'tool_call') {
      toolCalls++;
      if (!inBatch) {
        batches++;
        inBatch = true;
      }
    } else if (ev.type === 'assistant_text') {
      // A model utterance closes the current batch; the next call starts a new one.
      inBatch = false;
    }
  }
  return {
    toolCalls,
    batches,
    batchingRatio: toolCalls > 0 ? batches / toolCalls : null,
  };
}

/** Metric 3: classified activity counts (work vs. survey). */
export interface Activity {
  filesRead: number;
  distinctFilesRead: number;
  commandsRun: number;
  testsRun: number;
  filesWritten: number;
  distinctFilesWritten: number;
  /** writes / total calls — low = mostly survey, high = mostly work. null if no calls. */
  workRatio: number | null;
}
export function activity(pairs: PairedCall[]): Activity {
  const readPaths: string[] = [];
  const writePaths: string[] = [];
  let commandsRun = 0;
  let testsRun = 0;
  let filesWritten = 0;
  for (const p of pairs) {
    if (p.name === 'Read') {
      const path = toolPath(p.input);
      if (path) readPaths.push(path);
    } else if (p.name === 'Write' || p.name === 'Edit' || p.name === 'NotebookEdit') {
      filesWritten++;
      const path = toolPath(p.input);
      if (path) writePaths.push(path);
    } else if (p.name === 'Bash') {
      commandsRun++;
      const cmd = p.input.command;
      if (typeof cmd === 'string' && TEST_COMMAND_RE.test(cmd)) testsRun++;
    }
  }
  const total = pairs.length;
  return {
    filesRead: readPaths.length,
    distinctFilesRead: new Set(readPaths).size,
    commandsRun,
    testsRun,
    filesWritten,
    distinctFilesWritten: new Set(writePaths).size,
    workRatio: total > 0 ? filesWritten / total : null,
  };
}

/** Metric 4: tool-result size proxy (summary chars — LOWER BOUND, see caveat). */
export interface ResultBytes {
  totalChars: number;
  maxChars: number;
  /** The single largest result (tool name + chars), for "huge logs" triage. */
  largest: { name: string; chars: number; seq: number } | null;
  /** True when measured from truncated summaries (always true in v1). */
  isProxy: boolean;
}
export function resultBytes(pairs: PairedCall[]): ResultBytes {
  let totalChars = 0;
  let largest: ResultBytes['largest'] = null;
  for (const p of pairs) {
    totalChars += p.resultChars;
    if (!largest || p.resultChars > largest.chars) {
      largest = { name: p.name, chars: p.resultChars, seq: p.seq };
    }
  }
  return {
    totalChars,
    maxChars: largest?.chars ?? 0,
    largest: largest && largest.chars > 0 ? largest : null,
    isProxy: true,
  };
}

/** Metric 5 (within-run): files Read more than once in a single run. */
export interface RepeatedRead {
  path: string;
  times: number;
}
export function repeatedReadsInRun(pairs: PairedCall[]): RepeatedRead[] {
  const counts = new Map<string, number>();
  for (const p of pairs) {
    if (p.name !== 'Read') continue;
    const path = toolPath(p.input);
    if (!path) continue;
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, n]) => n > 1)
    .map(([path, times]) => ({ path, times }))
    .sort((a, b) => b.times - a.times);
}

/** Metric 6: retry + permission-wait signals. */
export interface Waits {
  /** Tool names permission-denied (from the terminal `result.denials`). */
  permissionDenials: string[];
  /** tool_result events with status 'error' (denied/blocked/failed calls). */
  erroredCalls: number;
  /** Consecutive identical (name+input) tool calls — the agent re-issuing. */
  retries: number;
}
export function waits(events: ProfileEvent[], pairs: PairedCall[]): Waits {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  // Denials come from the terminal `result` event.
  const denials: string[] = [];
  for (const ev of ordered) {
    if (ev.type === 'result') {
      const d = (asObj(ev.payload) as ResultPayload).denials;
      if (Array.isArray(d)) for (const name of d) if (typeof name === 'string') denials.push(name);
    }
  }
  const erroredCalls = pairs.filter((p) => p.status === 'error').length;
  // Retries: adjacent pairs with identical name + serialized input.
  let retries = 0;
  for (let i = 1; i < pairs.length; i++) {
    const a = pairs[i - 1];
    const b = pairs[i];
    if (!a || !b) continue;
    if (a.name === b.name && JSON.stringify(a.input) === JSON.stringify(b.input)) retries++;
  }
  return { permissionDenials: denials, erroredCalls, retries };
}

/** A `turn` event payload as emitted by the adapter (per-turn TTFT + usage). */
interface TurnPayload {
  index?: number;
  ttftMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
}

/** One model turn's first-token latency and request token usage. */
export interface TurnRow {
  index: number;
  ttftMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
}

/**
 * Per-turn TTFT metrics — the instrumentation that attributes the long silent
 * gaps. `rows` is one entry per model turn; `ttft` aggregates the per-turn
 * first-token latencies; `slowest` is the worst turn. Correlate `ttftMs` against
 * `inputTokens` (H1: prefill), the cache-read ratio (H2: caching), or
 * `outputTokens` (H3: generation) — or note ttft ≈ constant (H4: queueing).
 */
export interface TurnStats {
  rows: TurnRow[];
  ttft: LatencyStats;
  slowest: TurnRow | null;
}
export function turnStats(events: ProfileEvent[]): TurnStats {
  const rows: TurnRow[] = [];
  for (const ev of [...events].sort((a, b) => a.seq - b.seq)) {
    if (ev.type !== 'turn') continue;
    const p = asObj(ev.payload) as TurnPayload;
    rows.push({
      index: typeof p.index === 'number' ? p.index : rows.length + 1,
      ttftMs: typeof p.ttftMs === 'number' ? p.ttftMs : null,
      inputTokens: typeof p.inputTokens === 'number' ? p.inputTokens : null,
      outputTokens: typeof p.outputTokens === 'number' ? p.outputTokens : null,
      cacheReadInputTokens:
        typeof p.cacheReadInputTokens === 'number' ? p.cacheReadInputTokens : null,
      cacheCreationInputTokens:
        typeof p.cacheCreationInputTokens === 'number' ? p.cacheCreationInputTokens : null,
    });
  }
  const ttftSamples = rows.map((r) => r.ttftMs).filter((n): n is number => typeof n === 'number');
  const slowest = rows.reduce<TurnRow | null>((worst, r) => {
    if (r.ttftMs == null) return worst;
    if (!worst || worst.ttftMs == null || r.ttftMs > worst.ttftMs) return r;
    return worst;
  }, null);
  return { rows, ttft: statsOf(ttftSamples), slowest };
}

/**
 * One gap between two consecutive streamed events. `modelMs` is the wall-clock
 * the stream was idle (measured between the events' `receivedAt`s — the time the
 * daemon was waiting on the adapter/model/tool, NOT on itself). `persistMs` is
 * how long the *later* event sat between daemon-receive and SQLite-insert
 * (`createdAt - receivedAt`) — a non-trivial value here is a daemon-side stall
 * (e.g. an event-loop-blocking sync spawn), distinct from model latency.
 */
export interface EventGap {
  /** seq of the later event in the pair (the gap is "time until this event"). */
  seq: number;
  /** `<prevType>→<type>`, e.g. `tool_result→assistant_text`. */
  boundary: string;
  /** Idle ms between the two events' receive times; null if either lacks `receivedAt`. */
  modelMs: number | null;
  /** ms the later event spent in daemon-persist (`createdAt - receivedAt`); null if no `receivedAt`. */
  persistMs: number | null;
}

/**
 * Inter-event gaps across the stream — the stalls that aren't a tool call
 * (model thinking between turns, permission waits, daemon hiccups). Splitting
 * `modelGap` (idle waiting on the adapter) from `persistGap` (our own
 * persist delay) makes a daemon-side regression VISIBLE rather than inferred:
 * a spike in `persistGap` is us blocking the event loop, a spike in `modelGap`
 * is the model/tool. `slowest` is the top-N largest model gaps.
 */
export interface EventGaps {
  gaps: EventGap[];
  modelGap: LatencyStats;
  persistGap: LatencyStats;
  slowest: EventGap[];
}
export function eventGaps(events: ProfileEvent[], topN = 5): EventGaps {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const gaps: EventGap[] = [];
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1];
    const cur = ordered[i];
    if (!prev || !cur) continue;
    // Prefer receive time (isolates model/transit wait from our persist delay);
    // fall back to insert time so legacy rows without `receivedAt` still produce
    // a (coarser) gap rather than a null.
    const prevRecv = toMs(prev.receivedAt) ?? toMs(prev.createdAt);
    const curRecv = toMs(cur.receivedAt) ?? toMs(cur.createdAt);
    const curRecvOnly = toMs(cur.receivedAt);
    const curInsert = toMs(cur.createdAt);
    gaps.push({
      seq: cur.seq,
      boundary: `${prev.type}→${cur.type}`,
      modelMs: prevRecv != null && curRecv != null ? Math.max(0, curRecv - prevRecv) : null,
      persistMs:
        curRecvOnly != null && curInsert != null ? Math.max(0, curInsert - curRecvOnly) : null,
    });
  }
  const modelSamples = gaps.map((g) => g.modelMs).filter((n): n is number => typeof n === 'number');
  const persistSamples = gaps
    .map((g) => g.persistMs)
    .filter((n): n is number => typeof n === 'number');
  const slowest = gaps
    .filter((g): g is EventGap & { modelMs: number } => typeof g.modelMs === 'number')
    .sort((a, b) => b.modelMs - a.modelMs)
    .slice(0, topN);
  return {
    gaps,
    modelGap: statsOf(modelSamples),
    persistGap: statsOf(persistSamples),
    slowest,
  };
}

/** The full per-stage profile: one agent run's derived metrics. */
export interface StageProfile {
  stage: Stage | string;
  toolLatency: ToolLatency;
  volume: ToolVolume;
  activity: Activity;
  resultBytes: ResultBytes;
  repeatedReads: RepeatedRead[];
  waits: Waits;
  turns: TurnStats;
  gaps: EventGaps;
}

/** Compute every metric for one agent run from its event stream. */
export function profileStage(stage: Stage | string, events: ProfileEvent[]): StageProfile {
  const pairs = pairToolCalls(events);
  return {
    stage,
    toolLatency: toolLatency(pairs),
    volume: toolVolume(events),
    activity: activity(pairs),
    resultBytes: resultBytes(pairs),
    repeatedReads: repeatedReadsInRun(pairs),
    waits: waits(events, pairs),
    turns: turnStats(events),
    gaps: eventGaps(events),
  };
}

/**
 * Metric 5 (cross-stage): files an earlier stage already Read that a later stage
 * Reads again — the "missing working memory" signal. Each input is one stage's
 * ordered Read paths; `paths` should already be normalized (worktree-absolute →
 * repo-relative) by the caller so the same file matches across stages/worktrees.
 */
export interface CrossStageRepeat {
  path: string;
  /** Stages that Read this path, in order — length > 1 means a repeat. */
  stages: string[];
}
export function crossStageRepeatedReads(
  perStage: Array<{ stage: Stage | string; readPaths: string[] }>,
): CrossStageRepeat[] {
  const byPath = new Map<string, string[]>();
  for (const { stage, readPaths } of perStage) {
    const seenThisStage = new Set<string>();
    for (const path of readPaths) {
      if (seenThisStage.has(path)) continue; // count a stage once per path
      seenThisStage.add(path);
      const arr = byPath.get(path) ?? [];
      arr.push(String(stage));
      byPath.set(path, arr);
    }
  }
  return [...byPath.entries()]
    .filter(([, stages]) => stages.length > 1)
    .map(([path, stages]) => ({ path, stages }))
    .sort((a, b) => b.stages.length - a.stages.length);
}

/** Read paths from one run's events — helper for assembling cross-stage input. */
export function readPathsOf(events: ProfileEvent[]): string[] {
  const paths: string[] = [];
  for (const p of pairToolCalls(events)) {
    if (p.name !== 'Read') continue;
    const path = toolPath(p.input);
    if (path) paths.push(path);
  }
  return paths;
}
