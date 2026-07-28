import { createHash } from 'node:crypto';
import {
  trace,
  context,
  TraceFlags,
  SpanStatusCode,
  type Span,
  type SpanContext,
  type Attributes,
} from '@opentelemetry/api';

/**
 * Opens a span around `fn`, tagging it with the caller's attributes (which MUST include the
 * `run_id`/`task_id` bridge ids per ADR-008 so a span links back to the run's `semantic_events`). On a
 * thrown error the span is marked ERROR and records the exception before rethrowing. When telemetry is
 * disabled the global tracer is a no-op, so this adds negligible overhead and never changes behavior.
 *
 * One trace per run (TASK-36): passing `parentRunId` parents the span to a deterministic run-level
 * `SpanContext` derived from the run id, so every phase of the same run lands in ONE trace (a nested
 * span tree) instead of each phase minting its own random trace id. Spans opened *without* `parentRunId`
 * from inside a parented span auto-nest under it via the active context (e.g. `session.builder` under
 * `phase.implement`).
 */
const TRACER_NAME = 'awb.workbench';

export interface SpanAttributes extends Attributes {
  'run_id'?: string;
  'task_id'?: string;
  'phase'?: string;
  'attempt_number'?: number;
}

export interface WithSpanOptions {
  /**
   * When set, the span parents to a deterministic run-level trace derived from this run id (TASK-36),
   * so all phases of a run share one trace id. Omit to inherit the current active context.
   */
  parentRunId?: string;
}

/** SHA-256 of the run id, first 16 bytes as 32 lowercase hex — a deterministic, valid OTel trace id. */
export function deriveRunTraceId(runId: string): string {
  const hex = createHash('sha256').update(runId).digest('hex').slice(0, 32);
  // A valid trace id must be non-zero; the hash is astronomically unlikely to be all-zero, but guard it.
  return /^0+$/.test(hex) ? `${'0'.repeat(31)}1` : hex;
}

/** Next 8 bytes of the same hash as 16 lowercase hex — the run-level span id (must be non-zero). */
function deriveRunSpanId(runId: string): string {
  const hex = createHash('sha256').update(runId).digest('hex').slice(32, 48);
  return /^0+$/.test(hex) ? `${'0'.repeat(15)}1` : hex;
}

/**
 * A non-recording, SAMPLED parent `SpanContext` for a run. `SAMPLED` is required or a
 * `SimpleSpanProcessor` drops the child spans (they never export). Reconstructed deterministically from
 * the run id so separate Temporal activity executions (each phase) reconstruct the same parent.
 */
export function runSpanContext(runId: string): SpanContext {
  return {
    traceId: deriveRunTraceId(runId),
    spanId: deriveRunSpanId(runId),
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  };
}

export async function withSpan<T>(
  name: string,
  attributes: SpanAttributes,
  fn: (span: Span) => Promise<T>,
  options?: WithSpanOptions,
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  const parentContext =
    options?.parentRunId !== undefined
      ? trace.setSpanContext(context.active(), runSpanContext(options.parentRunId))
      : context.active();
  return tracer.startActiveSpan(name, { attributes }, parentContext, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      if (err instanceof Error) span.recordException(err);
      throw err;
    } finally {
      span.end();
    }
  });
}
