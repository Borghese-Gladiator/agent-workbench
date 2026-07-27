/**
 * A tiny leveled, structured logger stamped with the run/task bridge ids (TASK-34 / ADR-008). It
 * replaces raw `console.log`/Temporal-SDK-logger stderr diagnostics with a single JSON line per record
 * carrying `run_id`/`task_id`, so a control-plane failure is queryable by the same ids that link to
 * `semantic_events` and OTel traces. Deliberately dependency-free (no OTel logs SDK): it writes to
 * stdout/stderr as structured JSON, which the collector's stdout scraper or the local `awb logs` view
 * both consume. Level is `AWB_LOG_LEVEL` (default `info`).
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogFields {
  runId?: string;
  taskId?: string;
  phase?: string;
  attemptNumber?: number;
  [key: string]: unknown;
}

function thresholdLevel(): LogLevel {
  const raw = process.env.AWB_LOG_LEVEL?.toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  return 'info';
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Returns a child logger whose fields are merged into every record (e.g. bind run_id/task_id once). */
  child(bound: LogFields): Logger;
}

function emit(service: string, level: LogLevel, message: string, bound: LogFields, fields?: LogFields): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[thresholdLevel()]) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    service,
    message,
    ...bound,
    ...fields,
  };
  const line = JSON.stringify(record);
  if (level === 'error' || level === 'warn') {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
}

export function createLogger(service: string, bound: LogFields = {}): Logger {
  return {
    debug: (message, fields) => emit(service, 'debug', message, bound, fields),
    info: (message, fields) => emit(service, 'info', message, bound, fields),
    warn: (message, fields) => emit(service, 'warn', message, bound, fields),
    error: (message, fields) => emit(service, 'error', message, bound, fields),
    child: (childBound) => createLogger(service, { ...bound, ...childBound }),
  };
}
