import type { TaskPhase } from '@awb/domain';

/** The fixed 9-phase lifecycle order (product spec §9). `assimilate` is terminal. */
export const TASK_PHASE_ORDER: TaskPhase[] = [
  'specify',
  'plan',
  'prepare',
  'implement',
  'verify',
  'exercise',
  'challenge',
  'release',
  'assimilate',
];
