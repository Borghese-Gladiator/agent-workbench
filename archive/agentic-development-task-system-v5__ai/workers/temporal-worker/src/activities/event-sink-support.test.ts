import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileEventSink } from './event-sink-support.js';

describe('createFileEventSink', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'awb-event-sink-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists message, tool, and usage events as newline-delimited JSON', () => {
    const { sink, logPath } = createFileEventSink({
      artifactsDir: dir,
      taskId: 't1',
      role: 'planner',
      phaseAttempt: 'plan-1',
    });

    sink({ type: 'message', text: 'here is the plan' });
    sink({ type: 'tool-started', tool: 'Read', inputSummary: '{"file":"x"}' });
    sink({ type: 'tool-completed', tool: 'tool_123', resultSummary: 'ok' });
    sink({
      type: 'usage',
      usage: { provider: 'anthropic', model: 'claude', inputTokens: 10, outputTokens: 5 },
    });

    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(4);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0].event).toMatchObject({ type: 'message', text: 'here is the plan' });
    expect(parsed[1].event).toMatchObject({ type: 'tool-started', tool: 'Read' });
    expect(parsed[3].event.usage.inputTokens).toBe(10);
    expect(parsed.every((p) => p.role === 'planner')).toBe(true);
  });

  it('truncates very large message text', () => {
    const { sink, logPath } = createFileEventSink({
      artifactsDir: dir,
      taskId: 't1',
      role: 'builder',
      phaseAttempt: 'implement-1',
    });
    sink({ type: 'message', text: 'x'.repeat(10_000) });
    const parsed = JSON.parse(readFileSync(logPath, 'utf8').trim());
    expect(parsed.event.text).toContain('…[+');
    expect(parsed.event.text.length).toBeLessThan(10_000);
  });
});
