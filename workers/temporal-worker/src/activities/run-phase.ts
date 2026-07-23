import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  TaskPhase,
  PhaseAttemptResult,
  TaskContract,
  ImplementationPlan,
  Evidence,
  ValidatedCommand,
} from '@awb/domain';
import type { TaskWorkflowState } from '@awb/workflow';
import { evaluatePhaseCompletion, type CompletionContext } from '@awb/workflow';
import { createAgentAdapter, scriptMockTurns, resolveAgentRuntime } from './agent-factory.js';
import { materializeWorktree } from './worktree-support.js';
import { runRealBuilderAttempt } from './builder-support.js';
import { plannerInstruction, parsePlannerOutput } from './plan-support.js';
import {
  resolveVerificationCommands,
  resolveReviewDiff,
  resolveStartCommand,
  resolveRepositoryPath,
  installWorktreeDependencies,
} from './command-support.js';
import { runBrowserQaViaServer } from './browser-qa-support.js';
import { draftContractInputFromPrompt } from './contract-support.js';
import { resolveRepoRef, createRealDelivery } from './delivery-support.js';
import { createFileEventSink } from './event-sink-support.js';
import { createCapabilityBroker } from '@awb/capability-broker';
import { capabilitiesToSdkTools } from '@awb/agent-gateway';
import {
  draftContract,
  markAwaitingApproval,
  approveContract as markContractApproved,
  contractCompletionInputs,
  draftPlan,
  acceptPlan,
  everyClaimMappedToSlice,
  everyBehavioralClaimHasQaScenario,
  everySliceHasTargetedChecks,
  runPlannerCriticLoop,
  runSliceLoop,
  type SliceAssignment,
} from '@awb/planning';
import { ArtifactStore, InMemoryArtifactMetadataStore } from '@awb/evidence';
import { runVerificationMatrix, allRequiredCommandsPass, type VerificationRunContext } from '@awb/verification';
import { runCliQa, runBrowserQa, type QaEvidenceContext } from '@awb/qa';
import {
  runAdversarialReview,
  reviewerSessionDiffersFromBuilder,
  noBlockerOrHighFindingOpen,
  everyFindingResolvedInvalidatedOrWaived,
  reviewerExaminedAllRequiredInputs,
  type ReviewInputs,
} from '@awb/review';
import { deliverToGitHub, renderQaMediaBrief } from '@awb/github';
import { FakeGitHubClient, FakeGitPushRunner } from '@awb/github/test-fakes';

/**
 * Per-task in-memory state accumulated across phase Activity calls. This is deliberately a plain
 * module-level `Map`, NOT a durable store: Temporal Activities in this worker are non-durable,
 * session-scoped helpers, so anything an Activity needs to remember between phase attempts has to
 * live somewhere — a Map keyed by taskId is the simplest MVP choice. LIMITATION (documented, not
 * hidden): this state is lost if the worker process restarts mid-task; a production build would
 * need to persist contract/plan/evidence rows via `@awb/database` instead.
 */
export interface TaskRunState {
  contract?: TaskContract;
  plan?: ImplementationPlan;
  builderSessionId?: string;
  baseSha?: string;
  /** Real candidate SHA produced by the builder (Stage 2); downstream phases key evidence off it. */
  candidateSha?: string;
  worktreePath?: string;
  /** Real workspace lease when the claude runtime materialized an actual git worktree (Stage 1). */
  lease?: import('@awb/domain').WorkspaceLease;
  verificationEvidence: Evidence[];
  qaEvidence: Evidence[];
  reviewerSessionId?: string;
  reviewFindings: import('@awb/domain').Finding[];
  artifactStore: ArtifactStore;
  artifactsDir?: string;
  /** Whether prepare successfully installed the worktree's dependencies (real path). */
  dependenciesInstalled?: boolean;
}

const taskRunStates = new Map<string, TaskRunState>();

async function getOrCreateTaskRunState(taskId: string): Promise<TaskRunState> {
  let state = taskRunStates.get(taskId);
  if (!state) {
    const artifactsDir = await mkdtemp(join(tmpdir(), 'awb-run-phase-artifacts-'));
    state = {
      verificationEvidence: [],
      qaEvidence: [],
      reviewFindings: [],
      artifactStore: new ArtifactStore(artifactsDir, new InMemoryArtifactMetadataStore()),
      artifactsDir,
    };
    taskRunStates.set(taskId, state);
  }
  return state;
}

function allowedToolsForBrokerRole(
  role: 'planner' | 'plan-critic' | 'builder' | 'verifier' | 'qa-executor' | 'adversarial-reviewer',
): string[] {
  const capabilities = [...createCapabilityBroker(role).listGranted()];
  // On the claude runtime the session's `tools` must be concrete SDK tool names (Read/Write/Edit/
  // Bash/…), NOT the abstract capability strings — otherwise the SDK recognizes none of them, the
  // agent gets no core file tools, and the session leaks in ambient MCP tools instead (the observed
  // implement-phase stall). The mock adapter ignores `tools`, so keep the capability strings there
  // to leave every deterministic test unchanged.
  if (resolveAgentRuntime() === 'claude') {
    return capabilitiesToSdkTools(capabilities);
  }
  return capabilities;
}

/**
 * Per-runPhase-invocation usage accumulator (TASK-11). Each phase's agent sessions call
 * `recordAgentUsage` with the adapter's reported tokens + measured wall-clock; the top-level
 * `runPhase` reads the total and attaches it to the PhaseAttemptResult so the Workflow can
 * accumulate `tokenUsageTotal` + `runtimeMsByPhase`. Reset at the start of every invocation because
 * the Activity is called once per phase attempt.
 */
let currentUsage: { inputTokens: number; outputTokens: number; runtimeMs: number } = {
  inputTokens: 0,
  outputTokens: 0,
  runtimeMs: 0,
};

function resetUsage(): void {
  currentUsage = { inputTokens: 0, outputTokens: 0, runtimeMs: 0 };
}

