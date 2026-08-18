import { describe, it, expect } from 'vitest';
import { evaluateOverReach, SIZE_FILE_CEILING } from './over-reach.js';

describe('evaluateOverReach', () => {
  it('passes a focused change well within scope', () => {
    const r = evaluateOverReach({
      changedPaths: ['packages/qa/src/shared.ts', 'packages/qa/src/shared.test.ts'],
      expectedPaths: ['packages/qa/src/shared.ts'],
      size: 'S',
    });
    expect(r.withinScope).toBe(true);
    expect(r.reasons).toEqual([]);
    expect(r.protectedHits).toEqual([]);
  });

  it('flags the 726-file archive sweep (the TASK-113 case)', () => {
    const changedPaths = [
      '.claude/skills/dogfood/SKILL.md',
      ...Array.from({ length: 467 }, (_, i) => `archive/agentic-v4/file-${i}.ts`),
      ...Array.from({ length: 148 }, (_, i) => `packages/whatever/src/x-${i}.ts`),
    ];
    const r = evaluateOverReach({
      changedPaths,
      expectedPaths: ['.claude/skills/dogfood/SKILL.md'],
      size: 'S',
    });
    expect(r.withinScope).toBe(false);
    // both triggers fire: protected-path (archive/) AND gross file-count
    expect(r.protectedHits.length).toBe(467);
    expect(r.reasons.some((m) => m.includes('protected'))).toBe(true);
    expect(r.reasons.some((m) => m.includes('files'))).toBe(true);
  });

  it('blocks a write to a protected tree even when the file count is small', () => {
    const r = evaluateOverReach({
      changedPaths: ['dist/index.js', 'pnpm-lock.yaml'],
      expectedPaths: ['src/index.ts'],
      size: 'M',
    });
    expect(r.withinScope).toBe(false);
    expect(r.protectedHits).toEqual(['dist/index.js', 'pnpm-lock.yaml']);
  });

  it('allows a protected path the contract explicitly names', () => {
    const r = evaluateOverReach({
      changedPaths: ['pnpm-lock.yaml', 'package.json'],
      expectedPaths: ['package.json'],
      size: 'M',
      allowedProtectedPaths: ['pnpm-lock.yaml'],
    });
    expect(r.withinScope).toBe(true);
    expect(r.protectedHits).toEqual([]);
  });

  it('uses the size ceiling as a floor when the plan under-specifies expected paths', () => {
    // 30 files, no expected paths, size S (ceiling 25) → over-reach on count alone
    const changedPaths = Array.from({ length: 30 }, (_, i) => `src/file-${i}.ts`);
    const r = evaluateOverReach({ changedPaths, expectedPaths: [], size: 'S' });
    expect(r.withinScope).toBe(false);
    expect(r.ceiling).toBe(SIZE_FILE_CEILING.S);
  });

  it('lets a broad-but-planned L change through under the multiplier', () => {
    // 120 files with 40 planned paths: ceiling = max(200, 40*4=160) = 200 → within scope
    const changedPaths = Array.from({ length: 120 }, (_, i) => `src/file-${i}.ts`);
    const expectedPaths = Array.from({ length: 40 }, (_, i) => `src/file-${i}.ts`);
    const r = evaluateOverReach({ changedPaths, expectedPaths, size: 'L' });
    expect(r.withinScope).toBe(true);
  });

  it('normalizes backslash and leading ./ paths before matching protected prefixes', () => {
    const r = evaluateOverReach({
      changedPaths: ['./archive/x.ts', 'archive\\y.ts'],
      size: 'M',
    });
    expect(r.protectedHits).toEqual(['archive/x.ts', 'archive/y.ts']);
    expect(r.withinScope).toBe(false);
  });

  it('defaults size to M when unknown', () => {
    const changedPaths = Array.from({ length: 26 }, (_, i) => `src/file-${i}.ts`);
    const r = evaluateOverReach({ changedPaths });
    expect(r.ceiling).toBe(SIZE_FILE_CEILING.M);
    expect(r.withinScope).toBe(true); // 26 < 80
  });
});
