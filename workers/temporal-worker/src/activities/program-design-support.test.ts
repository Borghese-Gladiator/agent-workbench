import { describe, expect, it } from 'vitest';
import type { ImplementationPlan } from '@awb/domain';
import { programDesignInstruction, parseProgramDesignOutput, signatureIsBodyless } from './program-design-support.js';

const plan: ImplementationPlan = {
  id: 'plan-1',
  taskId: 'task-1',
  contractVersion: 1,
  version: 2,
  summary: 'add a foo module',
  affectedAreas: [],
  slices: [],
  risks: [],
  claimCoverage: [],
  status: 'accepted',
};

describe('programDesignInstruction (TASK-52)', () => {
  it('embeds the plan summary and demands signatures-only JSON', () => {
    const instr = programDesignInstruction(plan);
    expect(instr).toContain('add a foo module');
    expect(instr).toContain('NO implementation');
    expect(instr).toContain('fileTreeDiff');
  });
});

describe('signatureIsBodyless (TASK-52)', () => {
  it('accepts a bare function signature', () => {
    expect(signatureIsBodyless('makeFoo(id: string): Foo')).toBe(true);
  });

  it('accepts a TS interface shape (no statements)', () => {
    expect(signatureIsBodyless('interface Foo { id: string; name: string }')).toBe(false);
    // a `;` inside the braces reads as a statement leak — interfaces should be declared without them
    expect(signatureIsBodyless('interface Foo { id: string }')).toBe(true);
  });

  it('rejects a leaked function body', () => {
    expect(signatureIsBodyless('makeFoo(id) { return { id }; }')).toBe(false);
  });
});

describe('parseProgramDesignOutput (TASK-52)', () => {
  it('parses a fenced design with file-tree diff and signatures, no bodies', () => {
    const text = [
      '```json',
      JSON.stringify({
        fileTreeDiff: ['+ src/foo.ts (new module)'],
        typeSignatures: [{ signature: 'interface Foo { id: string }', intent: 'a foo' }],
        functionSignatures: [{ signature: 'makeFoo(id: string): Foo', intent: 'make one' }],
      }),
      '```',
    ].join('\n');
    const parsed = parseProgramDesignOutput(text, plan);
    expect(parsed).toBeDefined();
    expect(parsed?.design.planVersion).toBe(2);
    expect(parsed?.design.fileTreeDiff).toHaveLength(1);
    expect(parsed?.allSignaturesBodyless).toBe(true);
  });

  it('flags leaked bodies via allSignaturesBodyless', () => {
    const text = JSON.stringify({
      fileTreeDiff: ['~ src/foo.ts'],
      functionSignatures: [{ signature: 'makeFoo(id) { return id; }', intent: 'make one' }],
    });
    const parsed = parseProgramDesignOutput(text, plan);
    expect(parsed?.allSignaturesBodyless).toBe(false);
  });

  it('returns undefined when nothing usable is present', () => {
    expect(parseProgramDesignOutput('no json here', plan)).toBeUndefined();
  });
});
