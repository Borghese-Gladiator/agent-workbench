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
    /** A non-empty problem statement the human aligns on before planning. */
    problemStatementPresent: boolean;
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
  programDesign?: {
    /** The program-design artifact was produced and recorded. */
    artifactExists: boolean;
    /** At least one file is listed in the projected file-tree diff. */
    fileTreeDiffNonEmpty: boolean;
    /** At least one type or function signature was declared. */
    hasSignatures: boolean;
    /** No implementation bodies leaked into the signatures (design-only, per WSFF). */
    signaturesAreBodyless: boolean;
    /** A human (or the gate machinery) accepted the design before code. */
    designAccepted: boolean;
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
     * Behavioral claim ids that have no passing *strong* (state-transition/value-match)
     * QA assertion exercising them. Non-empty ⇒ the gate does not clear, even if
     * `everyBehavioralClaimCovered` was reported true, so a scenario of only liveness checks can
     * no longer rubber-stamp a behavioral claim. Optional for back-compat with fixtures.
     */
    behavioralClaimsMissingStrongAssertion?: string[];
    /**
     * Behavioral claim ids whose committed diff touches none of the paths the plan associated with
     * them (`PlanSlice.likelyPaths`). Non-empty ⇒ the gate does not clear: a no-op / off-target
     * candidate (e.g. only `package-lock.json` committed for a README claim) can no longer pass QA
     * on assertion evidence alone. Optional for back-compat with fixtures and the mock path.
     */
    behavioralClaimsWithUntouchedTarget?: string[];
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
