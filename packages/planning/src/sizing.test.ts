import { describe, expect, it } from 'vitest';
import { classifyTaskSize, sizingInstruction, parseSizingOutput } from './sizing.js';

describe('classifyTaskSize (TASK-51 heuristic)', () => {
  it('classifies a short single-target prompt as S', () => {
    expect(classifyTaskSize({ prompt: 'fix a typo in the README', targetFileCount: 1 })).toBe('S');
  });

  it('classifies a cross-package change as L regardless of prompt length', () => {
    expect(classifyTaskSize({ prompt: 'small', packageSpan: 2 })).toBe('L');
  });

  it('classifies a many-file change as L', () => {
    expect(classifyTaskSize({ prompt: 'add a feature', targetFileCount: 8 })).toBe('L');
  });

  it('classifies a long single-area prompt as L', () => {
    const prompt = 'x'.repeat(700);
    expect(classifyTaskSize({ prompt, targetFileCount: 2, packageSpan: 1 })).toBe('L');
  });

  it('classifies a medium single-area change as M', () => {
    expect(classifyTaskSize({ prompt: 'refactor the tasks list to show phase and status', targetFileCount: 2 })).toBe('M');
  });

  it('defaults an unknown-signal medium-length prompt to M', () => {
    expect(classifyTaskSize({ prompt: 'add validation to the create-task form fields' })).toBe('M');
  });
});

describe('parseSizingOutput (TASK-51 model path)', () => {
  it('parses a fenced JSON size block', () => {
    expect(parseSizingOutput('Here is my answer:\n```json\n{"size": "L"}\n```')).toBe('L');
  });

  it('parses a bare JSON object', () => {
    expect(parseSizingOutput('{"size":"S"}')).toBe('S');
  });

  it('parses a lone letter answer', () => {
    expect(parseSizingOutput('M')).toBe('M');
  });

  it('returns undefined for unparseable output so the caller falls back', () => {
    expect(parseSizingOutput('I am not sure how big this is.')).toBeUndefined();
  });
});

describe('sizingInstruction', () => {
  it('embeds the prompt and asks for a JSON size token', () => {
    const instr = sizingInstruction({ prompt: 'do the thing', targetFileCount: 3, packageSpan: 1 });
    expect(instr).toContain('do the thing');
    expect(instr).toContain('Approx files touched: 3');
    expect(instr).toContain('"size"');
  });
});
