import type { Stage } from './lifecycle.js';

/** Kinds of durable artifact a task can accumulate. */
export const ARTIFACT_KINDS = [
  'raw_prompt',
  'task_brief',
  'discovery',
  'baseline_evidence',
  'execution_plan',
  'validation_report',
  'demo_evidence',
  'self_review',
  'bounce_packet',
  'delivery_package',
  'log',
  'diff',
] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export function isArtifactKind(value: unknown): value is ArtifactKind {
  return typeof value === 'string' && (ARTIFACT_KINDS as readonly string[]).includes(value);
}

export const ARTIFACT_KIND_LABELS: Record<ArtifactKind, string> = {
  raw_prompt: 'Raw Prompt',
  task_brief: 'Task Brief',
  discovery: 'Discovery',
  baseline_evidence: 'Baseline Evidence',
  execution_plan: 'Execution Plan',
  validation_report: 'Validation Report',
  demo_evidence: 'Demo Evidence',
  self_review: 'Self-Review',
  bounce_packet: 'Bounce Packet',
  delivery_package: 'Delivery Package',
  log: 'Log',
  diff: 'Diff',
};

/**
 * The stage a given artifact kind is naturally produced in. Used to attribute
 * mock artifacts to the right point on the timeline. `log` and `diff` are
 * cross-cutting and may appear at any stage, so they are intentionally absent.
 */
export const ARTIFACT_KIND_STAGE: Partial<Record<ArtifactKind, Stage>> = {
  raw_prompt: 'intake',
  task_brief: 'task_brief',
  // `discovery` (the artifact kind) is no longer emitted by any stage: discovery
  // and planning merged into one stage that produces a single `execution_plan`
  // (findings folded in). The kind is retained for back-compat with old tasks,
  // but it intentionally has no stage attribution here so the inverse
  // stage->primary-kind map stays unambiguous (discovery -> execution_plan).
  // The baseline + validation report are produced by the static-checks stage
  // (the first half of the former single 'verification' stage). The E2E demo
  // bundle is produced by the feature_e2e stage (the second half).
  baseline_evidence: 'static_checks',
  execution_plan: 'discovery',
  validation_report: 'static_checks',
  demo_evidence: 'feature_e2e',
  self_review: 'agent_self_review',
  bounce_packet: 'human_review',
  delivery_package: 'delivery_prep',
};
