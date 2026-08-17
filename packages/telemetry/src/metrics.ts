import { metrics, type Counter, type Histogram } from '@opentelemetry/api';

/**
 * The cross-run metric instruments motivated by run 5a513429: retry rate, phase-failure
 * rate, transport-drop frequency, and p95 phase duration — none of which the per-task on-read token
 * breakdown could answer. Instruments come from the global MeterProvider the NodeSDK installs; when
 * telemetry is disabled the API returns no-op instruments, so recording is always safe to call.
 *
 * Every metric carries the `run_id`/`task_id` bridge attributes so a metric spike links back
 * to the exact run's `semantic_events` and trace.
 */
const METER_NAME = 'awb.workbench';

export interface MetricAttributes {
  taskId?: string;
  runId?: string;
  phase?: string;
  outcome?: string;
  errorClass?: string;
  [key: string]: string | undefined;
}

let phaseFailures: Counter | undefined;
let attemptRetries: Counter | undefined;
let transportDrops: Counter | undefined;
let phaseDuration: Histogram | undefined;
let phaseStarts: Counter | undefined;
let repairFindings: Counter | undefined;

function meter() {
  return metrics.getMeter(METER_NAME);
}

/** Strips undefined values so exporters receive a clean attribute bag. */
function clean(attrs: MetricAttributes): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export function recordPhaseStarted(attrs: MetricAttributes): void {
  phaseStarts ??= meter().createCounter('awb.phase.started', { description: 'Phase attempts started' });
  phaseStarts.add(1, clean(attrs));
}

export function recordPhaseFailed(attrs: MetricAttributes): void {
  phaseFailures ??= meter().createCounter('awb.phase.failed', { description: 'Phase attempts that threw' });
  phaseFailures.add(1, clean(attrs));
}

export function recordAttemptRetryScheduled(attrs: MetricAttributes): void {
  attemptRetries ??= meter().createCounter('awb.attempt.retry_scheduled', {
    description: 'Activity retries scheduled after a transient failure',
  });
  attemptRetries.add(1, clean(attrs));
}

export function recordTransportDrop(attrs: MetricAttributes): void {
  transportDrops ??= meter().createCounter('awb.transport.drop', {
    description: 'Provider transport drops (resumable connection errors)',
  });
  transportDrops.add(1, clean(attrs));
}

export function recordPhaseDuration(durationMs: number, attrs: MetricAttributes): void {
  phaseDuration ??= meter().createHistogram('awb.phase.duration_ms', {
    description: 'Wall-clock duration of a phase attempt',
    unit: 'ms',
  });
  phaseDuration.record(durationMs, clean(attrs));
}

/**
 * A finding a code-fixable gate raised to re-prompt the next builder attempt (challenge review or
 * exercise/QA). Counts how often the loop bounces back to implement WITH actionable feedback —
 * distinct from `awb.phase.failed` (a thrown phase) and from a human gate; a rising rate flags a
 * runtime whose builder repeatedly needs correction. Attrs carry {phase, category, severity}.
 */
export function recordRepairFinding(attrs: MetricAttributes): void {
  repairFindings ??= meter().createCounter('awb.repair.findings', {
    description: 'Findings raised to re-prompt the builder on a code-fixable repair',
  });
  repairFindings.add(1, clean(attrs));
}
