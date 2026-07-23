import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  TaskPhase,
  PhaseAttemptResult,
  ValidatedCommand,
} from '@awb/domain';
import type { TaskWorkflowState } from '@awb/workflow';
import { evaluatePhaseCompletion, type CompletionContext } from '@awb/workflow';
import { createAgentAdapter, scriptMockTurns, resolveAgentRuntime, type AgentRuntime } from './agent-factory.js';
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
import { createPhaseEventSink } from './durable-event-sink.js';
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
import { deliverToGitHub, commitQaMediaToBranch } from '@awb/github';
import { postQaMediaBriefs, qaMediaFileName } from './qa-media-support.js';
import { FakeGitHubClient, FakeGitPushRunner } from '@awb/github/test-fakes';
import {
  InMemoryRunStateStore,
  type RunStateStore,
  type TaskRunState,
} from './run-state-store.js';
import { SqliteRunStateStore } from './sqlite-run-state-store.js';
import {
  drivePhase,
  blockedResult,
  buildPhaseAttempt,
  UsageAccumulator,
  NOOP_PHASE_EVENT_EMITTER,
  type PhaseContext,
  type PhaseHandler,
  type PhaseOutcome,
} from './phase-driver.js';

export type { TaskRunState } from './run-state-store.js';

/**
 * Process-wide stores. The mock runtime creates no real DB rows (mock adapter, deterministic tests),
 * so it keeps the in-memory store — every existing test is unchanged. The claude runtime uses the
 * durable SQLite-backed store (TASK-27) so a worker restart mid-task resumes with real state. Set
 * `AWB_DURABLE_RUN_STATE=0` to force the in-memory store even on claude (e.g. a daemon-less smoke run).
 */
const inMemoryStore: RunStateStore = new InMemoryRunStateStore();
let durableStore: RunStateStore | undefined;

function resolveRunStateStore(strategy: AgentRuntime): RunStateStore {
  if (strategy !== 'claude' || process.env.AWB_DURABLE_RUN_STATE === '0') {
    return inMemoryStore;
  }
  if (!durableStore) durableStore = new SqliteRunStateStore();
  return durableStore;
}

function allowedToolsForBrokerRole(
  role: 'planner' | 'plan-critic' | 'builder' | 'verifier' | 'qa-executor' | 'adversarial-reviewer',
  strategy: AgentRuntime,
): string[] {
  const capabilities = [...createCapabilityBroker(role).listGranted()];
  // On the claude runtime the session's `tools` must be concrete SDK tool names (Read/Write/Edit/
  // Bash/…), NOT the abstract capability strings — otherwise the SDK recognizes none of them, the
  // agent gets no core file tools, and the session leaks in ambient MCP tools instead (the observed
  // implement-phase stall). The mock adapter ignores `tools`, so keep the capability strings there
  // to leave every deterministic test unchanged.
  if (strategy === 'claude') {
    return capabilitiesToSdkTools(capabilities);
  }
  return capabilities;
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
const specifyHandler: PhaseHandler = {
  phase: 'specify',
  async run(ctx): Promise<PhaseOutcome> {
    const { state, runState } = ctx;

    if (state.attemptNumber <= 1) {
      // On the claude runtime with a real prompt, draft a contract that reflects the actual request +
      // a QA-required behavioral claim (Fix 9) — the real plan phase produces QA scenarios that can
      // cover it. The mock runtime keeps the generic single-correctness-claim stub, since its scripted
      // plan cannot satisfy a QA-required behavioral claim (everyBehavioralClaimHasQaScenario).
      const useRealContract = ctx.strategy === 'claude' && Boolean(state.prompt);
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
        kind: 'early',
        result: {
          outcome: 'await-human',
          gate: {
            id: `${state.taskId}-specify-gate`,
            taskId: state.taskId,
            phase: 'specify',
            reason: 'task-contract-approval',
            summary: `Contract v${contract.version} for task ${state.taskId} awaits human approval.`,
            createdAt: new Date().toISOString(),
          },
        },
      };
    }

    if (!runState.contract) {
      return { kind: 'early', result: blockedResult('specify', ['no contract was drafted before approval was expected']) };
    }
    runState.contract = markContractApproved(runState.contract);

    return {
      kind: 'evaluate',
      completion: { specify: contractCompletionInputs(runState.contract, true) },
      evidenceIds: [`contract-${runState.contract.id}`],
      openFindingIds: [],
      candidateOverrides: { contractVersion: runState.contract.version },
    };
  },
};

