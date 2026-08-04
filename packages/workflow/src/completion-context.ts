import type { TaskContractStatus, ImplementationPlanStatus } from '@awb/domain';

/**
 * Everything `evaluatePhaseCompletion` needs to decide whether a phase is complete, aside from
 * the CompletionCandidate itself. This is intentionally a plain data snapshot — no database
 * handles, no I/O — so the function stays pure and trivially unit-testable.
 */
export interface CompletionContext {
  specify?: {
    objectiveNonEmpty: boolean;
    claimCount: number;
    everyClaimHasEvidenceRequirements: boolean;
    constraintsArrayPresent: boolean;
    nonGoalsArrayPresent: boolean;
    noUnresolvedAmbiguity: boolean;
    /** TASK-54: a non-empty problem statement the human aligns on before planning. */
    problemStatementPresent: boolean;
    /**
     * TASK-54: at least one measurable success criterion exists when the contract carries a
     * behavioral claim. True vacuously for non-behavioral contracts.
     */
    successCriteriaPresentForBehavioralClaims: boolean;
    contractStatus: TaskContractStatus;
  };
  plan?: {
    everyClaimMappedToSlice: boolean;
    everyBehavioralClaimHasQaScenario: boolean;
    everySliceHasTargetedChecks: boolean;
    criticBlockerOrHighFindingCount: number;
    isHighRisk: boolean;
    planStatus: ImplementationPlanStatus;
    humanApprovedHighRiskPlan: boolean;
  };
  prepare?: {
    baseShaRecorded: boolean;
    worktreeExists: boolean;
    branchExists: boolean;
    executionProfileApproved: boolean;
    dependenciesPrepared: boolean;
    baselineCommandsAttempted: boolean;
    preExistingFailuresClassified: boolean;
    leaseActive: boolean;
  };
  implement?: {
    everySliceAccountedFor: boolean;
    candidateCommitExists: boolean;
    targetedChecksPass: boolean;
    builderBlockerOpen: boolean;
    diffWithinApprovedScope: boolean;
  };
  verify?: {
    allRequiredCommandsPass: boolean;
    resultsTiedToCandidateSha: boolean;
    resultsTiedToEnvironmentDigest: boolean;
    anyResultStale: boolean;
    waiversAreHumanApprovedAndShaScoped: boolean;
  };
  exercise?: {
    everyRequiredScenarioHasResult: boolean;
    everyBehavioralClaimCovered: boolean;
    /**
     * TASK-42: behavioral claim ids that have no passing *strong* (state-transition/value-match)
     * QA assertion exercising them. Non-empty ⇒ the gate does not clear, even if
     * `everyBehavioralClaimCovered` was reported true, so a scenario of only liveness checks can
     * no longer rubber-stamp a behavioral claim. Optional for back-compat with fixtures.
     */
    behavioralClaimsMissingStrongAssertion?: string[];
    structuredAssertionsPass: boolean;
    requiredRecordingExists: boolean;
    browserScenariosHaveTraces: boolean;
    evidenceTiedToCandidateSha: boolean;
    policyBlockingErrorsPresent: boolean;
  };
  challenge?: {
    reviewerSessionDiffersFromBuilder: boolean;
    blockerOrHighFindingOpen: boolean;
    everyFindingResolvedInvalidatedOrWaived: boolean;
    reviewerExaminedAllRequiredInputs: boolean;
  };
  release?: {
    targetBranchFetched: boolean;
    candidateReconciledWithTarget: boolean;
    evidenceAppliesToFinalCandidate: boolean;
    branchPushed: boolean;
    draftPrExists: boolean;
    evidenceMatrixPosted: boolean;
    requiredVideosUploaded: boolean;
    prReferencesFinalCandidateSha: boolean;
  };
  assimilate?: {
    prMerged: boolean;
    prClosed: boolean;
    prAbandoned: boolean;
    memoryRefreshedFromMergeCommit: boolean;
    processesStopped: boolean;
    worktreeRemovedOrPreserved: boolean;
    retentionPolicyApplied: boolean;
  };
}
