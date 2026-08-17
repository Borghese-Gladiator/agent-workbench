import type { CompletionCandidate, CompletionDecision } from '@awb/domain';
import type { CompletionContext } from './completion-context.js';

function decision(reasons: string[], missing: string[]): CompletionDecision {
  return { complete: missing.length === 0, reasons, missing };
}

function evaluateSpecify(ctx: CompletionContext['specify']): CompletionDecision {
  const missing: string[] = [];
  const reasons: string[] = [];
  if (!ctx) return decision(reasons, ['no specify context provided']);

  if (!ctx.objectiveNonEmpty) missing.push('objective is empty');
  else reasons.push('objective is non-empty');

  if (ctx.claimCount < 1) missing.push('no acceptance claims exist');
  else reasons.push(`${ctx.claimCount} acceptance claim(s) exist`);

  if (!ctx.everyClaimHasEvidenceRequirements) missing.push('some claim is missing evidence requirements');
  else reasons.push('every claim declares its evidence requirements');

  if (!ctx.constraintsArrayPresent) missing.push('constraints array is not present');
  if (!ctx.nonGoalsArrayPresent) missing.push('nonGoals array is not present');
  if (!ctx.noUnresolvedAmbiguity) missing.push('unresolved ambiguity remains');

  if (!ctx.problemStatementPresent) missing.push('problem statement is empty');
  else reasons.push('problem statement is present');

  if (ctx.contractStatus !== 'approved') missing.push(`contract status is "${ctx.contractStatus}", not "approved"`);
  else reasons.push('a human approved the current contract version');

  return decision(reasons, missing);
}

function evaluatePlan(ctx: CompletionContext['plan']): CompletionDecision {
  const missing: string[] = [];
  const reasons: string[] = [];
  if (!ctx) return decision(reasons, ['no plan context provided']);

  if (!ctx.everyClaimMappedToSlice) missing.push('some acceptance claim has no plan slice');
  if (!ctx.everyBehavioralClaimHasQaScenario) missing.push('some behavioral claim has no QA scenario');
  if (!ctx.everySliceHasTargetedChecks) missing.push('some plan slice has no targeted checks');

  if (ctx.criticBlockerOrHighFindingCount > 0) {
    missing.push(`plan critic left ${ctx.criticBlockerOrHighFindingCount} blocker/high finding(s) open`);
  } else {
    reasons.push('plan critic has no open blocker or high-severity finding');
  }

  if (ctx.isHighRisk && !ctx.humanApprovedHighRiskPlan) {
    missing.push('high-risk plan lacks human approval');
  }

  if (ctx.planStatus !== 'accepted') missing.push(`plan status is "${ctx.planStatus}", not "accepted"`);
  else reasons.push('plan status is accepted');

  return decision(reasons, missing);
}

function evaluateProgramDesign(ctx: CompletionContext['programDesign']): CompletionDecision {
  const missing: string[] = [];
  const reasons: string[] = [];
  if (!ctx) return decision(reasons, ['no program-design context provided']);

  if (!ctx.artifactExists) missing.push('program-design artifact does not exist');
  if (!ctx.fileTreeDiffNonEmpty) missing.push('projected file-tree diff is empty');
  if (!ctx.hasSignatures) missing.push('no type or function signatures were declared');
  if (!ctx.signaturesAreBodyless) missing.push('program design contains implementation bodies (design must be signatures only)');
  if (!ctx.designAccepted) missing.push('program design is not accepted');

  if (missing.length === 0) {
    reasons.push('program design has a file-tree diff and bodyless signatures, and was accepted before code');
  }
  return decision(reasons, missing);
}

function evaluatePrepare(ctx: CompletionContext['prepare']): CompletionDecision {
  const missing: string[] = [];
  const reasons: string[] = [];
  if (!ctx) return decision(reasons, ['no prepare context provided']);

  if (!ctx.baseShaRecorded) missing.push('base SHA is not recorded');
  if (!ctx.worktreeExists) missing.push('worktree does not exist');
  if (!ctx.branchExists) missing.push('task branch does not exist');
  if (!ctx.executionProfileApproved) missing.push('execution profile is not approved');
  if (!ctx.dependenciesPrepared) missing.push('dependencies are not prepared');
  if (!ctx.baselineCommandsAttempted) missing.push('required baseline commands were not attempted');
  if (!ctx.preExistingFailuresClassified) missing.push('pre-existing failures are not classified');
  if (!ctx.leaseActive) missing.push('workspace lease is not active');

  if (missing.length === 0) reasons.push('worktree, branch, dependencies, and baseline are all ready');
  return decision(reasons, missing);
}