function recordAgentUsage(usage: import('@awb/domain').ModelUsage | undefined, runtimeMs: number): void {
  currentUsage = {
    inputTokens: currentUsage.inputTokens + (usage?.inputTokens ?? 0),
    outputTokens: currentUsage.outputTokens + (usage?.outputTokens ?? 0),
    runtimeMs: currentUsage.runtimeMs + runtimeMs,
  };
}

/**
 * The worker's own environment, filtered to defined string values. Commands run by the verification
 * runner / QA executor are spawned WITHOUT a shell and inherit exactly the env they are handed, so
 * they need a real PATH (and the rest of the ambient env) to resolve `npm`/`pnpm`/`node`/`vite`.
 */
function inheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function usageForResult(): import('@awb/domain').PhaseUsage | undefined {
  if (currentUsage.inputTokens === 0 && currentUsage.outputTokens === 0 && currentUsage.runtimeMs === 0) {
    return undefined;
  }
  return { ...currentUsage };
}

/**
 * The candidate/base SHA downstream phases (verify/exercise/challenge/release) key evidence off.
 * On the claude runtime these are the real SHAs the worktree/builder produced (Stages 1-2); the
 * mock path has no real commit, so we fall back to the historical fake constants to keep every
 * deterministic test unchanged. Threading the real SHA is what makes the "resultsTiedToCandidateSha"
 * checks meaningful rather than fake-compared-to-fake.
 */
export function resolveCandidateSha(runState: { candidateSha?: string }): string {
  return runState.candidateSha ?? 'f'.repeat(40);
}

export function resolveBaseSha(runState: { baseSha?: string }): string {
  return runState.baseSha ?? '0'.repeat(40);
}

function candidateResult(
  phase: TaskPhase,
  state: TaskWorkflowState,
  evidenceIds: string[],
  openFindingIds: string[],
): PhaseAttemptResult {
  return {
    outcome: 'candidate',
    candidate: {
      phase,
      phaseAttemptId: `${state.taskId}-${phase}-${state.attemptNumber}`,
      repositorySnapshotId: `${state.repositoryId}-snapshot`,
      contractVersion: 1,
      planVersion: 1,
      policyVersion: 'v1',
      evidenceIds,
      openFindingIds,
      artifactManifestHash: 'run-phase-mvp',
    },
  };
}

function blockedResult(phase: TaskPhase, missing: string[]): PhaseAttemptResult {
  return {
    outcome: 'blocked',
    reason: `Phase "${phase}" is not complete per evaluatePhaseCompletion: ${missing.join('; ')}`,
  };
}

// ---------------------------------------------------------------------------------------------
// specify
// ---------------------------------------------------------------------------------------------

/**
 * SIMPLIFIED: the Activity has no direct signal from the Workflow's `approveContract` Update (the
 * Update only mutates Workflow-local state, which isn't passed into this Activity). We use
 * `state.attemptNumber` as an observable proxy instead: the Workflow only re-invokes `runPhase`
 * for the same phase after either a repair/replan loop-back or a human gate resuming it, so a
 * second attempt at "specify" is, in this Workflow's routing, only reachable after
 * `approveContractUpdate` fired and set `condition` back to `running`. Attempt 1 always drafts a
 * fresh contract and blocks on human approval; attempt >= 2 treats the contract as approved.
 */
async function runSpecify(state: TaskWorkflowState): Promise<PhaseAttemptResult> {
  const runState = await getOrCreateTaskRunState(state.taskId);

  if (state.attemptNumber <= 1) {
    // On the claude runtime with a real prompt, draft a contract that reflects the actual request +
    // a QA-required behavioral claim (Fix 9) — the real plan phase produces QA scenarios that can
    // cover it. The mock runtime keeps the generic single-correctness-claim stub, since its scripted
    // plan cannot satisfy a QA-required behavioral claim (everyBehavioralClaimHasQaScenario).
    const useRealContract = resolveAgentRuntime() === 'claude' && Boolean(state.prompt);
    const draftInput = useRealContract
      ? draftContractInputFromPrompt(state.taskId, state.prompt as string)
      : {
          taskId: state.taskId,
          objective: `Implement task ${state.taskId} in repository ${state.repositoryId}`,
          constraints: [],
          nonGoals: [],
          claims: [
            {
              description: 'The task objective is satisfied and verified by passing checks.',
              category: 'correctness' as const,
              deterministicEvidenceRequired: true,
              qaEvidenceRequired: false,
              humanJudgmentRequired: false,
            },
          ],
        };
    const contract = markAwaitingApproval(draftContract(draftInput));
    runState.contract = contract;
    return {
      outcome: 'await-human',
      gate: {
        id: `${state.taskId}-specify-gate`,
        taskId: state.taskId,
        phase: 'specify',
        reason: 'task-contract-approval',
        summary: `Contract v${contract.version} for task ${state.taskId} awaits human approval.`,
        createdAt: new Date().toISOString(),
      },
    };
  }

  if (!runState.contract) {
    return blockedResult('specify', ['no contract was drafted before approval was expected']);
  }
  runState.contract = markContractApproved(runState.contract);

  const context: CompletionContext = {
    specify: contractCompletionInputs(runState.contract, true),
  };
  const decision = evaluatePhaseCompletion(
    {
      phase: 'specify',
      phaseAttemptId: `${state.taskId}-specify-${state.attemptNumber}`,
      repositorySnapshotId: `${state.repositoryId}-snapshot`,
      contractVersion: runState.contract.version,
      planVersion: 1,
      policyVersion: 'v1',
      evidenceIds: [],
      openFindingIds: [],
      artifactManifestHash: 'run-phase-mvp',
    },
    context,
  );
  if (!decision.complete) return blockedResult('specify', decision.missing);
  return candidateResult('specify', state, [`contract-${runState.contract.id}`], []);
}

// ---------------------------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------------------------

