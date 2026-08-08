import type { TaskPhase, TaskSize } from '@awb/domain';

/**
 * The canonical full lifecycle order, including program-design. `assimilate` is
 * terminal. This is the SUPERSET + ordering source; a given run walks a per-run `phaseSet`
 * that is a subset of this — S/M tasks omit some of the planning phases (`plan`, `program-design`).
 */
export const TASK_PHASE_ORDER: TaskPhase[] = [
  'specify',
  'plan',
  'program-design',
  'prepare',
  'implement',
  'verify',
  'exercise',
  'challenge',
  'release',
  'assimilate',
];

/**
 * The planning phases sizing may skip. Every OTHER phase — specify, prepare, implement,
 * verify, exercise, challenge, release, assimilate — always runs, regardless of size, so QA/verify/
 * review guarantees are never weakened by a smaller size.
 */
const SKIPPABLE_PLANNING_PHASES: Record<TaskSize, TaskPhase[]> = {
  // S: single-shot — skip BOTH the plan and the program-design ceremony, straight to a slice.
  S: ['plan', 'program-design'],
  // M: one combined plan artifact, but no separate program-design phase.
  M: ['program-design'],
  // L: full ceremony — skip nothing.
  L: [],
};

/**
 * The ordered subset of `TASK_PHASE_ORDER` a run of the given size walks. A subset of the
 * full order with the size's skippable planning phases removed; ordering is preserved.
 */
export function phaseSetForSize(size: TaskSize): TaskPhase[] {
  const skip = new Set(SKIPPABLE_PLANNING_PHASES[size]);
  return TASK_PHASE_ORDER.filter((p) => !skip.has(p));
}

/**
 * The phase after `phase` within a specific run's ordered `phaseSet`. Falls back to the
 * full order when no per-run set is threaded (initial start before specify sets one), and to
 * `assimilate` past the end. Pure — no I/O — so it stays inside the deterministic Workflow.
 */
export function nextPhaseIn(phaseSet: TaskPhase[] | undefined, phase: TaskPhase): TaskPhase {
  const order = phaseSet && phaseSet.length > 0 ? phaseSet : TASK_PHASE_ORDER;
  const idx = order.indexOf(phase);
  // A phase not in the run's set (e.g. the phase we just derived the set from) advances by the full
  // order's position — but the common case is a straight index walk within the set.
  if (idx === -1) {
    const fullIdx = TASK_PHASE_ORDER.indexOf(phase);
    const nextFull = TASK_PHASE_ORDER.slice(fullIdx + 1).find((p) => order.includes(p));
    return nextFull ?? 'assimilate';
  }
  return order[idx + 1] ?? 'assimilate';
}
