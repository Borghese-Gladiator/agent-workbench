import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { trace, context } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import { withSpan, deriveRunTraceId } from './spans.js';

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

  it('exports attributes set on the span handle inside the body (run-completion pattern)', async () => {
    await withSpan('run.decay', { run_id: 'task-1-run', task_id: 'task-1' }, async (span) => {
      span.setAttributes({ 'awb.decay.diff_lines': 42, 'awb.decay.reviewed_ratio': 0.5 });
    });

    const span = exporter.getFinishedSpans()[0] as ReadableSpan;
    expect(span.name).toBe('run.decay');
    expect(span.attributes['awb.decay.diff_lines']).toBe(42);
    expect(span.attributes['awb.decay.reviewed_ratio']).toBe(0.5);
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

describe('withSpan (TASK-36: one trace per run, nested span tree)', () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;
  let contextManager: AsyncLocalStorageContextManager;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider();
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
    trace.setGlobalTracerProvider(provider);
    // Child spans nest via the active context across `await`; that propagation needs an async context
    // manager (the NodeSDK installs one in production — see init.ts). Register it here so the nesting
    // assertion tests the same wiring production runs under.
    contextManager = new AsyncLocalStorageContextManager();
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
  });

  afterEach(async () => {
    await provider.shutdown();
    trace.disable();
    contextManager.disable();
    context.disable();
  });

  it('derives a deterministic, non-zero 32-hex trace id from the run id', () => {
    const id = deriveRunTraceId('task-1-run');
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(id).not.toMatch(/^0+$/);
    expect(deriveRunTraceId('task-1-run')).toBe(id);
  });

  it('parents two phase spans of the same run to one trace id, and differs across runs', async () => {
    await withSpan('phase.plan', { run_id: 'task-1-run', task_id: 'task-1' }, async () => 0, {
      parentRunId: 'task-1-run',
    });
    await withSpan('phase.implement', { run_id: 'task-1-run', task_id: 'task-1' }, async () => 0, {
      parentRunId: 'task-1-run',
    });
    await withSpan('phase.plan', { run_id: 'task-2-run', task_id: 'task-2' }, async () => 0, {
      parentRunId: 'task-2-run',
    });

    const spans = exporter.getFinishedSpans() as ReadableSpan[];
    const traceIds = spans.map((s) => s.spanContext().traceId);
    // task-1's two phases share one trace; task-2's phase is a different trace.
    expect(traceIds.filter((t) => t === deriveRunTraceId('task-1-run'))).toHaveLength(2);
    expect(traceIds.filter((t) => t === deriveRunTraceId('task-2-run'))).toHaveLength(1);
    expect(deriveRunTraceId('task-2-run')).not.toBe(deriveRunTraceId('task-1-run'));
  });

  it('nests a child span (no parentRunId) under the parented phase span', async () => {
    await withSpan(
      'phase.implement',
      { run_id: 'task-1-run', task_id: 'task-1' },
      async () => {
        await withSpan('session.builder', { run_id: 'task-1-run', task_id: 'task-1' }, async () => 0);
      },
      { parentRunId: 'task-1-run' },
    );

    const spans = exporter.getFinishedSpans() as ReadableSpan[];
    const phase = spans.find((s) => s.name === 'phase.implement')!;
    const child = spans.find((s) => s.name === 'session.builder')!;

    // The child parents to the phase span, and both live in the run's deterministic trace.
    expect(child.parentSpanId).toBe(phase.spanContext().spanId);
    expect(child.spanContext().traceId).toBe(deriveRunTraceId('task-1-run'));
    expect(phase.spanContext().traceId).toBe(deriveRunTraceId('task-1-run'));
  });
});
