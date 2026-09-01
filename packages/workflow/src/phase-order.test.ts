import { describe, expect, it } from 'vitest';
import type { TaskPhase } from '@awb/domain';
import { TASK_PHASE_ORDER, phaseSetForSize, nextPhaseIn } from './phase-order.js';

describe('phaseSetForSize (TASK-51)', () => {
  it('S skips both plan and program-design', () => {
    const set = phaseSetForSize('S');
    expect(set).not.toContain('plan');
    expect(set).not.toContain('program-design');
    // the safety phases still all run
    for (const p of ['specify', 'prepare', 'implement', 'verify', 'exercise', 'challenge', 'release', 'assimilate'] as TaskPhase[]) {
      expect(set).toContain(p);
    }
  });

  it('M runs plan but skips program-design', () => {
    const set = phaseSetForSize('M');
    expect(set).toContain('plan');
    expect(set).not.toContain('program-design');
  });

  it('L runs the full order including program-design', () => {
    expect(phaseSetForSize('L')).toEqual(TASK_PHASE_ORDER);
  });

  it('preserves the canonical ordering', () => {
    const set = phaseSetForSize('M');
    const indices = set.map((p) => TASK_PHASE_ORDER.indexOf(p));
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });
});

describe('phaseSetForSize disableProgramDesign (TASK-61)', () => {
  it('L with the flag omits program-design but keeps every other phase and ordering', () => {
    const full = phaseSetForSize('L');
    const set = phaseSetForSize('L', { disableProgramDesign: true });
    expect(set).not.toContain('program-design');
    expect(set).toEqual(full.filter((p) => p !== 'program-design'));
    // ordering preserved
    const indices = set.map((p) => TASK_PHASE_ORDER.indexOf(p));
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });

  it('is a no-op for M/S (program-design already absent)', () => {
    expect(phaseSetForSize('M', { disableProgramDesign: true })).toEqual(phaseSetForSize('M'));
    expect(phaseSetForSize('S', { disableProgramDesign: true })).toEqual(phaseSetForSize('S'));
  });

  it('defaults to the full L set when the flag is false/absent', () => {
    expect(phaseSetForSize('L', { disableProgramDesign: false })).toEqual(TASK_PHASE_ORDER);
    expect(phaseSetForSize('L')).toEqual(TASK_PHASE_ORDER);
  });
});

describe('nextPhaseIn (TASK-51)', () => {
  it('walks the run phase set, not the full order', () => {
    const set = phaseSetForSize('S'); // no plan / program-design
    // after specify, S goes straight to prepare
    expect(nextPhaseIn(set, 'specify')).toBe('prepare');
    expect(nextPhaseIn(set, 'prepare')).toBe('implement');
  });

  it('for L, specify → plan → program-design → prepare', () => {
    const set = phaseSetForSize('L');
    expect(nextPhaseIn(set, 'specify')).toBe('plan');
    expect(nextPhaseIn(set, 'plan')).toBe('program-design');
    expect(nextPhaseIn(set, 'program-design')).toBe('prepare');
  });

  it('falls back to the full order when no set is threaded', () => {
    expect(nextPhaseIn(undefined, 'specify')).toBe('plan');
  });

  it('returns assimilate past the end', () => {
    expect(nextPhaseIn(phaseSetForSize('L'), 'release')).toBe('assimilate');
    expect(nextPhaseIn(phaseSetForSize('L'), 'assimilate')).toBe('assimilate');
  });

  it('advances a phase absent from the run set to the next included phase', () => {
    // A run classified S never walks `plan`, but if asked, advancement lands on the next set member.
    const set = phaseSetForSize('S');
    expect(nextPhaseIn(set, 'plan')).toBe('prepare');
  });
});
