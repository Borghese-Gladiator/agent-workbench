import { describe, expect, it } from 'vitest';
import { routeLoop, shouldEscalateToHuman } from './loop-routing.js';

describe('routeLoop', () => {
  it('routes verify failure to implement', () => {
    expect(routeLoop({ kind: 'verify-failure' })).toBe('implement');
  });

  it('routes an exercise behavior defect to implement', () => {
    expect(routeLoop({ kind: 'exercise-behavior-defect' })).toBe('implement');
  });

  it('routes an exercise design misunderstanding to plan', () => {
    expect(routeLoop({ kind: 'exercise-design-misunderstanding' })).toBe('plan');
  });

  it('routes a challenge code finding to implement', () => {
    expect(routeLoop({ kind: 'challenge-finding', category: 'correctness' })).toBe('implement');
  });

  it('routes a challenge architecture finding to plan', () => {
    expect(routeLoop({ kind: 'challenge-finding', category: 'architecture' })).toBe('plan');
  });

  it('routes a challenge requirements finding to specify', () => {
    expect(routeLoop({ kind: 'challenge-finding', category: 'requirements' })).toBe('specify');
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