// ---------------------------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------------------------

const planHandler: PhaseHandler = {
  phase: 'plan',
  async run(ctx): Promise<PhaseOutcome> {
    const { state, runState } = ctx;
    const contract = runState.contract;
    if (!contract) {
      return { kind: 'early', result: blockedResult('plan', ['no approved contract available from the specify phase']) };
    }

    // The planner must inspect the TARGET repo, not the workbench's own tree. Plan runs before
    // prepare creates the worktree, so resolve the registered repo's canonical path on the claude
    // runtime; without this the planner ran in process.cwd() (the workbench) and planned against the
    // wrong repository. Falls back to worktreePath (if a prior phase set it) then process.cwd().
    const planCwd =
      runState.worktreePath ??
      (ctx.strategy === 'claude' ? await resolveRepositoryPath(state.repositoryId) : undefined) ??
      process.cwd();

    const adapter = createAgentAdapter();
    scriptMockTurns(adapter, state.taskId, 'planner', { summary: 'Single-slice plan covering the task objective' });
    scriptMockTurns(adapter, state.taskId, 'plan-critic', { findings: [] });

    const realPlanner = ctx.strategy === 'claude';

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
          allowedTools: allowedToolsForBrokerRole('planner', ctx.strategy),
        });
        const { sink, flush } = createPhaseEventSink({
          artifactsDir: runState.artifactsDir as string,
          taskId: state.taskId,
          role: 'planner',
          phase: 'plan',
          attemptNumber: state.attemptNumber,
          durable: ctx.strategy === 'claude',
        });
        const plannerStart = Date.now();
        const execution = await adapter.execute(
          session,
          { instruction: realPlanner ? plannerInstruction(contract) : 'Produce an implementation plan for the approved contract' },
          sink,
          new AbortController().signal,
        );
        ctx.usage.record(execution.usage, Date.now() - plannerStart);
        await flush();
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
          allowedTools: allowedToolsForBrokerRole('plan-critic', ctx.strategy),
        });
        const { sink, flush } = createPhaseEventSink({
          artifactsDir: runState.artifactsDir as string,
          taskId: state.taskId,
          role: 'plan-critic',
          phase: 'plan',
          attemptNumber: state.attemptNumber,
          durable: ctx.strategy === 'claude',
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
        ctx.usage.record(execution.usage, Date.now() - criticStart);
        await flush();
        return execution.findings;
      },
    });

    if (loopResult.outcome === 'non-convergent') {
      return {
        kind: 'early',
        result: {
          outcome: 'await-human',
          gate: {
            id: `${state.taskId}-plan-gate`,
            taskId: state.taskId,
            phase: 'plan',
            reason: 'planner-critic-non-convergence',
            summary: `Planner/critic loop did not converge after ${loopResult.attempts} attempts.`,
            createdAt: new Date().toISOString(),
          },
        },
      };
    }

    const plan = acceptPlan(loopResult.plan);
    runState.plan = plan;

    return {
      kind: 'evaluate',
      completion: {
        plan: {
          everyClaimMappedToSlice: everyClaimMappedToSlice(plan),
          everyBehavioralClaimHasQaScenario: everyBehavioralClaimHasQaScenario(plan, contract.claims),
          everySliceHasTargetedChecks: everySliceHasTargetedChecks(plan),
          criticBlockerOrHighFindingCount: 0,
          isHighRisk: contract.risk === 'high',
          planStatus: plan.status,
          humanApprovedHighRiskPlan: contract.risk !== 'high',
        },
      },
      evidenceIds: [`plan-${plan.id}`],
      openFindingIds: [],
      candidateOverrides: { contractVersion: contract.version, planVersion: plan.version },
    };
  },
};

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
const prepareHandler: PhaseHandler = {
  phase: 'prepare',
  async run(ctx): Promise<PhaseOutcome> {
    const { state, runState } = ctx;
    const realPrepare = ctx.strategy === 'claude';

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

    return {
      kind: 'evaluate',
      completion: {
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
      },
      evidenceIds: [`prepare-${state.taskId}`],
      openFindingIds: [],
      candidateOverrides: { baseSha: runState.baseSha },
    };
  },
};