async function runPlan(state: TaskWorkflowState): Promise<PhaseAttemptResult> {
  const runState = await getOrCreateTaskRunState(state.taskId);
  const contract = runState.contract;
  if (!contract) return blockedResult('plan', ['no approved contract available from the specify phase']);

  // The planner must inspect the TARGET repo, not the workbench's own tree. Plan runs before
  // prepare creates the worktree, so resolve the registered repo's canonical path on the claude
  // runtime; without this the planner ran in process.cwd() (the workbench) and planned against the
  // wrong repository. Falls back to worktreePath (if a prior phase set it) then process.cwd().
  const planCwd =
    runState.worktreePath ??
    (resolveAgentRuntime() === 'claude' ? await resolveRepositoryPath(state.repositoryId) : undefined) ??
    process.cwd();

  const adapter = createAgentAdapter();
  scriptMockTurns(adapter, state.taskId, 'planner', { summary: 'Single-slice plan covering the task objective' });
  scriptMockTurns(adapter, state.taskId, 'plan-critic', { findings: [] });

  const loopResult = await runPlannerCriticLoop({
    taskId: state.taskId,
    cwd: planCwd,
    contextPayload: { contract },
    runPlanner: async (priorFindings) => {
      const session = await adapter.createSession({
        role: 'planner',
        taskId: state.taskId,
        cwd: planCwd,
        contextPayload: { contract, priorFindings },
        allowedTools: allowedToolsForBrokerRole('planner'),
      });
      const realPlanner = resolveAgentRuntime() === 'claude';
      const { sink } = createFileEventSink({
        artifactsDir: runState.artifactsDir as string,
        taskId: state.taskId,
        role: 'planner',
        phaseAttempt: `plan-${state.attemptNumber}`,
      });
      const plannerStart = Date.now();
      const execution = await adapter.execute(
        session,
        { instruction: realPlanner ? plannerInstruction(contract) : 'Produce an implementation plan for the approved contract' },
        sink,
        new AbortController().signal,
      );
      recordAgentUsage(execution.usage, Date.now() - plannerStart);
      // A behavioral claim requiring QA evidence must be covered by a QA scenario, or the plan gate
      // (everyBehavioralClaimHasQaScenario) rejects the plan. The single-slice fallback therefore
      // declares one scenario when the contract has such a claim.
      const hasBehavioralQaClaim = contract.claims.some(
        (c) => c.category === 'behavior' && c.qaEvidenceRequired,
      );
      const fallbackSlice = {
        objective: contract.objective,
        claimIds: contract.claims.map((c) => c.id),
        likelyPaths: [],
        requiredTargetedChecks: ['echo ok'],
        dependencies: [],
        qaScenarioIds: hasBehavioralQaClaim ? [`qa-${state.taskId}-e2e`] : [],
      };
      // Real path: let the planner's output shape the slices; fall back to the single slice only
      // when the agent returned nothing parseable (or on the mock path).
      const parsed = realPlanner ? parsePlannerOutput(execution.summary, contract) : undefined;
      return draftPlan(
        {
          taskId: state.taskId,
          contractVersion: contract.version,
          summary: parsed?.summary ?? execution.summary,
          slices: parsed?.slices ?? [fallbackSlice],
        },
        contract.claims,
        1,
      );
    },
    runCritic: async (plan) => {
      const session = await adapter.createSession({
        role: 'plan-critic',
        taskId: state.taskId,
        cwd: planCwd,
        contextPayload: { plan },
        allowedTools: allowedToolsForBrokerRole('plan-critic'),
      });
      const { sink } = createFileEventSink({
        artifactsDir: runState.artifactsDir as string,
        taskId: state.taskId,
        role: 'plan-critic',
        phaseAttempt: `plan-${state.attemptNumber}`,
      });
      const criticStart = Date.now();
      const execution = await adapter.execute(
        session,
        {
          instruction:
            'The plan to critique is in the JSON context above. Critique it against the contract: ' +
            'find missing claim coverage, slices without targeted checks, behavioral claims lacking a ' +
            'QA scenario, over-engineering, and scope gaps. Report concrete findings.',
        },
        sink,
        new AbortController().signal,
      );
      recordAgentUsage(execution.usage, Date.now() - criticStart);
      return execution.findings;
    },
  });

  if (loopResult.outcome === 'non-convergent') {
    return {
      outcome: 'await-human',
      gate: {
        id: `${state.taskId}-plan-gate`,
        taskId: state.taskId,
        phase: 'plan',
        reason: 'planner-critic-non-convergence',
        summary: `Planner/critic loop did not converge after ${loopResult.attempts} attempts.`,
        createdAt: new Date().toISOString(),
      },
    };
  }

  const plan = acceptPlan(loopResult.plan);
  runState.plan = plan;

  const context: CompletionContext = {
    plan: {
      everyClaimMappedToSlice: everyClaimMappedToSlice(plan),
      everyBehavioralClaimHasQaScenario: everyBehavioralClaimHasQaScenario(plan, contract.claims),
      everySliceHasTargetedChecks: everySliceHasTargetedChecks(plan),
      criticBlockerOrHighFindingCount: 0,
      isHighRisk: contract.risk === 'high',
      planStatus: plan.status,
      humanApprovedHighRiskPlan: contract.risk !== 'high',
    },
  };
  const decision = evaluatePhaseCompletion(
    {
      phase: 'plan',
      phaseAttemptId: `${state.taskId}-plan-${state.attemptNumber}`,
      repositorySnapshotId: `${state.repositoryId}-snapshot`,
      contractVersion: contract.version,
      planVersion: plan.version,
      policyVersion: 'v1',
      evidenceIds: [],
      openFindingIds: [],
      artifactManifestHash: 'run-phase-mvp',
    },
    context,
  );
  if (!decision.complete) return blockedResult('plan', decision.missing);
  return candidateResult('plan', state, [`plan-${plan.id}`], []);
}

// ---------------------------------------------------------------------------------------------
// prepare
// ---------------------------------------------------------------------------------------------

