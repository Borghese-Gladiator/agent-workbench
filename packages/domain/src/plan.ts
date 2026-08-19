import { z } from 'zod';

/**
 * An expected per-claim QA assertion the planner emits — the specific state transition
 * (or value) the QA author must observe for a behavioral claim. Gives the QA author a target and
 * lets the exercise gate check that an assertion actually exercises the claim's observable
 * behaviour, not merely that some scenario ran for it.
 */
export const ExpectedAssertionSchema = z.object({
  claimId: z.string(),
  /** Human-readable description of the transition/value to observe (e.g. "a higher rank beats a lower one"). */
  observes: z.string(),
  kind: z.enum(['state-transition', 'value-match']),
});
export type ExpectedAssertion = z.infer<typeof ExpectedAssertionSchema>;

export const PlanSliceSchema = z.object({
  id: z.string(),
  objective: z.string(),
  claimIds: z.array(z.string()),
  likelyPaths: z.array(z.string()),
  requiredTargetedChecks: z.array(z.string()),
  dependencies: z.array(z.string()),
  /**
   * QA scenario identifiers this slice exercises. A behavioral claim with `qaEvidenceRequired`
   * is only satisfied at the plan gate when a slice covering it declares at least one scenario
   * (see everyBehavioralClaimHasQaScenario). Optional so non-behavioral plans/fixtures are unaffected.
   */
  qaScenarioIds: z.array(z.string()).optional(),
  /** Expected per-claim QA assertions this slice's scenarios must observe. */
  expectedAssertions: z.array(ExpectedAssertionSchema).optional(),
  /**
   * True when the planner determined this slice builds a from-scratch UI with no existing
   * style to match, and should follow agent-workbench's own `.claude/skills/build-ui/SKILL.md`.
   * The builder activity resolves that file against agent-workbench's own repo (never the
   * target repo) and inlines its content into the slice instruction, since the builder agent's
   * cwd is the target repo and can never see agent-workbench's own skills via native discovery.
   */
  usesBuildUiSkill: z.boolean().optional(),
});
export type PlanSlice = z.infer<typeof PlanSliceSchema>;

export const PlanRiskSchema = z.object({
  id: z.string(),
  description: z.string(),
  severity: z.enum(['low', 'medium', 'high']),
  mitigation: z.string().optional(),
});
export type PlanRisk = z.infer<typeof PlanRiskSchema>;

export const ClaimCoverageSchema = z.object({
  claimId: z.string(),
  planSliceIds: z.array(z.string()),
  qaScenarioIds: z.array(z.string()),
  /** The expected assertions covering this claim, aggregated from its covering slices. */
  expectedAssertions: z.array(ExpectedAssertionSchema).optional(),
});
export type ClaimCoverage = z.infer<typeof ClaimCoverageSchema>;

export const ImplementationPlanStatusSchema = z.enum([
  'draft',
  'critic_rejected',
  'accepted',
  'superseded',
]);
export type ImplementationPlanStatus = z.infer<typeof ImplementationPlanStatusSchema>;

export const ImplementationPlanSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  contractVersion: z.number().int().positive(),
  version: z.number().int().positive(),
  summary: z.string(),
  affectedAreas: z.array(z.string()),
  slices: z.array(PlanSliceSchema),
  risks: z.array(PlanRiskSchema),
  claimCoverage: z.array(ClaimCoverageSchema),
  status: ImplementationPlanStatusSchema,
});
export type ImplementationPlan = z.infer<typeof ImplementationPlanSchema>;

/**
 * A single type/interface or function declared in the program-design phase (WSFF): its
 * signature and a one-line intent, deliberately WITHOUT a body. Reviewing this before implementation
 * is the cheap structural review WSFF prescribes — architectural mistakes are caught while still free.
 */
export const DesignSignatureSchema = z.object({
  /** e.g. a type name, interface name, or `functionName(args): ReturnType` signature. */
  signature: z.string(),
  /** One-line statement of what it is for. No implementation. */
  intent: z.string(),
});
export type DesignSignature = z.infer<typeof DesignSignatureSchema>;

/**
 * The program-design artifact: the projected structure of an L task's change, decided and
 * reviewed BEFORE any slice runs. `fileTreeDiff` is a human-readable list of files added/changed;
 * `typeSignatures`/`functionSignatures` are signatures-only (no bodies). Gated like the plan.
 */
export const ProgramDesignSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  planVersion: z.number().int().positive(),
  version: z.number().int().positive(),
  /** Files this change adds or modifies (paths + a short note), no diff bodies. */
  fileTreeDiff: z.array(z.string()),
  typeSignatures: z.array(DesignSignatureSchema),
  functionSignatures: z.array(DesignSignatureSchema),
});
export type ProgramDesign = z.infer<typeof ProgramDesignSchema>;