function evaluateImplement(ctx: CompletionContext['implement']): CompletionDecision {
  const missing: string[] = [];
  const reasons: string[] = [];
  if (!ctx) return decision(reasons, ['no implement context provided']);

  if (!ctx.everySliceAccountedFor) missing.push('some plan slice is not accounted for');
  if (!ctx.candidateCommitExists) missing.push('no candidate commit exists');
  if (!ctx.targetedChecksPass) missing.push('targeted checks do not pass');
  if (ctx.builderBlockerOpen) missing.push('a builder blocker is open');
  if (!ctx.diffWithinApprovedScope) missing.push('diff exceeds the approved task scope');

  if (missing.length === 0) reasons.push('all slices implemented, targeted checks pass, diff within scope');
  return decision(reasons, missing);
}

function evaluateVerify(ctx: CompletionContext['verify']): CompletionDecision {
  const missing: string[] = [];
  const reasons: string[] = [];
  if (!ctx) return decision(reasons, ['no verify context provided']);

  if (!ctx.allRequiredCommandsPass) missing.push('not all required deterministic commands pass');
  if (!ctx.resultsTiedToCandidateSha) missing.push('results are not tied to the exact candidate SHA');
  if (!ctx.resultsTiedToEnvironmentDigest) missing.push('results are not tied to the environment digest');
  if (ctx.anyResultStale) missing.push('a required result is stale');
  if (!ctx.waiversAreHumanApprovedAndShaScoped) missing.push('a waiver is not human-approved and exact-SHA scoped');

  if (missing.length === 0) reasons.push('all required commands pass against the exact candidate SHA');
  return decision(reasons, missing);
}

function evaluateExercise(ctx: CompletionContext['exercise']): CompletionDecision {
  const missing: string[] = [];
  const reasons: string[] = [];
  if (!ctx) return decision(reasons, ['no exercise context provided']);

  if (!ctx.everyRequiredScenarioHasResult) missing.push('some required QA scenario has no result');
  if (!ctx.everyBehavioralClaimCovered) missing.push('some behavioral acceptance claim is not covered');
  if (ctx.behavioralClaimsMissingStrongAssertion && ctx.behavioralClaimsMissingStrongAssertion.length > 0) {
    missing.push(
      `${ctx.behavioralClaimsMissingStrongAssertion.length} behavioral claim(s) lack a passing state-transition/value assertion`,
    );
  }
  if (!ctx.structuredAssertionsPass) missing.push('structured assertions do not pass');
  if (!ctx.requiredRecordingExists) missing.push('required video or terminal recording does not exist');
  if (!ctx.browserScenariosHaveTraces) missing.push('a browser scenario is missing a Playwright trace');
  if (!ctx.evidenceTiedToCandidateSha) missing.push('QA evidence is not tied to the exact candidate SHA');
  if (ctx.policyBlockingErrorsPresent) missing.push('a policy-blocking runtime, console, or network error remains');

  if (missing.length === 0) {
    reasons.push('every required QA scenario passed with structured assertions and required recordings');
  }
  return decision(reasons, missing);
}

function evaluateChallenge(ctx: CompletionContext['challenge']): CompletionDecision {
  const missing: string[] = [];
  const reasons: string[] = [];
  if (!ctx) return decision(reasons, ['no challenge context provided']);

  if (!ctx.reviewerSessionDiffersFromBuilder) missing.push('reviewer session is not distinct from the builder session');
  if (ctx.blockerOrHighFindingOpen) missing.push('a blocker or high-severity finding remains open');
  if (!ctx.everyFindingResolvedInvalidatedOrWaived) missing.push('some finding is neither resolved, invalidated, nor waived');
  if (!ctx.reviewerExaminedAllRequiredInputs) missing.push('reviewer did not examine contract/plan/diff/verification/QA evidence');

  if (missing.length === 0) reasons.push('adversarial review complete with no open blocking findings');
  return decision(reasons, missing);
}

function evaluateRelease(ctx: CompletionContext['release']): CompletionDecision {
  const missing: string[] = [];
  const reasons: string[] = [];
  if (!ctx) return decision(reasons, ['no release context provided']);

  if (!ctx.targetBranchFetched) missing.push('target branch was not fetched');
  if (!ctx.candidateReconciledWithTarget) missing.push('candidate was not reconciled with the latest target branch');
  if (!ctx.evidenceAppliesToFinalCandidate) missing.push('required evidence does not apply to the final candidate');
  if (!ctx.branchPushed) missing.push('branch was not pushed');
  if (!ctx.draftPrExists) missing.push('draft PR does not exist');
  if (!ctx.evidenceMatrixPosted) missing.push('evidence matrix was not posted');
  if (!ctx.requiredVideosUploaded) missing.push('required QA videos were not uploaded');
  if (!ctx.prReferencesFinalCandidateSha) missing.push('draft PR does not reference the final candidate SHA');

  if (missing.length === 0) reasons.push('branch pushed, draft PR open, evidence matrix and videos posted');
  return decision(reasons, missing);
}