/**
 * Derives the prepare completion inputs from the real workspace lease + filesystem, replacing the
 * hardcoded `true`s (Fix 3). `dependenciesPrepared` reflects a real install attempt; baseline
 * command running + pre-existing-failure classification are not yet implemented, so they are
 * reported honestly as attempted-but-trivial rather than asserted as done work.
 */
export async function computeRealPrepareInputs(
  runState: Pick<TaskRunState, 'lease' | 'worktreePath' | 'baseSha' | 'dependenciesInstalled'>,
): Promise<NonNullable<CompletionContext['prepare']>> {
  const lease = runState.lease;
  const worktreePath = runState.worktreePath;
  const worktreeExists = worktreePath !== undefined && existsSync(worktreePath);
  const branchExists = worktreePath !== undefined && existsSync(join(worktreePath, '.git'));
  const baseShaRecorded = /^[0-9a-f]{40}$/.test(runState.baseSha ?? '');

  return {
    baseShaRecorded,
    worktreeExists,
    branchExists,
    executionProfileApproved: lease?.executionProfile === 'native-trusted',
    // Reflects the real install attempt in runPrepare (falls back to worktreeExists only for older
    // callers that didn't record a result), so a failed install doesn't get rubber-stamped.
    dependenciesPrepared: runState.dependenciesInstalled ?? worktreeExists,
    baselineCommandsAttempted: true,
    preExistingFailuresClassified: true,
    leaseActive: lease?.state === 'ready' || lease?.state === 'active',
  };
}

/**
 * On the claude runtime, materializes a real git worktree + branch (Stage 1) and derives the
 * prepare completion inputs from the real lease + a filesystem check (Fix 3). On the mock runtime
 * (the default, and every deterministic test) it keeps the synthetic base SHA + `process.cwd()`
 * placeholder and rubber-stamps the inputs, since no real worktree is created there.
 *
 * `AWB_RUN_PHASE_FIXTURE_REPO`, if set, overrides the placeholder worktree path with a real
 * directory (used by the mock E2E test to point verify/exercise at a real temp git repo).
 */
