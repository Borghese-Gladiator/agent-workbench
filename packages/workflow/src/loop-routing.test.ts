import { describe, expect, it } from 'vitest';
import type { TaskPhase } from '@awb/domain';
import { routeLoop, shouldEscalateToHuman } from './loop-routing.js';

// Phase sets the router keys off: only membership of `program-design` matters.
const L_PHASE_SET: TaskPhase[] = [
  'specify', 'plan', 'program-design', 'prepare', 'implement', 'verify', 'exercise', 'challenge', 'release', 'assimilate',
];
const M_PHASE_SET: TaskPhase[] = [
  'specify', 'plan', 'prepare', 'implement', 'verify', 'exercise', 'challenge', 'release', 'assimilate',
];

describe('routeLoop', () => {
  it('routes verify failure to implement', () => {
    expect(routeLoop({ kind: 'verify-failure' })).toBe('implement');
  });

  it('routes an exercise behavior defect to implement', () => {
    expect(routeLoop({ kind: 'exercise-behavior-defect' })).toBe('implement');
  });

  it('routes an exercise design misunderstanding to plan by default (no phase set)', () => {
    expect(routeLoop({ kind: 'exercise-design-misunderstanding' })).toBe('plan');
  });

  it('routes a challenge code finding to implement', () => {
    expect(routeLoop({ kind: 'challenge-finding', category: 'correctness' })).toBe('implement');
  });

  it('routes a challenge architecture finding to plan by default (no phase set)', () => {
    expect(routeLoop({ kind: 'challenge-finding', category: 'architecture' })).toBe('plan');
  });

  it('routes a challenge requirements finding to specify', () => {
    expect(routeLoop({ kind: 'challenge-finding', category: 'requirements' })).toBe('specify');
  });

  // Structural findings route to the phase that owns structure for the run.
  it('routes an architecture finding to program-design on an L run', () => {
    expect(routeLoop({ kind: 'challenge-finding', category: 'architecture' }, L_PHASE_SET)).toBe('program-design');
  });

  it('routes a design-misunderstanding to program-design on an L run', () => {
    expect(routeLoop({ kind: 'exercise-design-misunderstanding' }, L_PHASE_SET)).toBe('program-design');
  });

  it('still routes an architecture finding to plan on an M run (no program-design phase)', () => {
    expect(routeLoop({ kind: 'challenge-finding', category: 'architecture' }, M_PHASE_SET)).toBe('plan');
  });

  it('routes a requirements finding to specify regardless of phase set', () => {
    expect(routeLoop({ kind: 'challenge-finding', category: 'requirements' }, L_PHASE_SET)).toBe('specify');
  });

  it('routes a code finding to implement regardless of phase set', () => {
    expect(routeLoop({ kind: 'challenge-finding', category: 'correctness' }, L_PHASE_SET)).toBe('implement');
  });

  it('routes a release conflict requiring a code change to implement', () => {
    expect(routeLoop({ kind: 'release-conflict-requires-code-change' })).toBe('implement');
  });

  it('routes a release-induced candidate SHA change to verify', () => {
    expect(routeLoop({ kind: 'release-candidate-sha-changed' })).toBe('verify');
  });
});

describe('shouldEscalateToHuman', () => {
  it('escalates once repeated identical failures reach the threshold', () => {
    expect(shouldEscalateToHuman({ kind: 'repeated-identical-failure', occurrences: 3, threshold: 3 })).toBe(true);
  });

  it('does not escalate below the threshold', () => {
    expect(shouldEscalateToHuman({ kind: 'repeated-identical-failure', occurrences: 2, threshold: 3 })).toBe(false);
  });

  it('always escalates on budget exhaustion', () => {
    expect(shouldEscalateToHuman({ kind: 'budget-exhaustion' })).toBe(true);
  });
});
