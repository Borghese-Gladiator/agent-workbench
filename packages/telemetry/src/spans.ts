import { trace, SpanStatusCode, type Span, type Attributes } from '@opentelemetry/api';

/**
 * Opens a span around `fn`, tagging it with the caller's attributes (which MUST include the
 * `run_id`/`task_id` bridge ids per ADR-008 so a span links back to the run's `semantic_events`). On a
 * thrown error the span is marked ERROR and records the exception before rethrowing. When telemetry is
 * disabled the global tracer is a no-op, so this adds negligible overhead and never changes behavior.
 */
const TRACER_NAME = 'awb.workbench';

export interface SpanAttributes extends Attributes {
  'run_id'?: string;
  'task_id'?: string;
  'phase'?: string;
  'attempt_number'?: number;
}

export async function withSpan<T>(name: string, attributes: SpanAttributes, fn: (span: Span) => Promise<T>): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
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
