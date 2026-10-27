/**
 * The daemon's one logger. Everything that wants to log imports from here — no
 * bare `console.log`.
 *
 * Output (dev, the primary mode):
 *   - pretty, colorized lines on STDOUT for live tailing, AND
 *   - raw newline-delimited JSON appended to data/logs/daemon-YYYY-MM-DD.log
 *     (one file per day; data/ is gitignored) so logs are durable and queryable
 *     after the fact — by time and by runId — long after scrollback is gone:
 *       # one run, in order:
 *       grep run_abc123 data/logs/daemon-*.log | jq -r '"\(.time) \(.msg)"'
 *       # a time window (epoch ms in .time):
 *       jq 'select(.time >= 1780970000000 and .time <= 1780970600000)' data/logs/daemon-*.log
 *
 * Cross-process tracing: an agent run touches three processes (daemon, the
 * spawned `claude` CLI, and the MCP gate server). `runLogger(runId)` binds the
 * runId onto every record so a single `grep <runId>` reconstructs a whole run.
 * The gate server (a dep-free .mjs) emits the same `runId` field on stderr, and
 * pino-http tags each HTTP request — including the gate's `/ask` relay — so both
 * sides of every boundary carry the id.
 *
 * Env:
 *   WORKBENCH_LOG_LEVEL  pino level (default `info`)
 *   WORKBENCH_DATA_DIR   moves the data/ root (and so the logs dir) — see paths.ts
 *   NODE_ENV=production  drops the pretty stream; emits raw JSON only
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { destination, type Level, type Logger, multistream, pino, type StreamEntry } from 'pino';
import pretty from 'pino-pretty';
import { LOGS_DIR } from './paths.js';

// Tests don't want request/run log spam in their output; default to silent
// under vitest unless the level is set explicitly. Silent also means we never
// create data/logs/ during a test run.
const inTest = Boolean(process.env.VITEST);
const level = (process.env.WORKBENCH_LOG_LEVEL || (inTest ? 'silent' : 'info')) as Level;
const usePretty = process.env.NODE_ENV !== 'production';

/** Today's daily log file path, e.g. data/logs/daemon-2026-06-09.log. */
function dailyLogPath(): string {
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  return join(LOGS_DIR, `daemon-${day}.log`);
}

function buildStreams(): StreamEntry[] {
  const streams: StreamEntry[] = [];
  // Live console view: pretty in dev, raw JSON to stdout in prod.
  streams.push({
    level,
    stream: usePretty
      ? pretty({ colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' })
      : process.stdout,
  });
  // Durable, queryable JSON file — skipped in tests (nothing to persist there).
  if (!inTest) {
    streams.push({ level, stream: destination({ dest: dailyLogPath(), sync: false }) });
  }
  return streams;
}

export const logger: Logger = pino({ level }, multistream(buildStreams()));

/** A child logger bound to an agent run id — the unit of cross-process tracing. */
export function runLogger(runId: string): Logger {
  return logger.child({ runId });
}