function evaluateAssimilate(ctx: CompletionContext['assimilate']): CompletionDecision {
  const missing: string[] = [];
  const reasons: string[] = [];
  if (!ctx) return decision(reasons, ['no assimilate context provided']);

  const terminal = ctx.prMerged || ctx.prClosed || ctx.prAbandoned;
  if (!terminal) missing.push('PR is neither merged, closed, nor abandoned');

  if (ctx.prMerged && !ctx.memoryRefreshedFromMergeCommit) {
    missing.push('PR merged but project memory was not refreshed from the merge commit');
  }
  if (!ctx.prMerged && ctx.memoryRefreshedFromMergeCommit) {
    missing.push('project memory was refreshed without a merge — implementation facts must not be promoted');
  }

  if (!ctx.processesStopped) missing.push('task processes are not stopped');
  if (!ctx.worktreeRemovedOrPreserved) missing.push('worktree is neither removed nor explicitly preserved');
  if (!ctx.retentionPolicyApplied) missing.push('retention policy was not applied');

  if (missing.length === 0) reasons.push('PR reached a terminal state and cleanup completed');
  return decision(reasons, missing);
}

type ExerciseContext = NonNullable<CompletionContext['exercise']>;

/**
 * How a blocked `exercise` decision should be routed. `code-fixable` means a genuine
 * runtime/behavior defect the builder can address by re-coding (route `repair → implement`).
 * `evidence-deficiency` means the code may well be correct but the QA *evidence* is
 * missing or not tied to the candidate (a missing recording/trace, a claim with no strong
 * assertion, evidence not SHA-scoped) — re-running implement/verify cannot produce it, so the
 * task must escalate to a human `qa-inconclusive` gate instead of looping into implement.
 */
export type ExerciseBlockKind = 'code-fixable' | 'evidence-deficiency';

/**
 * Classify a blocked `exercise` gate from the signals it evaluated. A genuine code defect takes
 * precedence: if a code-fixable signal failed, the block is `code-fixable` even when evidence
 * signals also failed (re-coding can fix the defect and re-run QA). Only when every failing signal
 * is an evidence-capture deficiency is the block `evidence-deficiency`. Callers pass the same
 * `exercise` CompletionContext handed to `evaluatePhaseCompletion`.
 *
 * The discriminator is whether QA observed a *real failure* versus merely *missing/insufficient
 * evidence*. Code-fixable failures are things the builder can address by changing the code and
 * re-running QA:
 *   - `policyBlockingErrorsPresent` — a real runtime, console, or network error the QA run saw.
 *   - `!structuredAssertionsPass` — a structured assertion actually ran and failed (a real defect
 *     in observed behavior), distinct from an assertion being absent.
 * Everything else is an evidence/QA-authoring deficiency that re-running implement/verify can never
 * satisfy — a missing recording or trace, a scenario that never ran, a behavioral claim with no
 * *authored* strong assertion, or evidence not tied to the candidate SHA — so it escalates to a
 * human `qa-inconclusive` gate rather than looping into implement.
 */
export function classifyExerciseBlock(ctx: ExerciseContext): ExerciseBlockKind {
  const codeFixable = ctx.policyBlockingErrorsPresent || !ctx.structuredAssertionsPass;
  return codeFixable ? 'code-fixable' : 'evidence-deficiency';
}

/**
 * The only function permitted to decide a TaskPhase is complete. Pure and deterministic: given
 * the same CompletionCandidate and CompletionContext, always returns the same CompletionDecision.
 * Agents never call this — the Workflow does, after receiving a "candidate" PhaseAttemptResult.
 */
export function evaluatePhaseCompletion(
  candidate: CompletionCandidate,
  context: CompletionContext,
): CompletionDecision {
  switch (candidate.phase) {
    case 'specify':
      return evaluateSpecify(context.specify);
    case 'plan':
      return evaluatePlan(context.plan);
    case 'program-design':
      return evaluateProgramDesign(context.programDesign);
    case 'prepare':
      return evaluatePrepare(context.prepare);
    case 'implement':
      return evaluateImplement(context.implement);
    case 'verify':
      return evaluateVerify(context.verify);
    case 'exercise':
      return evaluateExercise(context.exercise);
    case 'challenge':
      return evaluateChallenge(context.challenge);
    case 'release':
      return evaluateRelease(context.release);
    case 'assimilate':
      return evaluateAssimilate(context.assimilate);
  }
}
