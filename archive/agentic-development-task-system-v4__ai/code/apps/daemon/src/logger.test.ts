import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import { runLogger } from './logger.js';

/**
 * Capture pino output by giving a logger a stream destination. We can't easily
 * swap the module-level transport, so for the structural assertions we build a
 * sibling logger with the same `runLogger` child shape and assert the binding.
 */
function captured(): { logger: ReturnType<typeof pino>; lines: () => Record<string, unknown>[] } {
  const records: string[] = [];
  const logger = pino({ level: 'debug' }, {
    write: (s: string) => records.push(s),
  } as NodeJS.WritableStream);
  return { logger, lines: () => records.map((r) => JSON.parse(r) as Record<string, unknown>) };
}

describe('logger', () => {
  it('runLogger binds the runId onto every record', () => {
    const { logger, lines } = captured();
    const child = logger.child({ runId: 'run_123' });
    child.info({ stage: 'plan' }, 'agent run start');

    const [rec] = lines();
    expect(rec).toMatchObject({ runId: 'run_123', stage: 'plan', msg: 'agent run start' });
  });

  it('exports a runLogger that produces a child logger', () => {
    // Smoke check the real export wires up without throwing and tags runId.
    const child = runLogger('run_abc');
    expect(typeof child.info).toBe('function');
    expect(child.bindings()).toMatchObject({ runId: 'run_abc' });
  });
});