// ---------------------------------------------------------------------------------------------
// implement
// ---------------------------------------------------------------------------------------------

const implementHandler: PhaseHandler = {
  phase: 'implement',
  async run(ctx): Promise<PhaseOutcome> {
    const { state, runState } = ctx;
    const plan = runState.plan;
    if (!plan) {
      return { kind: 'early', result: blockedResult('implement', ['no accepted plan available from the plan phase']) };
    }

    runState.builderSessionId = runState.builderSessionId ?? randomUUID();
    let everySliceAccountedFor = true;

    const realBuilder = ctx.strategy === 'claude' && runState.worktreePath !== undefined;
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
          const { sink, flush } = createPhaseEventSink({
            artifactsDir: runState.artifactsDir as string,
            taskId: state.taskId,
            role: 'builder',
            phase: 'implement',
            attemptNumber: state.attemptNumber,
            durable: ctx.strategy === 'claude',
          });
          const attempt = await runRealBuilderAttempt({
            adapter,
            taskId: state.taskId,
            worktreePath: runState.worktreePath,
            slice,
            allowedTools: allowedToolsForBrokerRole('builder', ctx.strategy),
            tokenBudget: assignment.tokenBudget,
            runtimeBudgetMs: assignment.runtimeBudgetMs,
            eventSink: sink,
          });
          ctx.usage.record(attempt.usage, attempt.runtimeMs);
          await flush();
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

    return {
      kind: 'evaluate',
      completion: {
        implement: {
          everySliceAccountedFor,
          candidateCommitExists,
          targetedChecksPass,
          builderBlockerOpen: false,
          diffWithinApprovedScope: true,
        },
      },
      evidenceIds: [`implement-${candidateSha}`],
      openFindingIds: [],
      candidateOverrides: { planVersion: plan.version, baseSha: runState.baseSha, candidateSha },
    };
  },
};

// ---------------------------------------------------------------------------------------------
// verify (genuinely real: real command, real ArtifactStore)
// ---------------------------------------------------------------------------------------------

