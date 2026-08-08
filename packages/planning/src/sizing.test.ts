import { describe, expect, it } from 'vitest';
import { sizingInstruction, parseSizingOutput, SIZE_REASON_CODES } from './sizing.js';

describe('sizingInstruction (TASK-51)', () => {
  it('embeds the task prompt', () => {
    expect(sizingInstruction({ prompt: 'migrate auth to OAuth' })).toContain('migrate auth to OAuth');
  });

  it('teaches the S/M/L rubric and the anti-length/anti-file-count rules', () => {
    const instr = sizingInstruction({ prompt: 'x' });
    expect(instr).toContain('S — small');
    expect(instr).toContain('M — medium');
    expect(instr).toContain('L — large');
    expect(instr).toContain('Do NOT use prompt length');
    expect(instr).toContain('File or package count is evidence, not a rule');
  });

  it('lists the constrained reason codes and asks for JSON', () => {
    const instr = sizingInstruction({ prompt: 'x' });
    for (const code of SIZE_REASON_CODES) expect(instr).toContain(code);
    expect(instr).toContain('"size"');
  });

  it('includes optional repository context when provided', () => {
    const instr = sizingInstruction({ prompt: 'x', repositoryContext: 'RetryPolicy in packages/http/retry.ts' });
    expect(instr).toContain('Repository context:');
    expect(instr).toContain('RetryPolicy in packages/http/retry.ts');
  });
});

describe('parseSizingOutput (TASK-51)', () => {
  it('parses a fenced JSON size + reason codes', () => {
    const out = parseSizingOutput('```json\n{"size":"L","reasonCodes":["security_sensitive","public_contract"]}\n```');
    expect(out?.size).toBe('L');
    expect(out?.reasonCodes).toEqual(expect.arrayContaining(['security_sensitive', 'public_contract']));
    expect(out?.reasonCodes).toHaveLength(2);
  });

  it('parses a bare JSON object', () => {
    expect(parseSizingOutput('{"size":"S"}')?.size).toBe('S');
  });

  it('parses a lone letter answer with no reason codes', () => {
    const out = parseSizingOutput('M');
    expect(out?.size).toBe('M');
    expect(out?.reasonCodes).toEqual([]);
  });

  it('ignores unknown reason codes', () => {
    const out = parseSizingOutput('{"size":"M","reasonCodes":["not_a_real_code","multiple_steps"]}');
    expect(out?.reasonCodes).toEqual(['multiple_steps']);
  });

  it('returns undefined when no size token is present', () => {
    expect(parseSizingOutput('I am not sure how big this is.')).toBeUndefined();
  });
});
