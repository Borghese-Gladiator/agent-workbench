import { describe, expect, it } from 'vitest';
import { normalizeAgentEvent } from './event-normalization.js';
import type { AgentEvent } from '@awb/domain';

const base = { runId: 'run-1', sequence: 0, phase: 'implement' as const, phaseAttemptId: 'pa-1', role: 'builder' as const };

describe('normalizeAgentEvent', () => {
  it('maps producer from role', () => {
    const event: AgentEvent = { type: 'intent', summary: 'about to edit a file' };
    const result = normalizeAgentEvent({ ...base, event });
    expect(result.producer).toBe('builder');
  });

  it('maps qa-executor role to "qa" producer', () => {
    const event: AgentEvent = { type: 'message', text: 'hello' };
    const result = normalizeAgentEvent({ ...base, role: 'qa-executor', event });
    expect(result.producer).toBe('qa');
  });

  it('maps adversarial-reviewer role to "reviewer" producer', () => {
    const event: AgentEvent = { type: 'message', text: 'hello' };
    const result = normalizeAgentEvent({ ...base, role: 'adversarial-reviewer', event });
    expect(result.producer).toBe('reviewer');
  });

  it('summarizes a file-changed event with the path', () => {
    const event: AgentEvent = { type: 'file-changed', path: 'src/foo.ts' };
    const result = normalizeAgentEvent({ ...base, event });
    expect(result.summary).toContain('src/foo.ts');
    expect(result.type).toBe('file-changed');
  });

  it('summarizes a command-completed event with exit code', () => {
    const event: AgentEvent = { type: 'command-completed', commandId: 'cmd-1', exitCode: 1 };
    const result = normalizeAgentEvent({ ...base, event });
    expect(result.summary).toContain('1');
    expect(result.type).toBe('command-completed');
  });

  it('attaches the finding as payloadJson for a finding event, and only for that event type', () => {
    const finding = { id: 'f1', severity: 'high', category: 'correctness', description: 'bug' };
    const event: AgentEvent = { type: 'finding', finding };
    const result = normalizeAgentEvent({ ...base, event });
    expect(result.payloadJson).toBe(finding);
    expect(result.type).toBe('finding-created');

    const otherEvent: AgentEvent = { type: 'message', text: 'no payload here' };
    const otherResult = normalizeAgentEvent({ ...base, event: otherEvent });
    expect(otherResult.payloadJson).toBeUndefined();
  });

  it('maps a usage event to "usage-reported" and includes token counts in the summary', () => {
    const event: AgentEvent = {
      type: 'usage',
      usage: { provider: 'mock', model: 'mock-model', inputTokens: 500, outputTokens: 100 },
    };
    const result = normalizeAgentEvent({ ...base, event });
    expect(result.type).toBe('usage-reported');
    expect(result.summary).toContain('500');
    expect(result.summary).toContain('100');
  });

  it('preserves runId, sequence, phase, and phaseAttemptId from input', () => {
    const event: AgentEvent = { type: 'message', text: 'x' };
    const result = normalizeAgentEvent({ ...base, sequence: 7, event });
    expect(result.runId).toBe('run-1');
    expect(result.sequence).toBe(7);
    expect(result.phase).toBe('implement');
    expect(result.phaseAttemptId).toBe('pa-1');
  });
});