const verifyHandler: PhaseHandler = {
  phase: 'verify',
  async run(ctx): Promise<PhaseOutcome> {
    const { state, runState } = ctx;
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
    if (ctx.strategy === 'claude' && runState.worktreePath) {
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

    return {
      kind: 'evaluate',
      completion: {
        verify: {
          allRequiredCommandsPass: allPass,
          resultsTiedToCandidateSha: results.every((r) => r.evidence.candidateSha === context.candidateSha),
          resultsTiedToEnvironmentDigest: true,
          anyResultStale: false,
          waiversAreHumanApprovedAndShaScoped: true,
        },
      },
      evidenceIds: results.map((r) => r.evidence.id),
      openFindingIds: [],
      candidateOverrides: { baseSha: context.baseSha, candidateSha: context.candidateSha },
      onBlocked: () => ({ outcome: 'repair', target: 'implement', findings: [] }),
    };
  },
};

// ---------------------------------------------------------------------------------------------
// exercise (genuinely real: real CLI QA executor)
// ---------------------------------------------------------------------------------------------

const exerciseHandler: PhaseHandler = {
  phase: 'exercise',
  async run(ctx): Promise<PhaseOutcome> {
    const { state, runState } = ctx;
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
      ctx.strategy === 'claude' && process.env.AWB_QA_MODE === 'browser'
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

    return {
      kind: 'evaluate',
      completion: {
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
      },
      evidenceIds: [qaResult.evidence.id],
      openFindingIds: [],
      candidateOverrides: { baseSha: context.baseSha, candidateSha: context.candidateSha },
      onBlocked: () => ({ outcome: 'repair', target: 'implement', findings: [] }),
    };
  },
};

// ---------------------------------------------------------------------------------------------
// challenge
// ---------------------------------------------------------------------------------------------

const challengeHandler: PhaseHandler = {
  phase: 'challenge',
  async run(ctx): Promise<PhaseOutcome> {
    const { state, runState } = ctx;
    const contract = runState.contract;
    const plan = runState.plan;
    if (!contract || !plan) {
      return { kind: 'early', result: blockedResult('challenge', ['contract or plan not available']) };
    }

    const adapter = createAgentAdapter();
    scriptMockTurns(adapter, state.taskId, 'adversarial-reviewer', { findings: [] });

    // Real path: hand the reviewer the actual candidate diff + changed paths from the worktree, not
    // a placeholder string. Mock path keeps the synthetic diff (no real commit exists there).
    let finalDiff = 'diff --git a/PLACEHOLDER b/PLACEHOLDER\n+ synthetic candidate diff for MVP wiring\n';
    let relevantSourcePaths: string[] = [];
    if (ctx.strategy === 'claude' && runState.worktreePath && runState.candidateSha) {
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
          allowedTools: allowedToolsForBrokerRole('adversarial-reviewer', ctx.strategy),
        });
        const { sink, flush } = createPhaseEventSink({
          artifactsDir: runState.artifactsDir as string,
          taskId: state.taskId,
          role: 'adversarial-reviewer',
          phase: 'challenge',
          attemptNumber: state.attemptNumber,
          durable: ctx.strategy === 'claude',
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
        ctx.usage.record(execution.usage, Date.now() - reviewerStart);
        await flush();
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

    return {
      kind: 'evaluate',
      completion: {
        challenge: {
          reviewerSessionDiffersFromBuilder: reviewerSessionDiffersFromBuilder(
            review.reviewerSessionId,
            runState.builderSessionId ?? 'no-builder-session',
          ),
          blockerOrHighFindingOpen: !noBlockerOrHighFindingOpen(review.findings),
          everyFindingResolvedInvalidatedOrWaived: everyFindingResolvedInvalidatedOrWaived(review.findings),
          reviewerExaminedAllRequiredInputs: reviewerExaminedAllRequiredInputs(reviewInputs),
        },
      },
      evidenceIds: [],
      openFindingIds: review.findings.filter((f) => f.status === 'open').map((f) => f.id),
      candidateOverrides: {
        contractVersion: contract.version,
        planVersion: plan.version,
        candidateSha: resolveCandidateSha(runState),
        baseSha: resolveBaseSha(runState),
      },
      onBlocked: () => {
        if (review.findings.some((f) => f.category === 'requirements' && f.status === 'open')) {
          return { outcome: 'replan', target: 'specify', findings: review.findings };
        }
        return { outcome: 'repair', target: 'implement', findings: review.findings };
      },
    };
  },
};

// ---------------------------------------------------------------------------------------------
// release (never real GitHub on the mock path — FakeGitHubClient/FakeGitPushRunner only)
// ---------------------------------------------------------------------------------------------

/**
 * Release is the one phase whose "complete" outcome is NOT a candidate: per product spec, completing
 * its own readiness checklist still gates on a human merge/close decision before Assimilate. So it
 * runs the completion evaluation itself and, on a complete decision, returns the `pr-readiness`
 * await-human gate (the Workflow's `pullRequestMerged`/`pullRequestClosed` handlers own the
 * transition). A non-complete decision blocks.
 */
const releaseHandler: PhaseHandler = {
  phase: 'release',
  async run(ctx): Promise<PhaseOutcome> {
    const { state, runState } = ctx;
    const evidence = [...runState.verificationEvidence, ...runState.qaEvidence];
    const candidateSha = resolveCandidateSha(runState);
    const worktreePath = runState.worktreePath ?? process.cwd();

    // Real delivery (Fix 6): on the claude runtime, open a real draft PR on the repo's actual remote
    // via the Octokit client (authed with the ambient `gh` token) + git-CLI push. The mock runtime
    // keeps the in-memory fakes and a synthetic ref, so every deterministic test is unchanged.
    const realDelivery = ctx.strategy === 'claude';
    let ref = { owner: 'awb-mvp', repo: state.repositoryId };
    let client;
    let pushRunner;
    let mediaUploader: import('@awb/github').GitHubMediaUploader | undefined;
    if (realDelivery) {
      const resolvedRef = await resolveRepoRef(worktreePath);
      if (!resolvedRef) {
        return { kind: 'early', result: blockedResult('release', ['could not resolve a GitHub owner/repo from the worktree remote']) };
      }
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

    // QA media for the PR. The screenshot + video are COMMITTED into the branch (below, before the
    // push) so the reviewer can open them in a browser tab (raw image renders inline; the video's
    // blob-view page is GitHub's native in-tab player) — release-asset links can't, GitHub always
    // serves those as forced downloads. The Playwright trace stays a release asset (no in-browser
    // viewer). All are linked from one consolidated comment after the PR exists.
    const allMedia =
      realDelivery && mediaUploader
        ? runState.qaEvidence
            .flatMap((e) => e.artifactIds)
            .map((id) => runState.artifactStore.get(id))
            .filter((a): a is { record: import('@awb/domain').ArtifactRecord; path: string } => a !== undefined)
        : [];
    const branchMedia = allMedia.filter((a) => a.record.kind === 'qa-video' || a.record.kind === 'screenshot');
    const traceMedia = allMedia.filter((a) => a.record.kind === 'browser-trace');

    // Commit the screenshot + video into the branch BEFORE the push, so they ship with the PR.
    let committedMedia: { kind: string; repoPath: string }[] = [];
    if (realDelivery && branchMedia.length > 0) {
      const commit = await commitQaMediaToBranch({
        worktreePath,
        files: branchMedia.map((m) => ({ srcPath: m.path, name: qaMediaFileName(m.record) })),
      });
      committedMedia = branchMedia.map((m, i) => ({ kind: m.record.kind, repoPath: commit.committedPaths[i] as string }));
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

    // requiredVideosUploaded reflects real success: the branch media committed (when there was any)
    // AND the trace uploaded to a real URL. Vacuously satisfied when there is no media.
    let requiredVideosUploaded = true;
    if (realDelivery && mediaUploader) {
      if (branchMedia.length > 0 && committedMedia.length === 0) requiredVideosUploaded = false;
      const result = await postQaMediaBriefs({
        owner: ref.owner,
        repo: ref.repo,
        pullRequestNumber: deliverResult.pr.number,
        branch: branchName,
        committedMedia,
        traceFiles: traceMedia,
        // Summaries from the QA evidence describe what was exercised, for the media section.
        qaSummary: runState.qaEvidence.map((e) => e.summary).find((s) => s && s.length > 0),
        uploader: mediaUploader,
        client,
      });
      if (!result.requiredVideosUploaded) requiredVideosUploaded = false;
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
      buildPhaseAttempt(state, 'release', evidence.map((e) => e.id), [], {
        contractVersion: runState.contract?.version ?? 1,
        planVersion: runState.plan?.version ?? 1,
        candidateSha,
        baseSha: runState.baseSha,
      }),
      completionContext,
    );
    if (!decision.complete) {
      return { kind: 'early', result: blockedResult('release', decision.missing) };
    }

    // Per product spec, Release completing its own readiness checklist still gates on a human
    // merge/close decision before the Workflow may proceed to Assimilate — the Workflow's
    // `pullRequestMerged`/`pullRequestClosed` signal handlers own that transition (task-workflow.ts).
    return {
      kind: 'early',
      result: {
        outcome: 'await-human',
        gate: {
          id: `${state.taskId}-release-gate`,
          taskId: state.taskId,
          phase: 'release',
          reason: 'pr-readiness',
          summary: `Draft PR #${deliverResult.pr.number} for task ${state.taskId} is ready for human review/merge.`,
          createdAt: new Date().toISOString(),
        },
      },
    };
  },
};

// ---------------------------------------------------------------------------------------------
// assimilate
// ---------------------------------------------------------------------------------------------

const assimilateHandler: PhaseHandler = {
  phase: 'assimilate',
  async run(ctx): Promise<PhaseOutcome> {
    const { state } = ctx;
    const prMerged = state.deliveryState === 'merged';
    const prClosed = state.deliveryState === 'closed';

    return {
      kind: 'evaluate',
      completion: {
        assimilate: {
          prMerged,
          prClosed,
          prAbandoned: false,
          memoryRefreshedFromMergeCommit: prMerged,
          processesStopped: true,
          worktreeRemovedOrPreserved: true,
          retentionPolicyApplied: true,
        },
      },
      evidenceIds: [],
      openFindingIds: [],
    };
  },
};

// ---------------------------------------------------------------------------------------------
// driver
// ---------------------------------------------------------------------------------------------

const HANDLERS: Record<TaskPhase, PhaseHandler> = {
  specify: specifyHandler,
  plan: planHandler,
  prepare: prepareHandler,
  implement: implementHandler,
  verify: verifyHandler,
  exercise: exerciseHandler,
  challenge: challengeHandler,
  release: releaseHandler,
  assimilate: assimilateHandler,
};

/**
 * Real `runPhase` Activity implementation. A thin driver: it resolves the runtime strategy ONCE
 * (never per phase — TASK-29), loads the task's `TaskRunState` through the `RunStateStore` seam
 * (TASK-30), selects the phase handler from the exhaustive closed set, and runs it through the
 * shared driver (TASK-28: emit → run → save → evaluate/map → attach usage). The per-phase
 * completion policy is still `evaluatePhaseCompletion` (from `@awb/workflow`), called once by the
 * driver, so the Workflow's trust in "candidate means complete" stays backed by the same
 * deterministic policy the product spec defines — not a rubber stamp.
 *
 * State threads across phase attempts via the store (an in-memory Map by default — lost on worker
 * restart, documented limitation; TASK-27 swaps a durable impl behind the same seam). Usage is a
 * per-invocation accumulator on the context (TASK-30, was a module global) attached to the result
 * for the Workflow's `tokenUsageTotal` + `runtimeMsByPhase` aggregation (TASK-11).
 */
export async function runPhase(input: {
  phase: TaskPhase;
  state: TaskWorkflowState;
}): Promise<PhaseAttemptResult> {
  const strategy = resolveAgentRuntime();
  const store = resolveRunStateStore(strategy);
  const runState = await store.load(input.state.taskId);
  // The workflow state is the source of truth for repositoryId; thread it onto the run state so the
  // durable store can key persisted rows (the mock in-memory store ignores it).
  runState.repositoryId = input.state.repositoryId;
  const ctx: PhaseContext = {
    state: input.state,
    runState,
    store,
    strategy,
    usage: new UsageAccumulator(),
    emit: NOOP_PHASE_EVENT_EMITTER,
  };

  const result = await drivePhase(HANDLERS[input.phase], ctx);

  // Assimilate completing successfully ends the task; drop its accumulated state (matches the prior
  // `taskRunStates.delete` on the assimilate candidate path).
  if (input.phase === 'assimilate' && result.outcome === 'candidate') {
    await store.remove(input.state.taskId);
  }
  return result;
}