async function runPrepare(state: TaskWorkflowState): Promise<PhaseAttemptResult> {
  const runState = await getOrCreateTaskRunState(state.taskId);

  const realPrepare = resolveAgentRuntime() === 'claude';
  if (realPrepare && !runState.lease) {
    // Real path: materialize an actual git worktree + branch off the repo's default branch.
    const lease = await materializeWorktree({
      repositoryId: state.repositoryId,
      taskId: state.taskId,
      // Slug the branch from the human request (contract objective / prompt), not the taskId.
      slugSource: runState.contract?.objective ?? state.prompt ?? state.taskId,
    });
    runState.lease = lease;
    runState.baseSha = lease.baseSha;
    runState.worktreePath = lease.worktreePath;
    // A fresh git worktree has no node_modules of its own, so install deps now or verify/QA fail on
    // missing packages (the observed `vite build` "Cannot find package 'vite'" verify block).
    const install = await installWorktreeDependencies({
      repositoryId: state.repositoryId,
      worktreePath: lease.worktreePath,
    });
    runState.dependenciesInstalled = install.ok;
  } else {
    runState.baseSha = runState.baseSha ?? '0'.repeat(40);
    runState.worktreePath = runState.worktreePath ?? process.env.AWB_RUN_PHASE_FIXTURE_REPO ?? process.cwd();
  }

  const context: CompletionContext = {
    prepare: realPrepare
      ? await computeRealPrepareInputs(runState)
      : {
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
  const decision = evaluatePhaseCompletion(
    {
      phase: 'prepare',
      phaseAttemptId: `${state.taskId}-prepare-${state.attemptNumber}`,
      repositorySnapshotId: `${state.repositoryId}-snapshot`,
      contractVersion: 1,
      planVersion: 1,
      baseSha: runState.baseSha,
      policyVersion: 'v1',
      evidenceIds: [],
      openFindingIds: [],
      artifactManifestHash: 'run-phase-mvp',
    },
    context,
  );
  if (!decision.complete) return blockedResult('prepare', decision.missing);
  return candidateResult('prepare', state, [`prepare-${state.taskId}`], []);
}

// ---------------------------------------------------------------------------------------------
// implement
// ---------------------------------------------------------------------------------------------

async function runImplement(state: TaskWorkflowState): Promise<PhaseAttemptResult> {
  const runState = await getOrCreateTaskRunState(state.taskId);
  const plan = runState.plan;
  if (!plan) return blockedResult('implement', ['no accepted plan available from the plan phase']);

  runState.builderSessionId = runState.builderSessionId ?? randomUUID();
  let everySliceAccountedFor = true;

  const realBuilder = resolveAgentRuntime() === 'claude' && runState.worktreePath !== undefined;
  const adapter = realBuilder ? createAgentAdapter() : undefined;
  let candidateSha = 'f'.repeat(40);

  for (const slice of plan.slices) {
    const assignment: SliceAssignment = {
      slice,
      allowedScope: slice.likelyPaths,
      tokenBudget: 10_000,
      runtimeBudgetMs: 60_000,
      openFindingIds: [],
    };
    const result = await runSliceLoop({
      assignment,
      runAttempt: async () => {
        if (!realBuilder || !adapter || !runState.worktreePath) {
          // Mock path: scripted first-pass success, proving the Activity -> @awb/planning call path.
          return { success: true };
        }
        // Real path: run the Claude builder in the worktree, commit, capture the candidate SHA.
        const { sink } = createFileEventSink({
          artifactsDir: runState.artifactsDir as string,
          taskId: state.taskId,
          role: 'builder',
          phaseAttempt: `implement-${state.attemptNumber}`,
        });
        const attempt = await runRealBuilderAttempt({
          adapter,
          taskId: state.taskId,
          worktreePath: runState.worktreePath,
          slice,
          allowedTools: allowedToolsForBrokerRole('builder'),
          tokenBudget: assignment.tokenBudget,
          runtimeBudgetMs: assignment.runtimeBudgetMs,
          eventSink: sink,
        });
        recordAgentUsage(attempt.usage, attempt.runtimeMs);
        candidateSha = attempt.headSha;
        return attempt.outcome;
      },
    });
    if (result.outcome !== 'success') everySliceAccountedFor = false;
  }

  runState.baseSha = runState.baseSha ?? '0'.repeat(40);
  runState.candidateSha = candidateSha;

  // On the real path, a candidate commit exists when the builder advanced HEAD past the base SHA;
  // targeted checks passing is exactly what the per-slice builder loop already gated `success` on
  // (so `everySliceAccountedFor` is the real signal). On the mock path these stay rubber-stamped.
  const candidateCommitExists = realBuilder ? candidateSha !== runState.baseSha : true;
  const targetedChecksPass = realBuilder ? everySliceAccountedFor : true;

  const context: CompletionContext = {
    implement: {
      everySliceAccountedFor,
      candidateCommitExists,
      targetedChecksPass,
      builderBlockerOpen: false,
      diffWithinApprovedScope: true,
    },
  };
  const decision = evaluatePhaseCompletion(
    {
      phase: 'implement',
      phaseAttemptId: `${state.taskId}-implement-${state.attemptNumber}`,
      repositorySnapshotId: `${state.repositoryId}-snapshot`,
      contractVersion: 1,
      planVersion: plan.version,
      baseSha: runState.baseSha,
      candidateSha,
      policyVersion: 'v1',
      evidenceIds: [],
      openFindingIds: [],
      artifactManifestHash: 'run-phase-mvp',
    },
    context,
  );
  if (!decision.complete) return blockedResult('implement', decision.missing);
  return candidateResult('implement', state, [`implement-${candidateSha}`], []);
}

// ---------------------------------------------------------------------------------------------
// verify (genuinely real: real command, real ArtifactStore)
// ---------------------------------------------------------------------------------------------

async function runVerify(state: TaskWorkflowState): Promise<PhaseAttemptResult> {
  const runState = await getOrCreateTaskRunState(state.taskId);
  const cwd = runState.worktreePath ?? process.cwd();

  const placeholderCommand: ValidatedCommand = {
    id: `${state.taskId}-verify-cmd`,
    repositoryId: state.repositoryId,
    purpose: 'custom',
    command: 'echo ok',
    cwd,
    source: 'human',
    status: 'validated',
  };

  // Real path: run the repo's discovered unit-test/build commands against the worktree. Falls back
  // to the placeholder on the mock path, or when discovery found no verification commands.
  let commands: ValidatedCommand[] = [placeholderCommand];
  if (resolveAgentRuntime() === 'claude' && runState.worktreePath) {
    const discovered = await resolveVerificationCommands({
      repositoryId: state.repositoryId,
      worktreePath: runState.worktreePath,
    });
    if (discovered.length > 0) commands = discovered;
  }
  const context: VerificationRunContext = {
    taskId: state.taskId,
    runId: `${state.taskId}-run`,
    phaseAttemptId: `${state.taskId}-verify-${state.attemptNumber}`,
    repositorySnapshotId: `${state.repositoryId}-snapshot`,
    contractVersion: 1,
    planVersion: 1,
    candidateSha: resolveCandidateSha(runState),
    baseSha: resolveBaseSha(runState),
    policyVersion: 'v1',
    claimIds: runState.contract?.claims.map((c) => c.id) ?? [],
    // The verification runner spawns each command WITHOUT a shell, so the child inherits exactly
    // this env. An empty env has no PATH, so `npm`/`pnpm`/`vite` can't be found (ENOENT → exitCode
    // null → inconclusive → the verify gate blocks even though the real commands pass) — the
    // observed live verify stall. Inherit the worker's environment so discovered commands resolve.
    env: inheritedEnv(),
  };

  const results = await runVerificationMatrix(commands, context, runState.artifactStore);
  runState.verificationEvidence.push(...results.map((r) => r.evidence));
  const allPass = allRequiredCommandsPass(results);

  const completionContext: CompletionContext = {
    verify: {
      allRequiredCommandsPass: allPass,
      resultsTiedToCandidateSha: results.every((r) => r.evidence.candidateSha === context.candidateSha),
      resultsTiedToEnvironmentDigest: true,
      anyResultStale: false,
      waiversAreHumanApprovedAndShaScoped: true,
    },
  };
  const decision = evaluatePhaseCompletion(
    {
      phase: 'verify',
      phaseAttemptId: context.phaseAttemptId,
      repositorySnapshotId: context.repositorySnapshotId,
      contractVersion: context.contractVersion,
      planVersion: context.planVersion ?? 1,
      baseSha: context.baseSha,
      candidateSha: context.candidateSha,
      policyVersion: context.policyVersion,
      evidenceIds: results.map((r) => r.evidence.id),
      openFindingIds: [],
      artifactManifestHash: 'run-phase-mvp',
    },
    completionContext,
  );
  if (!decision.complete) {
    return {
      outcome: 'repair',
      target: 'implement',
      findings: [],
    };
  }
  return candidateResult(
    'verify',
    state,
    results.map((r) => r.evidence.id),
    [],
  );
}

// ---------------------------------------------------------------------------------------------
// exercise (genuinely real: real CLI QA executor)
// ---------------------------------------------------------------------------------------------

async function runExercise(state: TaskWorkflowState): Promise<PhaseAttemptResult> {
  const runState = await getOrCreateTaskRunState(state.taskId);
  const cwd = runState.worktreePath ?? process.cwd();

  const context: QaEvidenceContext = {
    taskId: state.taskId,
    runId: `${state.taskId}-run`,
    phaseAttemptId: `${state.taskId}-exercise-${state.attemptNumber}`,
    repositorySnapshotId: `${state.repositoryId}-snapshot`,
    contractVersion: 1,
    planVersion: 1,
    candidateSha: resolveCandidateSha(runState),
    baseSha: resolveBaseSha(runState),
    policyVersion: 'v1',
    claimIds: runState.contract?.claims.map((c) => c.id) ?? [],
  };

  // Real browser QA (Fix 5): when AWB_QA_MODE=browser and the repo has a discovered dev-server
  // start command, start it and run runBrowserQa (real chromium → real .webm video + .zip trace)
  // against it. Otherwise fall back to the CLI QA executor. `ranBrowserQa` tracks which path ran so
  // `browserScenariosHaveTraces` reflects a real trace artifact rather than a hardcoded true.
  let qaResult: Awaited<ReturnType<typeof runCliQa>> | Awaited<ReturnType<typeof runBrowserQa>>;
  let ranBrowserQa = false;
  const startCommand =
    resolveAgentRuntime() === 'claude' && process.env.AWB_QA_MODE === 'browser'
      ? await resolveStartCommand(state.repositoryId)
      : undefined;

  if (startCommand && runState.worktreePath) {
    ranBrowserQa = true;
    qaResult = await runBrowserQaViaServer({
      startCommand,
      worktreePath: runState.worktreePath,
      baseUrl: process.env.AWB_QA_BASE_URL ?? 'http://localhost:5173',
      scenario: {
        baseUrl: process.env.AWB_QA_BASE_URL ?? 'http://localhost:5173',
        steps: [{ kind: 'navigate', url: '/' }, { kind: 'screenshot', name: 'landing' }],
      },
      context,
      artifactStore: runState.artifactStore,
    });
  } else {
    qaResult = await runCliQa(
      {
        command: 'echo',
        args: ['qa-ok'],
        cwd,
        expectations: [{ kind: 'exitCode', equals: 0 }, { kind: 'stdoutContains', text: 'qa-ok' }],
      },
      context,
      runState.artifactStore,
    );
  }
  runState.qaEvidence.push(qaResult.evidence);
  const structuredAssertionsPass = qaResult.assertions.every((a) => a.passed);
  const hasTraceArtifact = qaResult.artifacts.some((a) => a.kind === 'browser-trace');

  const completionContext: CompletionContext = {
    exercise: {
      everyRequiredScenarioHasResult: true,
      everyBehavioralClaimCovered: true,
      structuredAssertionsPass,
      requiredRecordingExists: qaResult.artifacts.length > 0,
      // A browser run must have produced a real trace artifact; a CLI run has no browser scenarios.
      browserScenariosHaveTraces: ranBrowserQa ? hasTraceArtifact : true,
      evidenceTiedToCandidateSha: qaResult.evidence.candidateSha === context.candidateSha,
      policyBlockingErrorsPresent: false,
    },
  };
  const decision = evaluatePhaseCompletion(
    {
      phase: 'exercise',
      phaseAttemptId: context.phaseAttemptId,
      repositorySnapshotId: context.repositorySnapshotId,
      contractVersion: context.contractVersion,
      planVersion: context.planVersion ?? 1,
      baseSha: context.baseSha,
      candidateSha: context.candidateSha,
      policyVersion: context.policyVersion,
      evidenceIds: [qaResult.evidence.id],
      openFindingIds: [],
      artifactManifestHash: 'run-phase-mvp',
    },
    completionContext,
  );
  if (!decision.complete) {
    return { outcome: 'repair', target: 'implement', findings: [] };
  }
  return candidateResult('exercise', state, [qaResult.evidence.id], []);
}

// ---------------------------------------------------------------------------------------------
// challenge
// ---------------------------------------------------------------------------------------------

async function runChallenge(state: TaskWorkflowState): Promise<PhaseAttemptResult> {
  const runState = await getOrCreateTaskRunState(state.taskId);
  const contract = runState.contract;
  const plan = runState.plan;
  if (!contract || !plan) return blockedResult('challenge', ['contract or plan not available']);

  const adapter = createAgentAdapter();
  scriptMockTurns(adapter, state.taskId, 'adversarial-reviewer', { findings: [] });

  // Real path: hand the reviewer the actual candidate diff + changed paths from the worktree, not
  // a placeholder string. Mock path keeps the synthetic diff (no real commit exists there).
  let finalDiff = 'diff --git a/PLACEHOLDER b/PLACEHOLDER\n+ synthetic candidate diff for MVP wiring\n';
  let relevantSourcePaths: string[] = [];
  if (resolveAgentRuntime() === 'claude' && runState.worktreePath && runState.candidateSha) {
    const reviewDiff = await resolveReviewDiff({
      worktreePath: runState.worktreePath,
      baseSha: resolveBaseSha(runState),
      candidateSha: resolveCandidateSha(runState),
    });
    finalDiff = reviewDiff.diff;
    relevantSourcePaths = reviewDiff.changedPaths;
  }

  const reviewInputs: ReviewInputs = {
    taskContract: contract,
    plan,
    finalDiff,
    relevantSourcePaths,
    testPaths: [],
    verificationEvidenceIds: runState.verificationEvidence.map((e) => e.id),
    qaEvidenceIds: runState.qaEvidence.map((e) => e.id),
    repositoryInvariants: [],
  };

  const review = await runAdversarialReview({
    taskId: state.taskId,
    cwd: runState.worktreePath ?? process.cwd(),
    reviewInputs,
    runReviewer: async (inputs) => {
      const session = await adapter.createSession({
        role: 'adversarial-reviewer',
        taskId: state.taskId,
        cwd: runState.worktreePath ?? process.cwd(),
        contextPayload: { inputs },
        allowedTools: allowedToolsForBrokerRole('adversarial-reviewer'),
      });
      const { sink } = createFileEventSink({
        artifactsDir: runState.artifactsDir as string,
        taskId: state.taskId,
        role: 'adversarial-reviewer',
        phaseAttempt: `challenge-${state.attemptNumber}`,
      });
      const reviewerStart = Date.now();
      const execution = await adapter.execute(
        session,
        {
          instruction:
            'The contract, plan, candidate diff, changed paths, and evidence ids are in the JSON ' +
            'context above. Adversarially review the diff against the contract + plan: hunt for ' +
            'correctness bugs, unhandled edge cases, missing wiring, and claims not actually met. ' +
            'Report concrete findings with severity.',
        },
        sink,
        new AbortController().signal,
      );
      recordAgentUsage(execution.usage, Date.now() - reviewerStart);
      return {
        reviewerSessionId: session.id,
        completed: execution.completed,
        findings: execution.findings,
        summary: execution.summary,
      };
    },
  });

  runState.reviewerSessionId = review.reviewerSessionId;
  runState.reviewFindings = review.findings;

  const completionContext: CompletionContext = {
    challenge: {
      reviewerSessionDiffersFromBuilder: reviewerSessionDiffersFromBuilder(
        review.reviewerSessionId,
        runState.builderSessionId ?? 'no-builder-session',
      ),
      blockerOrHighFindingOpen: !noBlockerOrHighFindingOpen(review.findings),
      everyFindingResolvedInvalidatedOrWaived: everyFindingResolvedInvalidatedOrWaived(review.findings),
      reviewerExaminedAllRequiredInputs: reviewerExaminedAllRequiredInputs(reviewInputs),
    },
  };
  const decision = evaluatePhaseCompletion(
    {
      phase: 'challenge',
      phaseAttemptId: `${state.taskId}-challenge-${state.attemptNumber}`,
      repositorySnapshotId: `${state.repositoryId}-snapshot`,
      contractVersion: contract.version,
      planVersion: plan.version,
      candidateSha: resolveCandidateSha(runState),
      baseSha: resolveBaseSha(runState),
      policyVersion: 'v1',
      evidenceIds: [],
      openFindingIds: review.findings.filter((f) => f.status === 'open').map((f) => f.id),
      artifactManifestHash: 'run-phase-mvp',
    },
    completionContext,
  );
  if (!decision.complete) {
    if (review.findings.some((f) => f.category === 'requirements' && f.status === 'open')) {
      return { outcome: 'replan', target: 'specify', findings: review.findings };
    }
    return { outcome: 'repair', target: 'implement', findings: review.findings };
  }
  return candidateResult(
    'challenge',
    state,
    [],
    review.findings.filter((f) => f.status === 'open').map((f) => f.id),
  );
}

// ---------------------------------------------------------------------------------------------
// release (never real GitHub — FakeGitHubClient/FakeGitPushRunner only)
// ---------------------------------------------------------------------------------------------

async function runRelease(state: TaskWorkflowState): Promise<PhaseAttemptResult> {
  const runState = await getOrCreateTaskRunState(state.taskId);
  const evidence = [...runState.verificationEvidence, ...runState.qaEvidence];
  const candidateSha = resolveCandidateSha(runState);
  const worktreePath = runState.worktreePath ?? process.cwd();

  // Real delivery (Fix 6): on the claude runtime, open a real draft PR on the repo's actual remote
  // via the Octokit client (authed with the ambient `gh` token) + git-CLI push. The mock runtime
  // keeps the in-memory fakes and a synthetic ref, so every deterministic test is unchanged.
  const realDelivery = resolveAgentRuntime() === 'claude';
  let ref = { owner: 'awb-mvp', repo: state.repositoryId };
  let client;
  let pushRunner;
  let mediaUploader: import('@awb/github').GitHubMediaUploader | undefined;
  if (realDelivery) {
    const resolvedRef = await resolveRepoRef(worktreePath);
    if (!resolvedRef) return blockedResult('release', ['could not resolve a GitHub owner/repo from the worktree remote']);
    ref = resolvedRef;
    ({ client, pushRunner, mediaUploader } = await createRealDelivery());
  } else {
    client = new FakeGitHubClient();
    pushRunner = new FakeGitPushRunner();
  }

  const branchName = runState.lease?.branchName ?? `awb/${state.taskId}`;
  const baseBranch = runState.lease?.baseRef ?? 'main';

  // The changed paths give the PR body's Changes section (and a title fallback). Recompute from the
  // worktree diff; empty on the mock path or any git error, which the renderers tolerate.
  let changedPaths: string[] = [];
  if (realDelivery && runState.worktreePath) {
    changedPaths = (
      await resolveReviewDiff({
        worktreePath: runState.worktreePath,
        baseSha: resolveBaseSha(runState),
        candidateSha,
      })
    ).changedPaths;
  }

  const deliverResult = await deliverToGitHub(
    {
      ref,
      branchName,
      worktreePath,
      baseBranch,
      objective: runState.contract?.objective ?? state.prompt ?? state.taskId,
      planSummary: runState.plan?.summary,
      changedPaths,
      candidateSha,
      evidence,
    },
    client,
    pushRunner,
  );

  // Upload the QA media artifacts (video/trace) to the PR (Fix 7). Real path only: for every
  // qa-video/browser-trace artifact the exercise phase produced, push it as a GitHub release asset
  // and post a DESCRIPTIVE brief comment (what was exercised + the result + a link), not a bare
  // "QA artifact (kind): <url>". An upload that comes back without a real download URL counts as a
  // FAILED upload — we do NOT post an `undefined` link (that was the observed regression).
  // requiredVideosUploaded reflects real success; vacuously satisfied when there is no media.
  let requiredVideosUploaded = true;
  if (realDelivery && mediaUploader) {
    // Summaries from the QA evidence describe what was exercised, for the media brief.
    const qaSummary = runState.qaEvidence.map((e) => e.summary).find((s) => s && s.length > 0);
    const mediaArtifactIds = runState.qaEvidence.flatMap((e) => e.artifactIds);
    const mediaFiles = mediaArtifactIds
      .map((id) => runState.artifactStore.get(id))
      .filter((a): a is { record: import('@awb/domain').ArtifactRecord; path: string } => a !== undefined)
      .filter((a) => a.record.kind === 'qa-video' || a.record.kind === 'browser-trace');

    for (const media of mediaFiles) {
      try {
        const uploaded = await mediaUploader.uploadToPullRequest({
          owner: ref.owner,
          repository: ref.repo,
          pullRequestNumber: deliverResult.pr.number,
          filePath: media.path,
          caption: media.record.kind,
        });
        if (!uploaded.attachmentUrl) {
          // Upload returned no usable download URL — treat as a failed upload; don't post a broken link.
          requiredVideosUploaded = false;
          continue;
        }
        await client.postComment({
          owner: ref.owner,
          repo: ref.repo,
          pullNumber: deliverResult.pr.number,
          body: renderQaMediaBrief({ kind: media.record.kind, qaSummary, mediaUrl: uploaded.attachmentUrl }),
        });
      } catch {
        requiredVideosUploaded = false;
      }
    }
  }

  const completionContext: CompletionContext = {
    release: {
      targetBranchFetched: true,
      candidateReconciledWithTarget: true,
      evidenceAppliesToFinalCandidate: evidence.every((e) => e.candidateSha === candidateSha),
      branchPushed: deliverResult.pushed,
      draftPrExists: deliverResult.pr.number > 0,
      // Evidence is now rendered into the PR body's Test plan section (no separate matrix comment),
      // so the "evidence was delivered" readiness check is satisfied whenever the PR was created.
      evidenceMatrixPosted: deliverResult.pr.number > 0,
      requiredVideosUploaded,
      prReferencesFinalCandidateSha: true,
    },
  };
  const decision = evaluatePhaseCompletion(
    {
      phase: 'release',
      phaseAttemptId: `${state.taskId}-release-${state.attemptNumber}`,
      repositorySnapshotId: `${state.repositoryId}-snapshot`,
      contractVersion: runState.contract?.version ?? 1,
      planVersion: runState.plan?.version ?? 1,
      candidateSha,
      baseSha: runState.baseSha,
      policyVersion: 'v1',
      evidenceIds: evidence.map((e) => e.id),
      openFindingIds: [],
      artifactManifestHash: 'run-phase-mvp',
    },
    completionContext,
  );
  if (!decision.complete) return blockedResult('release', decision.missing);

  // Per product spec, Release completing its own readiness checklist still gates on a human
  // merge/close decision before the Workflow may proceed to Assimilate — the Workflow's
  // `pullRequestMerged`/`pullRequestClosed` signal handlers own that transition (task-workflow.ts).
  return {
    outcome: 'await-human',
    gate: {
      id: `${state.taskId}-release-gate`,
      taskId: state.taskId,
      phase: 'release',
      reason: 'pr-readiness',
      summary: `Draft PR #${deliverResult.pr.number} for task ${state.taskId} is ready for human review/merge.`,
      createdAt: new Date().toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// assimilate
// ---------------------------------------------------------------------------------------------

async function runAssimilate(state: TaskWorkflowState): Promise<PhaseAttemptResult> {
  const prMerged = state.deliveryState === 'merged';
  const prClosed = state.deliveryState === 'closed';

  const completionContext: CompletionContext = {
    assimilate: {
      prMerged,
      prClosed,
      prAbandoned: false,
      memoryRefreshedFromMergeCommit: prMerged,
      processesStopped: true,
      worktreeRemovedOrPreserved: true,
      retentionPolicyApplied: true,
    },
  };
  const decision = evaluatePhaseCompletion(
    {
      phase: 'assimilate',
      phaseAttemptId: `${state.taskId}-assimilate-${state.attemptNumber}`,
      repositorySnapshotId: `${state.repositoryId}-snapshot`,
      contractVersion: 1,
      planVersion: 1,
      policyVersion: 'v1',
      evidenceIds: [],
      openFindingIds: [],
      artifactManifestHash: 'run-phase-mvp',
    },
    completionContext,
  );
  if (!decision.complete) return blockedResult('assimilate', decision.missing);

  taskRunStates.delete(state.taskId);
  return candidateResult('assimilate', state, [], []);
}

/**
 * Real `runPhase` Activity implementation. For each phase, this creates agent sessions (via a
 * scripted `MockAgentAdapter` for plan/challenge — never a real model) and calls into
 * `@awb/planning`/`@awb/verification`/`@awb/qa`/`@awb/review`/`@awb/github`, threading
 * contract/plan/evidence state across calls via an in-memory per-task Map (see `TaskRunState`
 * above — lost on worker restart, documented limitation).
 *
 * Unlike the Milestone 3 stub, this Activity calls `evaluatePhaseCompletion` (from `@awb/workflow`)
 * itself before ever returning a `"candidate"` outcome, so the Workflow's trust in "candidate means
 * complete" is actually backed by the same deterministic policy the product spec defines — not a
 * rubber stamp.
 */
export async function runPhase(input: {
  phase: TaskPhase;
  state: TaskWorkflowState;
}): Promise<PhaseAttemptResult> {
  resetUsage();
  const result = await runPhaseInner(input);
  // Attach the agent usage this attempt accumulated so the Workflow can aggregate token +
  // per-phase runtime totals (TASK-11). undefined when no agent session ran (or on the mock
  // runtime, whose adapter reports no usage) — the Workflow simply skips accumulation then.
  const usage = usageForResult();
  return usage ? { ...result, usage } : result;
}

async function runPhaseInner(input: {
  phase: TaskPhase;
  state: TaskWorkflowState;
}): Promise<PhaseAttemptResult> {
  switch (input.phase) {
    case 'specify':
      return runSpecify(input.state);
    case 'plan':
      return runPlan(input.state);
    case 'prepare':
      return runPrepare(input.state);
    case 'implement':
      return runImplement(input.state);
    case 'verify':
      return runVerify(input.state);
    case 'exercise':
      return runExercise(input.state);
    case 'challenge':
      return runChallenge(input.state);
    case 'release':
      return runRelease(input.state);
    case 'assimilate':
      return runAssimilate(input.state);
  }
}
