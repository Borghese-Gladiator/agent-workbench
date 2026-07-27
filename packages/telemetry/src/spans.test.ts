import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import { withSpan } from './spans.js';

describe('withSpan (TASK-34: spans carry the run_id/task_id bridge)', () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider();
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
    trace.setGlobalTracerProvider(provider);
  });

  afterEach(async () => {
    await provider.shutdown();
    trace.disable();
  });

  it('records a span tagged with run_id and task_id and returns the wrapped value', async () => {
    const result = await withSpan(
      'phase.verify',
      { run_id: 'task-1-run', task_id: 'task-1', phase: 'verify' },
      async () => 'ok',
    );
    expect(result).toBe('ok');

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0] as ReadableSpan;
    expect(span.name).toBe('phase.verify');
    expect(span.attributes['run_id']).toBe('task-1-run');
    expect(span.attributes['task_id']).toBe('task-1');
  });

  it('marks the span as an error and rethrows when the body throws', async () => {
    await expect(
      withSpan('phase.implement', { run_id: 'task-1-run', task_id: 'task-1' }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const span = exporter.getFinishedSpans()[0] as ReadableSpan;
    // SpanStatusCode.ERROR === 2
    expect(span.status.code).toBe(2);
    expect(span.events.some((e) => e.name === 'exception')).toBe(true);
  });
});
