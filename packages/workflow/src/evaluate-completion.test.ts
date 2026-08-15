import { describe, expect, it } from 'vitest';
import { classifyExerciseBlock, evaluatePhaseCompletion } from './evaluate-completion.js';
import type { CompletionContext } from './completion-context.js';
import type { CompletionCandidate } from '@awb/domain';

function candidateFor(phase: CompletionCandidate['phase']): CompletionCandidate {
  return {
    phase,
    phaseAttemptId: 'attempt-1',
    repositorySnapshotId: 'snapshot-1',
    contractVersion: 1,
    planVersion: 1,
    policyVersion: 'v1',
    evidenceIds: [],
    openFindingIds: [],
    artifactManifestHash: 'deadbeef',
  };
}

describe('evaluatePhaseCompletion — specify', () => {
  const completeContext: CompletionContext = {
    specify: {
      objectiveNonEmpty: true,
      claimCount: 1,
      everyClaimHasEvidenceRequirements: true,
      constraintsArrayPresent: true,
      nonGoalsArrayPresent: true,
      noUnresolvedAmbiguity: true,
      problemStatementPresent: true,
      contractStatus: 'approved',
    },
  };

  it('is complete when every criterion holds', () => {
    const result = evaluatePhaseCompletion(candidateFor('specify'), completeContext);
    expect(result.complete).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('is not complete when the objective is empty', () => {
    const ctx: CompletionContext = {
      specify: { ...completeContext.specify!, objectiveNonEmpty: false },
    };
    const result = evaluatePhaseCompletion(candidateFor('specify'), ctx);
    expect(result.complete).toBe(false);
    expect(result.missing).toContain('objective is empty');
  });

  it('is not complete with zero acceptance claims', () => {
    const ctx: CompletionContext = { specify: { ...completeContext.specify!, claimCount: 0 } };
    expect(evaluatePhaseCompletion(candidateFor('specify'), ctx).complete).toBe(false);
  });

  it('is not complete without human contract approval', () => {
    const ctx: CompletionContext = {
      specify: { ...completeContext.specify!, contractStatus: 'awaiting_approval' },
    };
    expect(evaluatePhaseCompletion(candidateFor('specify'), ctx).complete).toBe(false);
  });

  it('is not complete with unresolved ambiguity', () => {
    const ctx: CompletionContext = {
      specify: { ...completeContext.specify!, noUnresolvedAmbiguity: false },
    };
    expect(evaluatePhaseCompletion(candidateFor('specify'), ctx).complete).toBe(false);
  });

  it('is not complete when the problem statement is empty', () => {
    const ctx: CompletionContext = {
      specify: { ...completeContext.specify!, problemStatementPresent: false },
    };
    const result = evaluatePhaseCompletion(candidateFor('specify'), ctx);
    expect(result.complete).toBe(false);
    expect(result.missing).toContain('problem statement is empty');
  });
});

describe('evaluatePhaseCompletion — plan', () => {
  const completeContext: CompletionContext = {
    plan: {
      everyClaimMappedToSlice: true,
      everyBehavioralClaimHasQaScenario: true,
      everySliceHasTargetedChecks: true,
      criticBlockerOrHighFindingCount: 0,
      isHighRisk: false,
      planStatus: 'accepted',
      humanApprovedHighRiskPlan: false,
    },
  };

  it('is complete when every criterion holds and risk is low', () => {
    expect(evaluatePhaseCompletion(candidateFor('plan'), completeContext).complete).toBe(true);
  });

  it('is not complete when a claim has no plan slice', () => {
    const ctx: CompletionContext = { plan: { ...completeContext.plan!, everyClaimMappedToSlice: false } };
    expect(evaluatePhaseCompletion(candidateFor('plan'), ctx).complete).toBe(false);
  });

  it('is not complete when the critic has open blocker findings', () => {
    const ctx: CompletionContext = {
      plan: { ...completeContext.plan!, criticBlockerOrHighFindingCount: 2 },
    };
    const result = evaluatePhaseCompletion(candidateFor('plan'), ctx);
    expect(result.complete).toBe(false);
    expect(result.missing.some((m) => m.includes('2 blocker/high'))).toBe(true);
  });

  it('is not complete for a high-risk plan without human approval', () => {
    const ctx: CompletionContext = {
      plan: { ...completeContext.plan!, isHighRisk: true, humanApprovedHighRiskPlan: false },
    };
    expect(evaluatePhaseCompletion(candidateFor('plan'), ctx).complete).toBe(false);
  });

  it('is complete for a high-risk plan WITH human approval', () => {
    const ctx: CompletionContext = {
      plan: { ...completeContext.plan!, isHighRisk: true, humanApprovedHighRiskPlan: true },
    };
    expect(evaluatePhaseCompletion(candidateFor('plan'), ctx).complete).toBe(true);
  });
});

describe('evaluatePhaseCompletion — program-design (TASK-52)', () => {
  const completeContext: CompletionContext = {
    programDesign: {
      artifactExists: true,
      fileTreeDiffNonEmpty: true,
      hasSignatures: true,
      signaturesAreBodyless: true,
      designAccepted: true,
    },
  };

  it('clears with a file-tree diff, bodyless signatures, and acceptance', () => {
    expect(evaluatePhaseCompletion(candidateFor('program-design'), completeContext).complete).toBe(true);
  });

  it('does not clear when the file-tree diff is empty', () => {
    const ctx: CompletionContext = {
      programDesign: { ...completeContext.programDesign!, fileTreeDiffNonEmpty: false },
    };
    const result = evaluatePhaseCompletion(candidateFor('program-design'), ctx);
    expect(result.complete).toBe(false);
    expect(result.missing).toContain('projected file-tree diff is empty');
  });

  it('does not clear when there are no signatures', () => {
    const ctx: CompletionContext = {
      programDesign: { ...completeContext.programDesign!, hasSignatures: false },
    };
    expect(evaluatePhaseCompletion(candidateFor('program-design'), ctx).complete).toBe(false);
  });

  it('does not clear when signatures leak implementation bodies', () => {
    const ctx: CompletionContext = {
      programDesign: { ...completeContext.programDesign!, signaturesAreBodyless: false },
    };
    expect(evaluatePhaseCompletion(candidateFor('program-design'), ctx).complete).toBe(false);
  });

  it('does not clear until the design is accepted', () => {
    const ctx: CompletionContext = {
      programDesign: { ...completeContext.programDesign!, designAccepted: false },
    };
    expect(evaluatePhaseCompletion(candidateFor('program-design'), ctx).complete).toBe(false);
  });
});

describe('evaluatePhaseCompletion — prepare', () => {
  const completeContext: CompletionContext = {
    prepare: {
      baseShaRecorded: true,
      worktreeExists: true,
      branchExists: true,
      executionProfileApproved: true,
      dependenciesPrepared: true,
      baselineCommandsAttempted: true,
      preExistingFailuresClassified: true,
      leaseActive: true,
    },
  };

  it('is complete when everything is ready', () => {
    expect(evaluatePhaseCompletion(candidateFor('prepare'), completeContext).complete).toBe(true);
  });

  it.each([
    'baseShaRecorded',
    'worktreeExists',
    'branchExists',
    'executionProfileApproved',
    'dependenciesPrepared',
    'baselineCommandsAttempted',
    'preExistingFailuresClassified',
    'leaseActive',
  ] as const)('is not complete when %s is false', (field) => {
    const ctx: CompletionContext = { prepare: { ...completeContext.prepare!, [field]: false } };
    expect(evaluatePhaseCompletion(candidateFor('prepare'), ctx).complete).toBe(false);
  });
});

describe('evaluatePhaseCompletion — implement', () => {
  const completeContext: CompletionContext = {
    implement: {
      everySliceAccountedFor: true,
      candidateCommitExists: true,
      targetedChecksPass: true,
      builderBlockerOpen: false,
      diffWithinApprovedScope: true,
    },
  };

  it('is complete when every criterion holds', () => {
    expect(evaluatePhaseCompletion(candidateFor('implement'), completeContext).complete).toBe(true);
  });

  it('is not complete when a builder blocker is open', () => {
    const ctx: CompletionContext = { implement: { ...completeContext.implement!, builderBlockerOpen: true } };
    expect(evaluatePhaseCompletion(candidateFor('implement'), ctx).complete).toBe(false);
  });

  it('is not complete when the diff exceeds approved scope', () => {
    const ctx: CompletionContext = {
      implement: { ...completeContext.implement!, diffWithinApprovedScope: false },
    };
    expect(evaluatePhaseCompletion(candidateFor('implement'), ctx).complete).toBe(false);
  });
});

describe('evaluatePhaseCompletion — verify', () => {
  const completeContext: CompletionContext = {
    verify: {
      allRequiredCommandsPass: true,
      resultsTiedToCandidateSha: true,
      resultsTiedToEnvironmentDigest: true,
      anyResultStale: false,
      waiversAreHumanApprovedAndShaScoped: true,
    },
  };

  it('is complete when all required commands pass with fresh, correctly-scoped results', () => {
    expect(evaluatePhaseCompletion(candidateFor('verify'), completeContext).complete).toBe(true);
  });

  it('is not complete when a required command fails', () => {
    const ctx: CompletionContext = { verify: { ...completeContext.verify!, allRequiredCommandsPass: false } };
    expect(evaluatePhaseCompletion(candidateFor('verify'), ctx).complete).toBe(false);
  });

  it('is not complete when a result is stale', () => {
    const ctx: CompletionContext = { verify: { ...completeContext.verify!, anyResultStale: true } };
    expect(evaluatePhaseCompletion(candidateFor('verify'), ctx).complete).toBe(false);
  });

  it('is not complete when a waiver is not human-approved and SHA-scoped', () => {
    const ctx: CompletionContext = {
      verify: { ...completeContext.verify!, waiversAreHumanApprovedAndShaScoped: false },
    };
    expect(evaluatePhaseCompletion(candidateFor('verify'), ctx).complete).toBe(false);
  });
});

describe('evaluatePhaseCompletion — exercise', () => {
  const completeContext: CompletionContext = {
    exercise: {
      everyRequiredScenarioHasResult: true,
      everyBehavioralClaimCovered: true,
      structuredAssertionsPass: true,
      requiredRecordingExists: true,
      browserScenariosHaveTraces: true,
      evidenceTiedToCandidateSha: true,
      policyBlockingErrorsPresent: false,
    },
  };

  it('is complete when every QA requirement holds', () => {
    expect(evaluatePhaseCompletion(candidateFor('exercise'), completeContext).complete).toBe(true);
  });

  it('is not complete when a recording is missing even if assertions pass (video alone never passes QA)', () => {
    const ctx: CompletionContext = {
      exercise: { ...completeContext.exercise!, requiredRecordingExists: false },
    };
    expect(evaluatePhaseCompletion(candidateFor('exercise'), ctx).complete).toBe(false);
  });

  it('is not complete when structured assertions fail even if a recording exists', () => {
    const ctx: CompletionContext = {
      exercise: { ...completeContext.exercise!, structuredAssertionsPass: false },
    };
    expect(evaluatePhaseCompletion(candidateFor('exercise'), ctx).complete).toBe(false);
  });

  it('is not complete when a policy-blocking error is present', () => {
    const ctx: CompletionContext = {
      exercise: { ...completeContext.exercise!, policyBlockingErrorsPresent: true },
    };
    expect(evaluatePhaseCompletion(candidateFor('exercise'), ctx).complete).toBe(false);
  });

  // A behavioral claim covered only by liveness assertions must not clear the gate.
  it('is not complete when a behavioral claim lacks a strong assertion', () => {
    const ctx: CompletionContext = {
      exercise: { ...completeContext.exercise!, behavioralClaimsMissingStrongAssertion: ['claim-1'] },
    };
    const result = evaluatePhaseCompletion(candidateFor('exercise'), ctx);
    expect(result.complete).toBe(false);
    expect(result.missing.some((m) => m.includes('state-transition/value assertion'))).toBe(true);
  });

  it('stays complete when no behavioral claim is missing a strong assertion (empty list)', () => {
    const ctx: CompletionContext = {
      exercise: { ...completeContext.exercise!, behavioralClaimsMissingStrongAssertion: [] },
    };
    expect(evaluatePhaseCompletion(candidateFor('exercise'), ctx).complete).toBe(true);
  });
});

// TASK-75: a blocked exercise gate must route by whether re-coding can fix it. Only a real
// runtime error (policyBlockingErrorsPresent) is code-fixable; every other deficiency is an
// evidence/QA-authoring gap that looping implement/verify can never satisfy.
describe('classifyExerciseBlock (TASK-75)', () => {
  const base: NonNullable<CompletionContext['exercise']> = {
    everyRequiredScenarioHasResult: true,
    everyBehavioralClaimCovered: true,
    structuredAssertionsPass: true,
    requiredRecordingExists: true,
    browserScenariosHaveTraces: true,
    evidenceTiedToCandidateSha: true,
    policyBlockingErrorsPresent: false,
  };

  // A real observed failure — a policy-blocking error, or a structured assertion that ran and
  // failed — is a defect the builder can fix by re-coding.
  it.each([
    ['a policy-blocking runtime error', { policyBlockingErrorsPresent: true }],
    ['a structured assertion that ran and failed', { structuredAssertionsPass: false }],
  ])('classifies %s as code-fixable', (_label, override) => {
    expect(classifyExerciseBlock({ ...base, ...override })).toBe('code-fixable');
  });

  // Missing/insufficient evidence with no observed failure — re-running implement/verify cannot
  // manufacture a recording/trace or author a QA assertion, so it must escalate to a human.
  it.each([
    ['missing recording', { requiredRecordingExists: false }],
    ['missing browser trace', { browserScenariosHaveTraces: false }],
    ['a required scenario has no result', { everyRequiredScenarioHasResult: false }],
    ['a behavioral claim is uncovered', { everyBehavioralClaimCovered: false }],
    ['a claim lacks an authored strong assertion', { behavioralClaimsMissingStrongAssertion: ['claim-1'] }],
    ['evidence not tied to candidate SHA', { evidenceTiedToCandidateSha: false }],
  ])('classifies %s as an evidence-deficiency (re-coding cannot fix it)', (_label, override) => {
    expect(classifyExerciseBlock({ ...base, ...override })).toBe('evidence-deficiency');
  });

  it('treats a real failing assertion as code-fixable even when evidence gaps also exist', () => {
    expect(
      classifyExerciseBlock({
        ...base,
        structuredAssertionsPass: false,
        requiredRecordingExists: false,
        behavioralClaimsMissingStrongAssertion: ['claim-1'],
      }),
    ).toBe('code-fixable');
  });
});

describe('evaluatePhaseCompletion — challenge', () => {
  const completeContext: CompletionContext = {
    challenge: {
      reviewerSessionDiffersFromBuilder: true,
      blockerOrHighFindingOpen: false,
      everyFindingResolvedInvalidatedOrWaived: true,
      reviewerExaminedAllRequiredInputs: true,
    },
  };

  it('is complete when review is independent and clean', () => {
    expect(evaluatePhaseCompletion(candidateFor('challenge'), completeContext).complete).toBe(true);
  });

  it('is not complete when the reviewer session is the same as the builder session', () => {
    const ctx: CompletionContext = {
      challenge: { ...completeContext.challenge!, reviewerSessionDiffersFromBuilder: false },
    };
    expect(evaluatePhaseCompletion(candidateFor('challenge'), ctx).complete).toBe(false);
  });

  it('is not complete when a blocker finding remains open', () => {
    const ctx: CompletionContext = {
      challenge: { ...completeContext.challenge!, blockerOrHighFindingOpen: true },
    };
    expect(evaluatePhaseCompletion(candidateFor('challenge'), ctx).complete).toBe(false);
  });
});

describe('evaluatePhaseCompletion — release', () => {
  const completeContext: CompletionContext = {
    release: {
      targetBranchFetched: true,
      candidateReconciledWithTarget: true,
      evidenceAppliesToFinalCandidate: true,
      branchPushed: true,
      draftPrExists: true,
      evidenceMatrixPosted: true,
      requiredVideosUploaded: true,
      prReferencesFinalCandidateSha: true,
    },
  };

  it('is complete when delivery is fully done', () => {
    expect(evaluatePhaseCompletion(candidateFor('release'), completeContext).complete).toBe(true);
  });

  it('is not complete when required QA videos are not uploaded', () => {
    const ctx: CompletionContext = {
      release: { ...completeContext.release!, requiredVideosUploaded: false },
    };
    expect(evaluatePhaseCompletion(candidateFor('release'), ctx).complete).toBe(false);
  });

  it('is not complete when the draft PR does not reference the final candidate SHA', () => {
    const ctx: CompletionContext = {
      release: { ...completeContext.release!, prReferencesFinalCandidateSha: false },
    };
    expect(evaluatePhaseCompletion(candidateFor('release'), ctx).complete).toBe(false);
  });
});

describe('evaluatePhaseCompletion — assimilate', () => {
  const mergedContext: CompletionContext = {
    assimilate: {
      prMerged: true,
      prClosed: false,
      prAbandoned: false,
      memoryRefreshedFromMergeCommit: true,
      processesStopped: true,
      worktreeRemovedOrPreserved: true,
      retentionPolicyApplied: true,
    },
  };

  it('is complete when merged and memory was refreshed', () => {
    expect(evaluatePhaseCompletion(candidateFor('assimilate'), mergedContext).complete).toBe(true);
  });

  it('is complete when closed without merge and memory was NOT refreshed', () => {
    const ctx: CompletionContext = {
      assimilate: {
        ...mergedContext.assimilate!,
        prMerged: false,
        prClosed: true,
        memoryRefreshedFromMergeCommit: false,
      },
    };
    expect(evaluatePhaseCompletion(candidateFor('assimilate'), ctx).complete).toBe(true);
  });

  it('is not complete when merged but memory was not refreshed', () => {
    const ctx: CompletionContext = {
      assimilate: { ...mergedContext.assimilate!, memoryRefreshedFromMergeCommit: false },
    };
    expect(evaluatePhaseCompletion(candidateFor('assimilate'), ctx).complete).toBe(false);
  });

  it('is not complete when NOT merged but memory was refreshed anyway (facts must not be promoted)', () => {
    const ctx: CompletionContext = {
      assimilate: {
        ...mergedContext.assimilate!,
        prMerged: false,
        prClosed: true,
        memoryRefreshedFromMergeCommit: true,
      },
    };
    expect(evaluatePhaseCompletion(candidateFor('assimilate'), ctx).complete).toBe(false);
  });

  it('is not complete when the PR has reached no terminal state at all', () => {
    const ctx: CompletionContext = {
      assimilate: {
        ...mergedContext.assimilate!,
        prMerged: false,
        prClosed: false,
        prAbandoned: false,
        memoryRefreshedFromMergeCommit: false,
      },
    };
    expect(evaluatePhaseCompletion(candidateFor('assimilate'), ctx).complete).toBe(false);
  });

  it('is not complete when the worktree is neither removed nor preserved', () => {
    const ctx: CompletionContext = {
      assimilate: { ...mergedContext.assimilate!, worktreeRemovedOrPreserved: false },
    };
    expect(evaluatePhaseCompletion(candidateFor('assimilate'), ctx).complete).toBe(false);
  });
});

describe('evaluatePhaseCompletion — missing context', () => {
  it('is not complete when no context is provided for the candidate phase', () => {
    const result = evaluatePhaseCompletion(candidateFor('verify'), {});
    expect(result.complete).toBe(false);
    expect(result.missing).toContain('no verify context provided');
  });
});
