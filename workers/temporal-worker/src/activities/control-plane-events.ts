import { randomUUID } from 'node:crypto';
import type { TaskPhase, SemanticEvent, EventType, Finding } from '@awb/domain';
import { runIdForTask } from '@awb/database';
import {
  recordPhaseStarted,
  recordPhaseFailed,
  recordAttemptRetryScheduled,
  recordTransportDrop,
  recordPhaseDuration,
  recordRepairFinding,
} from '@awb/telemetry';
import type { DaemonClient } from '../daemon-client.js';

/**
 * Emits CONTROL-PLANE lifecycle events: a phase starting/failing, a retry being scheduled, a
 * transport drop, a session started/resumed. Distinct from the agent-produced stream (durable-event-
 * sink.ts) — these are produced by the workbench itself, so they carry `producer: 'workbench'`. They
 * land in `semantic_events` (via the same `POST /internal/events` single-writer path, so the dashboard
 * + catch-up route get them for free) AND drive the cross-run OTel metrics. Both are best-effort: a
 * dropped event or a telemetry hiccup must NEVER fail the phase (telemetry is not load-bearing).
 */
export interface ControlPlaneEmitterInput {
  taskId: string;
  phase: TaskPhase;
  attemptNumber: number;
  daemon?: DaemonClient;
}

export interface ControlPlaneEmitter {
  phaseStarted(fields: { cwd?: string; resumeKey?: string }): Promise<void>;
  phaseFailed(fields: { errorClass: string; message: string; resumable: boolean; retryScheduled: boolean }): Promise<void>;
  transportError(fields: { message: string }): Promise<void>;
  sessionStarted(fields: { role: string; cwd: string; resumeKey?: string }): Promise<void>;
  sessionResumed(fields: { role: string; cwd: string; resumeKey: string }): Promise<void>;
  phaseDuration(durationMs: number, outcome: string): void;
  /**
   * A code-fixable gate raised these findings to re-prompt the next builder attempt (challenge
   * review or exercise/QA). Emits one `finding-created` event per finding + an `awb.repair.findings`
   * metric, making the repair loop-back visible in the durable stream/dashboard and cross-run
   * metrics instead of an undifferentiated implement re-attempt. Best-effort.
   */
  repairFindingsRaised(findings: Finding[]): Promise<void>;
}

export function createControlPlaneEmitter(input: ControlPlaneEmitterInput): ControlPlaneEmitter {
  const runId = runIdForTask(input.taskId);
  const phaseAttemptId = `${input.taskId}-${input.phase}-${input.attemptNumber}`;
  const metricAttrs = { taskId: input.taskId, runId, phase: input.phase };

  async function post(type: EventType, summary: string, payload: Record<string, unknown>): Promise<void> {
    if (!input.daemon) return; // mock runtime: no daemon, nothing to persist
    const event: SemanticEvent = {
      id: randomUUID(),
      runId,
      sequence: 0, // daemon assigns the authoritative per-run sequence on write
      occurredAt: new Date().toISOString(),
      phase: input.phase,
      phaseAttemptId,
      producer: 'workbench',
      type,
      summary,
      payloadJson: { attemptNumber: input.attemptNumber, ...payload },
    };
    try {
      await input.daemon.postEvent(event);
    } catch {
      // best-effort: a dropped control-plane event must never fail the phase.
    }
  }

  return {
    async phaseStarted(fields) {
      try {
        recordPhaseStarted(metricAttrs);
      } catch {
        /* telemetry is best-effort */
      }
      await post('phase-started', `phase ${input.phase} started (attempt ${input.attemptNumber})`, {
        cwd: fields.cwd,
        resumeKey: fields.resumeKey,
      });
    },
    async phaseFailed(fields) {
      try {
        recordPhaseFailed({ ...metricAttrs, errorClass: fields.errorClass });
        if (fields.retryScheduled) recordAttemptRetryScheduled(metricAttrs);
      } catch {
        /* telemetry is best-effort */
      }
      await post('phase-failed', `phase ${input.phase} failed: ${fields.message}`, {
        errorClass: fields.errorClass,
        resumable: fields.resumable,
      });
      if (fields.retryScheduled) {
        await post('attempt-retry-scheduled', `retry scheduled for ${input.phase} after ${fields.errorClass}`, {
          errorClass: fields.errorClass,
        });
      }
    },
    async transportError(fields) {
      try {
        recordTransportDrop(metricAttrs);
      } catch {
        /* telemetry is best-effort */
      }
      await post('transport-error', `transport drop in ${input.phase}: ${fields.message}`, { message: fields.message });
    },
    async sessionStarted(fields) {
      await post('session-started', `${fields.role} session started in ${input.phase}`, {
        role: fields.role,
        cwd: fields.cwd,
        resumeKey: fields.resumeKey,
      });
    },
    async sessionResumed(fields) {
      await post('session-resumed', `${fields.role} session resumed in ${input.phase}`, {
        role: fields.role,
        cwd: fields.cwd,
        resumeKey: fields.resumeKey,
      });
    },
    phaseDuration(durationMs, outcome) {
      try {
        recordPhaseDuration(durationMs, { ...metricAttrs, outcome });
      } catch {
        /* telemetry is best-effort */
      }
    },
    async repairFindingsRaised(findings) {
      for (const f of findings) {
        try {
          recordRepairFinding({ ...metricAttrs, category: f.category, severity: f.severity });
        } catch {
          /* telemetry is best-effort */
        }
        const where = f.path ? ` (${f.path}${f.line !== undefined ? `:${f.line}` : ''})` : '';
        await post('finding-created', `[repair] ${f.category}/${f.severity}: ${f.description}${where}`, {
          findingId: f.id,
          category: f.category,
          severity: f.severity,
          path: f.path,
          line: f.line,
          claimIds: f.claimIds,
        });
      }
    },
  };
}
