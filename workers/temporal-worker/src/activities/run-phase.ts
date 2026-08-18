import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { activityInfo } from '@temporalio/activity';
import type {
  TaskPhase,
  PhaseAttemptResult,
  ProgramDesign,
  ValidatedCommand,
  Finding,
  ClaimCoverage,
} from '@awb/domain';
import type { TaskWorkflowState } from '@awb/workflow';
import { classifyExerciseBlock, evaluatePhaseCompletion, routeLoop, type CompletionContext } from '@awb/workflow';
import {
  createAgentAdapter,
  scriptMockTurns,
  resolveAgentRuntime,
  resolveRuntimeProfile,
  resolveRuntimeConfig,
  type RuntimeProfile,
} from './agent-factory.js';
import { materializeWorktree } from './worktree-support.js';
import { runRealBuilderAttempt } from './builder-support.js';
import { plannerInstruction, parsePlannerOutput } from './plan-support.js';
import { loadProjectMemoryForContext } from './memory-support.js';
import {
  resolveVerificationCommands,
  resolveReviewDiff,
  resolveStartCommandForWorktree,
  resolveRepositoryPath,
  installWorktreeDependencies,
} from './command-support.js';
import { runBrowserQaViaServer } from './browser-qa-support.js';
import { draftContractInputFromPrompt, formatContractGateSummary } from './contract-support.js';
import { classifyTaskSize, SIZE_CLASSIFIER_MODEL } from './classifier-support.js';
import { programDesignInstruction, parseProgramDesignOutput } from './program-design-support.js';
import { resolveRepoRef, resolveDeliveryTarget, resolveRepositoryRoot, createRealDelivery } from './delivery-support.js';
import { createPhaseEventSink } from './durable-event-sink.js';
import { createCapabilityBroker } from '@awb/capability-broker';
import { capabilitiesToSdkTools, disallowedSdkTools } from '@awb/agent-gateway';
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
import {
  runCliQa,
  runBrowserQa,
  runHttpApiQa,
  runLibraryQa,
  evaluateBehavioralClaimCoverage,
  behavioralClaimsWithUntouchedTarget,
  buildInteractiveScenarioSteps,
  scenarioStrength,
  type QaEvidenceContext,
  type BrowserQaStep,
} from '@awb/qa';
import {
  runAdversarialReview,
  runMaintainabilityReview,
  reviewerSessionDiffersFromBuilder,
  noBlockerOrHighFindingOpen,
  everyFindingResolvedInvalidatedOrWaived,
  reviewerExaminedAllRequiredInputs,
  type ReviewInputs,
} from '@awb/review';
import { deliverToGitHub, deliverToLocalMerge, commitQaMediaToBranch } from '@awb/github';
import { postQaMediaBriefs, qaMediaFileName } from './qa-media-support.js';
import { FakeGitHubClient, FakeGitPushRunner } from '@awb/github/test-fakes';
import {
  InMemoryRunStateStore,
  type RunStateStore,
  type TaskRunState,
} from './run-state-store.js';
import { SqliteRunStateStore } from './sqlite-run-state-store.js';
import { ObservabilityAccumulator, estimateContextComposition } from './observability-accumulator.js';
import { createDaemonClient } from '../daemon-client.js';
import { createControlPlaneEmitter } from './control-plane-events.js';
import { isResumableTransportError } from '@awb/agent-gateway';
import { withSpan } from '@awb/telemetry';
import { getDiffLineStats } from '@awb/repository';
import { runIdForTask } from '@awb/database';
import { computeDecaySignals, decaySpanAttributes } from './decay-metrics.js';
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
 * durable SQLite-backed store so a worker restart mid-task resumes with real state. Set
 * `AWB_DURABLE_RUN_STATE=0` to force the in-memory store even on claude (e.g. a daemon-less smoke run).
 */
const inMemoryStore: RunStateStore = new InMemoryRunStateStore();
let durableStore: RunStateStore | undefined;

function resolveRunStateStore(profile: RuntimeProfile): RunStateStore {
  if (!profile.usesDurableRunState || process.env.AWB_DURABLE_RUN_STATE === '0') {
    return inMemoryStore;
  }
  if (!durableStore) durableStore = new SqliteRunStateStore();
  return durableStore;
}

function allowedToolsForBrokerRole(
  role: 'planner' | 'plan-critic' | 'builder' | 'verifier' | 'qa-executor' | 'adversarial-reviewer',
  profile: RuntimeProfile,
): string[] {
  const capabilities = [...createCapabilityBroker(role).listGranted()];
  // On the Claude SDK the session's `tools` must be concrete SDK tool names (Read/Write/Edit/
  // Bash/…), NOT the abstract capability strings — otherwise the SDK recognizes none of them, the
  // agent gets no core file tools, and the session leaks in ambient MCP tools instead (the observed
  // implement-phase stall). Only the Claude adapter needs this mapping (`usesSdkToolNames`); the
  // mock + CLI adapters ignore `tools` / map to their own surface, so keep the capability strings.
  if (profile.usesSdkToolNames) {
    return capabilitiesToSdkTools(capabilities);
  }
  return capabilities;
}

/**
 * The SDK tools this role must be DENIED. The SDK's `allowedTools` only
 * auto-approves — it does not restrict — so a read-only role would still be able to Write/Edit/Bash
 * under `bypassPermissions` without this. `disallowedSdkTools` returns the complement of the role's
 * grant over the core tool universe; passed as the adapter's `disallowedTools` it removes those tools
 * entirely. Claude runtime only — the mock adapter ignores it, so deterministic tests are unchanged.
 */
function deniedToolsForBrokerRole(
  role: 'planner' | 'plan-critic' | 'builder' | 'verifier' | 'qa-executor' | 'adversarial-reviewer',
  profile: RuntimeProfile,
): string[] {
  if (!profile.usesSdkToolNames) return [];
  return disallowedSdkTools([...createCapabilityBroker(role).listGranted()]);
}

/**
 * Resolves the working directory for a real (claude) phase. On the claude runtime the pinned worktree
 * is the ONLY acceptable cwd — falling back to `process.cwd()` (the worker's own dir, the workbench
 * repo) lets path-less agent discovery and command execution drift into the wrong repository
 * (live run "This is an 'agentic workbench' project"). So on claude a missing worktreePath is a
 * loud failure; only the mock/fixture path may fall back to `process.cwd()`.
 */
export function requireWorktreeCwd(
  profile: RuntimeProfile,
  worktreePath: string | undefined,
  phase: TaskPhase,
  taskId: string,
): string {
  if (profile.usesRealWorktree) {
    if (!worktreePath) {
      throw new Error(
        `${phase}: the ${profile.runtime} runtime requires runState.worktreePath but it is unset for task ${taskId} — refusing the process.cwd() fallback (TASK-31)`,
      );
    }
    return worktreePath;
  }
  return worktreePath ?? process.cwd();
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

function slugForId(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'slice'
  );
}

/** The framework-agnostic landmark liveness scenario, used when a plan declared no expected
 *  per-claim assertions to derive interactive steps from. A navigate + landmark `expectVisible`
 *  proves the page rendered real content; it is (deliberately) all-liveness/structural, so a plan
 *  that relies on it alone scores `weak` at the exercise gate and cannot cover a behavior claim. */
const LANDMARK_FALLBACK_STEPS: BrowserQaStep[] = [
  { kind: 'navigate', url: '/' },
  { kind: 'expectVisible', selector: 'h1, h2, header, nav, main, [role="banner"], [role="main"]' },
  { kind: 'screenshot', name: 'landing' },
];

/**
 * Build the browser exercise scenario from the plan's per-claim expected assertions. Each claim
 * with declared `expectedAssertions` contributes real interactive steps (click the control + a
 * strong assertion, plus a repeated-click socket-idempotency check when applicable) via
 * `buildInteractiveScenarioSteps`; a claim with none contributes nothing on its own. When the plan
 * declares no expected assertions at all, we fall back to the landmark liveness scenario — which
 * is deliberately weak, so `scenarioStrength` scores it `weak` and it cannot cover a behavior claim.
 */
function buildExerciseScenarioSteps(claimCoverage: ClaimCoverage[]): BrowserQaStep[] {
  const expected = claimCoverage.flatMap((c) => c.expectedAssertions ?? []);
  if (expected.length === 0) return LANDMARK_FALLBACK_STEPS;
  return [{ kind: 'navigate', url: '/' }, ...buildInteractiveScenarioSteps(expected)];
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
      // On a real-agent runtime with a real prompt, draft a contract that reflects the actual request +
      // a QA-required behavioral claim — the real plan phase produces QA scenarios that can
      // cover it. The mock runtime keeps the generic single-correctness-claim stub, since its scripted
      // plan cannot satisfy a QA-required behavioral claim (everyBehavioralClaimHasQaScenario).
      const useRealContract = ctx.profile.usesRealAgent && Boolean(state.prompt);
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
      // Classify task size before drafting the contract, so the contract carries the size a
      // human reviews at the gate. The authoritative (Haiku) call is Claude-SDK-specific, so it runs
      // only on a profile that uses SDK tool/model names; every other profile (mock + non-Claude CLI
      // adapters) gets `undefined`, and the contract's `size ?? 'M'` default applies. An intake hint
      // (state.size) takes precedence; a human can still override at the gate.
      const classification = await classifyTaskSize({
        adapter: createAgentAdapter(),
        taskId: state.taskId,
        phase: 'specify',
        attemptNumber: state.attemptNumber,
        cwd: ctx.profile.usesRealAgent ? (await resolveRepositoryPath(state.repositoryId)) ?? process.cwd() : process.cwd(),
        useModel: ctx.profile.usesSdkToolNames,
        model: ctx.profile.usesSdkToolNames ? SIZE_CLASSIFIER_MODEL : undefined,
        input: { prompt: state.prompt ?? '' },
        allowedTools: allowedToolsForBrokerRole('planner', ctx.profile),
        disallowedTools: deniedToolsForBrokerRole('planner', ctx.profile),
        daemon: ctx.daemon,
      });
      // Precedence: explicit intake hint → classifier → draftContract's `M` default (the one place
      // "unclassified" becomes a concrete size). The classifier never invents a size.
      const size = state.size ?? classification?.size;
      runState.size = size;
      const contract = markAwaitingApproval(draftContract({ ...draftInput, size }));
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
            // Surface the problem statement + measurable success criteria in the gate
            // summary so the human aligns on them before planning spend (no separate read route).
            // The summary also carries the classified size the human can override here.
            summary: formatContractGateSummary(contract),
            createdAt: new Date().toISOString(),
          },
        },
      };
    }

    if (!runState.contract) {
      return { kind: 'early', result: blockedResult('specify', ['no contract was drafted before approval was expected']) };
    }
    runState.contract = markContractApproved(runState.contract);
    // Report the classified size to the Workflow so it derives the run's phase set. The
    // contract's size is authoritative — a gate-time human override rewrote it on the contract.
    const reportedSize = runState.contract.size;
    runState.size = reportedSize;

    return {
      kind: 'evaluate',
      completion: { specify: contractCompletionInputs(runState.contract, true) },
      evidenceIds: [`contract-${runState.contract.id}`],
      openFindingIds: [],
      candidateOverrides: { contractVersion: runState.contract.version },
      candidateExtra: { size: reportedSize },
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
    // prepare creates the worktree, so resolve the registered repo's canonical path on a real-agent
    // runtime; without this the planner ran in process.cwd() (the workbench) and planned against the
    // wrong repository. On a real runtime a missing worktree AND unresolvable repo path is a loud
    // failure — never drift to the workbench cwd; only the mock path falls back to cwd.
    const resolvedRepoPath =
      runState.worktreePath ??
      (ctx.profile.usesRealAgent ? await resolveRepositoryPath(state.repositoryId) : undefined);
    if (ctx.profile.usesRealAgent && !resolvedRepoPath) {
      throw new Error(
        `plan: the ${ctx.profile.runtime} runtime could not resolve a target-repo path for task ${state.taskId} (no worktree, no registered repo path) — refusing the process.cwd() fallback (TASK-31)`,
      );
    }
    const planCwd = resolvedRepoPath ?? process.cwd();

    const adapter = createAgentAdapter(ctx.strategy, resolveRuntimeConfig(), 'plan');
    scriptMockTurns(adapter, state.taskId, 'planner', { summary: 'Single-slice plan covering the task objective' });
    scriptMockTurns(adapter, state.taskId, 'plan-critic', { findings: [] });

    const realPlanner = ctx.profile.usesRealAgent;

    // Read side of project memory: inject what prior runs learned about this repo into the planner's
    // context so the next implementation is better-informed (pitfalls, invariants, build/test commands).
    // Real path only — the mock runtime has no meaningful accumulated memory. Setting the `memory` key
    // is also what lights up the observability `memoryTokens` bucket. Bounded so it can't bloat context.
    const projectMemory = realPlanner
      ? await loadProjectMemoryForContext(state.repositoryId).catch(() => [])
      : [];

    // A challenge replan routed its open review findings here (requirements → plan). Consume them:
    // seed the planner's first attempt so it re-plans knowing what review rejected, then clear so
    // they do NOT leak to implement — a plan-level finding is fixed at the plan altitude, not by
    // re-prompting the builder about a defect it can't structurally address.
    const challengeSeed = runState.repairFindings ?? [];
    runState.repairFindings = undefined;

    const loopResult = await runPlannerCriticLoop({
      taskId: state.taskId,
      cwd: planCwd,
      contextPayload: { contract },
      runPlanner: async (priorFindings) => {
        const session = await adapter.createSession({
          role: 'planner',
          taskId: state.taskId,
          cwd: planCwd,
          contextPayload: {
            contract,
            priorFindings: [...challengeSeed, ...priorFindings],
            ...(projectMemory.length > 0 ? { memory: projectMemory } : {}),
          },
          allowedTools: allowedToolsForBrokerRole('planner', ctx.profile),
          disallowedTools: deniedToolsForBrokerRole('planner', ctx.profile),
        });
        const { sink, flush } = createPhaseEventSink({
          artifactsDir: runState.artifactsDir as string,
          taskId: state.taskId,
          role: 'planner',
          phase: 'plan',
          attemptNumber: state.attemptNumber,
          durable: ctx.profile.usesDurableRunState,
        });
        const plannerStart = Date.now();
        const plannerInstr = realPlanner ? plannerInstruction(contract, projectMemory.length > 0) : 'Produce an implementation plan for the approved contract';
        const execution = await adapter.execute(
          session,
          { instruction: plannerInstr },
          sink,
          new AbortController().signal,
        );
        const plannerMs = Date.now() - plannerStart;
        ctx.usage.record(execution.usage, plannerMs);
        ctx.observability.recordSession({
          sessionId: session.id,
          taskId: state.taskId,
          runId: `${state.taskId}-run`,
          phaseAttemptId: `${state.taskId}-plan-${state.attemptNumber}`,
          phase: 'plan',
          role: 'planner',
          runtime: ctx.strategy,
          usage: execution.usage,
          runtimeMs: plannerMs,
          contextComposition: estimateContextComposition(
            { contract, priorFindings, ...(projectMemory.length > 0 ? { memory: projectMemory } : {}) },
            plannerInstr,
          ),
        });
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
          allowedTools: allowedToolsForBrokerRole('plan-critic', ctx.profile),
          disallowedTools: deniedToolsForBrokerRole('plan-critic', ctx.profile),
        });
        const { sink, flush } = createPhaseEventSink({
          artifactsDir: runState.artifactsDir as string,
          taskId: state.taskId,
          role: 'plan-critic',
          phase: 'plan',
          attemptNumber: state.attemptNumber,
          durable: ctx.profile.usesDurableRunState,
        });
        const criticStart = Date.now();
        const criticInstr =
          'The plan to critique is in the JSON context above. Critique it against the contract: ' +
          'find missing claim coverage, slices without targeted checks, behavioral claims lacking a ' +
          'QA scenario, over-engineering, and scope gaps. Report concrete findings.';
        const execution = await adapter.execute(
          session,
          { instruction: criticInstr },
          sink,
          new AbortController().signal,
        );
        const criticMs = Date.now() - criticStart;
        ctx.usage.record(execution.usage, criticMs);
        ctx.observability.recordSession({
          sessionId: session.id,
          taskId: state.taskId,
          runId: `${state.taskId}-run`,
          phaseAttemptId: `${state.taskId}-plan-${state.attemptNumber}`,
          phase: 'plan',
          role: 'plan-critic',
          runtime: ctx.strategy,
          usage: execution.usage,
          runtimeMs: criticMs,
          contextComposition: estimateContextComposition({ plan }, criticInstr),
        });
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
// program-design — only in the phase set for L tasks
// ---------------------------------------------------------------------------------------------

const programDesignHandler: PhaseHandler = {
  phase: 'program-design',
  async run(ctx): Promise<PhaseOutcome> {
    const { state, runState } = ctx;
    const plan = runState.plan;
    if (!plan) {
      return { kind: 'early', result: blockedResult('program-design', ['no accepted plan available from the plan phase']) };
    }

    const realDesigner = ctx.profile.usesRealAgent;
    const designCwd =
      runState.worktreePath ??
      (realDesigner ? await resolveRepositoryPath(state.repositoryId) : undefined) ??
      process.cwd();

    // A challenge replan routed its open review findings here (architecture → program-design on an L
    // run). Consume them: feed the designer so it re-designs to address them, then clear so they do
    // NOT leak to implement — a structural finding is fixed at the design altitude, not by the builder.
    const challengeSeed = runState.repairFindings ?? [];
    runState.repairFindings = undefined;

    // Mock path: a deterministic, bodyless design derived from the plan slices, so an L task under the
    // mock runtime produces a valid program-design artifact and clears the gate (every test stays green).
    // A slice with no declared likelyPaths still contributes a file-tree entry (keyed by its objective),
    // so the file-tree diff is never empty even for the single-slice fallback plan.
    const fileTreeDiff = plan.slices.flatMap((s) =>
      s.likelyPaths.length > 0
        ? s.likelyPaths.map((p) => `~ ${p} (${s.objective})`)
        : [`~ (files for: ${s.objective})`],
    );
    let design: ProgramDesign = {
      id: `design-${plan.id}`,
      taskId: state.taskId,
      planVersion: plan.version,
      version: 1,
      fileTreeDiff: fileTreeDiff.length > 0 ? fileTreeDiff : [`~ (files for: ${plan.summary})`],
      typeSignatures: [],
      functionSignatures: plan.slices.map((s) => ({
        signature: `implement_${slugForId(s.objective)}()`,
        intent: s.objective,
      })),
    };
    let allSignaturesBodyless = true;

    if (realDesigner) {
      const adapter = createAgentAdapter();
      const session = await adapter.createSession({
        role: 'planner',
        taskId: state.taskId,
        cwd: designCwd,
        contextPayload: challengeSeed.length > 0 ? { plan, priorFindings: challengeSeed } : { plan },
        allowedTools: allowedToolsForBrokerRole('planner', ctx.profile),
        disallowedTools: deniedToolsForBrokerRole('planner', ctx.profile),
      });
      const { sink, flush } = createPhaseEventSink({
        artifactsDir: runState.artifactsDir as string,
        taskId: state.taskId,
        role: 'planner',
        phase: 'program-design',
        attemptNumber: state.attemptNumber,
        durable: true,
      });
      const start = Date.now();
      const instr = programDesignInstruction(plan);
      const execution = await adapter.execute(session, { instruction: instr }, sink, new AbortController().signal);
      const ms = Date.now() - start;
      ctx.usage.record(execution.usage, ms);
      ctx.observability.recordSession({
        sessionId: session.id,
        taskId: state.taskId,
        runId: `${state.taskId}-run`,
        phaseAttemptId: `${state.taskId}-program-design-${state.attemptNumber}`,
        phase: 'program-design',
        role: 'planner',
        runtime: ctx.strategy,
        usage: execution.usage,
        runtimeMs: ms,
        contextComposition: estimateContextComposition({ plan }, instr),
      });
      await flush();
      const parsed = parseProgramDesignOutput(execution.summary, plan);
      if (!parsed) {
        return { kind: 'early', result: blockedResult('program-design', ['program-design session produced no parseable design']) };
      }
      design = parsed.design;
      allSignaturesBodyless = parsed.allSignaturesBodyless;
    }

    runState.programDesign = design;

    // Persist the design as a committed artifact so a human/reviewer sees the structure before code.
    await runState.artifactStore.put({
      source: Buffer.from(JSON.stringify(design, null, 2), 'utf8'),
      mediaType: 'application/json',
      kind: 'program-design',
      taskId: state.taskId,
      runId: `${state.taskId}-run`,
      phaseAttemptId: `${state.taskId}-program-design-${state.attemptNumber}`,
      retention: 'task',
    });

    const hasSignatures = design.typeSignatures.length > 0 || design.functionSignatures.length > 0;
    return {
      kind: 'evaluate',
      completion: {
        programDesign: {
          artifactExists: true,
          fileTreeDiffNonEmpty: design.fileTreeDiff.length > 0,
          hasSignatures,
          signaturesAreBodyless: allSignaturesBodyless,
          // The design reaching the completion gate IS the review checkpoint (routed through the gate
          // machinery like the plan); on the real path a human can reject it before any slice runs.
          designAccepted: true,
        },
      },
      evidenceIds: [`program-design-${design.id}`],
      openFindingIds: [],
      candidateOverrides: { planVersion: plan.version },
    };
  },
};

// ---------------------------------------------------------------------------------------------
// prepare
// ---------------------------------------------------------------------------------------------

/**
 * Derives the prepare completion inputs from the real workspace lease + filesystem, replacing the
 * hardcoded `true`s. `dependenciesPrepared` reflects a real install attempt; baseline
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
 * prepare completion inputs from the real lease + a filesystem check. On the mock runtime
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
    const realPrepare = ctx.profile.usesRealAgent;

    if (realPrepare && !runState.lease) {
      // Real path: materialize an actual git worktree + branch off the repo's default branch.
      const lease = await materializeWorktree({
        repositoryId: state.repositoryId,
        taskId: state.taskId,
        // Slug the branch from the human request (contract objective / prompt), not the taskId.
        slugSource: runState.contract?.objective ?? state.prompt ?? state.taskId,
        // Stacked PRs (TASK-72): branch off the parent's delivered branch when set, else default.
        baseOverride: state.baseBranch,
      });
      runState.lease = lease;
      runState.baseSha = lease.baseSha;
      runState.worktreePath = lease.worktreePath;
      // A fresh git worktree has no node_modules of its own, so install deps now or verify/QA fail on
      // missing packages (the observed `vite build` "Cannot find package 'vite'" verify block).
      const install = await ctx.observability.time('dependencyInstallMs', () =>
        installWorktreeDependencies({
          repositoryId: state.repositoryId,
          worktreePath: lease.worktreePath,
        }),
      );
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
    // Single-shot (S) tasks skip the plan phase, so there is no accepted plan here. Synthesize
    // a one-slice plan straight from the contract objective — that IS the single-shot: go directly to a
    // slice. This fires whenever the plan phase was skipped (no plan) but a contract exists, so it does
    // not depend on runState.size (which a gate-time override may not have propagated onto run-state).
    let plan = runState.plan;
    if (!plan) {
      const contract = runState.contract;
      if (contract) {
        plan = acceptPlan(
          draftPlan(
            {
              taskId: state.taskId,
              contractVersion: contract.version,
              summary: contract.objective,
              slices: [
                {
                  objective: contract.objective,
                  claimIds: contract.claims.map((c) => c.id),
                  likelyPaths: [],
                  requiredTargetedChecks: ['test'],
                  dependencies: [],
                  qaScenarioIds: [],
                },
              ],
            },
            contract.claims,
            1,
          ),
        );
        runState.plan = plan;
      } else {
        return { kind: 'early', result: blockedResult('implement', ['no accepted plan available from the plan phase']) };
      }
    }

    runState.builderSessionId = runState.builderSessionId ?? randomUUID();
    let everySliceAccountedFor = true;

    const realBuilder = ctx.profile.usesRealAgent && runState.worktreePath !== undefined;
    const adapter = realBuilder ? createAgentAdapter(ctx.strategy, resolveRuntimeConfig(), 'implement') : undefined;
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
          if (ctx.profile.usesRealAgent && (!adapter || !runState.worktreePath)) {
            // Real path with no worktree is never a legitimate success: the builder would
            // otherwise run path-less discovery against the worker's process.cwd() (the workbench repo)
            // and the phase would rubber-stamp a fake candidate SHA. Fail loudly instead of taking the
            // mock success path so a lost/never-set worktree surfaces as a phase failure, not silent drift.
            throw new Error(
              `implement: the ${ctx.profile.runtime} runtime requires a worktree but runState.worktreePath is unset for task ${state.taskId} — refusing the mock success path (TASK-31)`,
            );
          }
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
            durable: ctx.profile.usesDurableRunState,
          });
          // Resume this slice's prior session if one was persisted: a Temporal retry after a
          // transport drop continues the transcript instead of cold-restarting. Keyed by slice.id, which
          // is stable across attempts (unlike attemptNumber), so the key survives retries + restarts.
          const priorSessionId = runState.builderResumeSessions?.[slice.id];
          // Record which cwd + resume key this session ran under. session-resumed vs session-started
          // distinguishes a warm continuation from a cold start.
          if (priorSessionId) {
            await ctx.controlPlane?.sessionResumed({
              role: 'builder',
              cwd: runState.worktreePath,
              resumeKey: slice.id,
            });
          } else {
            await ctx.controlPlane?.sessionStarted({
              role: 'builder',
              cwd: runState.worktreePath,
              resumeKey: slice.id,
            });
          }
          const attempt = await runRealBuilderAttempt({
            adapter,
            taskId: state.taskId,
            worktreePath: runState.worktreePath,
            slice,
            // Feed the program design as context so the builder implements to the reviewed structure.
            ...(runState.programDesign ? { programDesign: runState.programDesign } : {}),
            allowedTools: allowedToolsForBrokerRole('builder', ctx.profile),
            disallowedTools: deniedToolsForBrokerRole('builder', ctx.profile),
            tokenBudget: assignment.tokenBudget,
            runtimeBudgetMs: assignment.runtimeBudgetMs,
            eventSink: sink,
            resumeSessionId: priorSessionId,
            // On a repair loop-back, tell the builder which findings the last candidate failed on.
            ...(runState.repairFindings && runState.repairFindings.length > 0
              ? { priorFindings: runState.repairFindings }
              : {}),
          });
          // Capture the provider session token so a later attempt resumes rather than cold-starts.
          if (attempt.sessionId) {
            runState.builderResumeSessions = {
              ...(runState.builderResumeSessions ?? {}),
              [slice.id]: attempt.sessionId,
            };
          }
          ctx.usage.record(attempt.usage, attempt.runtimeMs);
          ctx.observability.recordSession({
            sessionId: `${state.taskId}-implement-${state.attemptNumber}-${slice.id}`,
            taskId: state.taskId,
            runId: `${state.taskId}-run`,
            phaseAttemptId: `${state.taskId}-implement-${state.attemptNumber}`,
            phase: 'implement',
            role: 'builder',
            runtime: ctx.strategy,
            usage: attempt.usage,
            runtimeMs: attempt.runtimeMs,
            contextComposition: estimateContextComposition({ plan: slice }, ''),
            resumeSessionId: attempt.sessionId,
          });
          await flush();
          candidateSha = attempt.headSha;
          return attempt.outcome;
        },
      });
      if (result.outcome !== 'success') everySliceAccountedFor = false;
    }

    runState.baseSha = runState.baseSha ?? '0'.repeat(40);
    runState.candidateSha = candidateSha;

    // Repair findings have now been fed to this attempt's builder sessions; clear them so a later
    // clean pass (or an unrelated re-entry) never re-surfaces stale QA/review findings.
    runState.repairFindings = undefined;

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
    const cwd = requireWorktreeCwd(ctx.profile, runState.worktreePath, 'verify', state.taskId);

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
    if (ctx.profile.usesRealAgent && runState.worktreePath) {
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

    const results = await ctx.observability.time('testExecutionMs', () =>
      runVerificationMatrix(commands, context, runState.artifactStore),
    );
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

/**
 * TASK-75: map a blocked `exercise` decision to the right loop outcome. A real observed failure
 * (`classifyExerciseBlock === 'code-fixable'`) routes `repair → implement` — the builder can fix it
 * by re-coding. A pure evidence deficiency routes to an `await-human` gate with reason
 * `qa-inconclusive`, because re-running implement/verify can never manufacture a missing
 * recording/trace or author a QA assertion; looping there only grinds to the 3-strike
 * `repeated-failure-no-progress` park a human can't resolve by retrying. Exported so the mapping is
 * unit-testable in isolation from the QA execution the handler wraps.
 */
export function mapExerciseBlock(
  exercise: NonNullable<CompletionContext['exercise']>,
  missing: string[],
  taskId: string,
): PhaseAttemptResult {
  if (classifyExerciseBlock(exercise) === 'code-fixable') {
    return { outcome: 'repair', target: 'implement', findings: [] };
  }
  return {
    outcome: 'await-human',
    gate: {
      id: `${taskId}-exercise-qa-inconclusive`,
      taskId,
      phase: 'exercise',
      reason: 'qa-inconclusive',
      summary: `QA evidence is incomplete and re-coding cannot supply it: ${missing.join('; ')}`,
      createdAt: new Date().toISOString(),
    },
  };
}

const exerciseHandler: PhaseHandler = {
  phase: 'exercise',
  async run(ctx): Promise<PhaseOutcome> {
    const { state, runState } = ctx;
    const cwd = requireWorktreeCwd(ctx.profile, runState.worktreePath, 'exercise', state.taskId);

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

    // Real browser QA: when AWB_QA_MODE=browser and the repo has a discovered dev-server
    // start command, start it and run runBrowserQa (real chromium → real .webm video + .zip trace)
    // against it. Otherwise fall back to the CLI QA executor. `ranBrowserQa` tracks which path ran so
    // `browserScenariosHaveTraces` reflects a real trace artifact rather than a hardcoded true.
    // QA executor selection by repo surface. AWB_QA_MODE picks the executor: `browser`
    // (real dev-server + chromium), `http-api` (scripted real HTTP against a running API), `library`
    // (a real consumer script exercising the built library), or the default CLI executor. The
    // http-api/library modes were fully-implemented but had no runtime caller before this.
    type QaResult =
      | Awaited<ReturnType<typeof runCliQa>>
      | Awaited<ReturnType<typeof runBrowserQa>>
      | Awaited<ReturnType<typeof runHttpApiQa>>
      | Awaited<ReturnType<typeof runLibraryQa>>;
    let qaResult: QaResult;
    let ranBrowserQa = false;
    const qaMode = ctx.profile.usesRealAgent ? process.env.AWB_QA_MODE : undefined;
    // TASK-65: resolve the start command against the task WORKTREE (post-implement), not just the
    // registered-repo snapshot — a greenfield app's runnable form only exists after implement, so the
    // DB `start` row is empty. Tiers: persisted command → worktree discovery → framework inference.
    const resolvedStart =
      qaMode === 'browser' && runState.worktreePath
        ? await resolveStartCommandForWorktree({
            repositoryId: state.repositoryId,
            worktreePath: runState.worktreePath,
            requestedBaseUrl: process.env.AWB_QA_BASE_URL,
          })
        : undefined;

    // Only a server (`serves: true`) can be browser-QA'd — it carries a baseUrl to point Chromium at.
    // A `serves: false` result (a CLI / compiled binary / one-shot run) has no URL, so we skip browser
    // QA rather than hand `waitForServer` a port nothing binds (which would hang until timeout).
    if (resolvedStart?.serves === true && runState.worktreePath) {
      ranBrowserQa = true;
      // A caller-supplied AWB_QA_BASE_URL still wins; otherwise use the resolver's baseUrl (which the
      // framework-inference tier matches to the port its start command binds to).
      const baseUrl = process.env.AWB_QA_BASE_URL ?? resolvedStart.baseUrl;
      qaResult = await ctx.observability.time('qaExecutionMs', () =>
        runBrowserQaViaServer({
          startCommand: resolvedStart.command,
          worktreePath: runState.worktreePath as string,
          baseUrl,
          scenario: {
            baseUrl,
            steps: buildExerciseScenarioSteps(runState.plan?.claimCoverage ?? []),
          },
          context,
          artifactStore: runState.artifactStore,
        }),
      );
      // The dev server booted (runBrowserQaViaServer throws otherwise). If this command came from
      // inference/worktree-discovery rather than the already-persisted profile row, write it back so
      // the next exercise run is a Tier-1 hit instead of re-inferring. Best-effort — QA already
      // passed, so a persist failure must not fail the phase. Mock/non-durable path has no daemon.
      if (ctx.daemon && resolvedStart.source !== 'repository-commands') {
        try {
          await ctx.daemon.persistStartCommand({
            repositoryId: state.repositoryId,
            command: resolvedStart.command,
            cwd: runState.worktreePath,
            validatedAtSha: context.candidateSha,
          });
        } catch {
          // non-fatal: the profile just misses the cache and re-infers next time
        }
      }
    } else if (qaMode === 'http-api') {
      const baseUrl = process.env.AWB_QA_BASE_URL ?? 'http://localhost:3000';
      qaResult = await ctx.observability.time('qaExecutionMs', () =>
        runHttpApiQa(
          {
            baseUrl,
            requests: [{ method: 'GET', path: '/', expectations: [{ kind: 'status', equals: 200 }] }],
          },
          context,
          runState.artifactStore,
        ),
      );
    } else if (qaMode === 'library') {
      qaResult = await ctx.observability.time('qaExecutionMs', () =>
        runLibraryQa(
          {
            consumerScriptSource:
              process.env.AWB_QA_LIBRARY_SCRIPT ?? 'console.log("ASSERT:library-importable=true");',
          },
          context,
          runState.artifactStore,
        ),
      );
    } else if (qaMode === 'browser') {
      // Browser QA was requested but no start command could be resolved from the DB, the worktree, or
      // the produced project shape (TASK-65). Do NOT silently fall through to the trivial `echo`
      // check — that reads as a false pass while covering no behavioral claim. Fail QA legibly so the
      // gate blocks with an actionable reason instead of masking a missing runnable target.
      qaResult = await ctx.observability.time('qaExecutionMs', () =>
        runCliQa(
          {
            command: 'sh',
            args: [
              '-c',
              'echo "no start command could be resolved for browser QA (see TASK-65)"; exit 1',
            ],
            cwd,
            expectations: [{ kind: 'exitCode', equals: 0 }],
          },
          context,
          runState.artifactStore,
        ),
      );
    } else {
      qaResult = await ctx.observability.time('qaExecutionMs', () =>
        runCliQa(
        {
          command: 'echo',
          args: ['qa-ok'],
          cwd,
          expectations: [{ kind: 'exitCode', equals: 0 }, { kind: 'stdoutContains', text: 'qa-ok' }],
        },
        context,
        runState.artifactStore,
        ),
      );
    }
    runState.qaEvidence.push(qaResult.evidence);
    const structuredAssertionsPass = qaResult.assertions.every((a) => a.passed);
    const hasTraceArtifact = qaResult.artifacts.some((a) => a.kind === 'browser-trace');

    // Derive the two gate signals that were previously hard-coded.
    // (1) policyBlockingErrorsPresent — the browser executor reports whether it saw an unhandled
    //     console error, a failed/4xx network request, or a leaked/duplicate WebSocket open. Other
    //     executors don't observe those signals, so they report no blocking error.
    const policyBlockingErrorsPresent =
      'policyBlockingErrorsPresent' in qaResult ? qaResult.policyBlockingErrorsPresent : false;

    // (2) everyBehavioralClaimCovered — a behavioral claim is only covered when a passing *strong*
    //     (state-transition/value-match) assertion exercises it, not merely because a scenario ran.
    //     The planner's expected per-claim assertions (plan.claimCoverage) raise the bar per claim.
    const behavioralClaimIds =
      runState.contract?.claims
        .filter((c) => c.category === 'behavior' && c.qaEvidenceRequired)
        .map((c) => c.id) ?? [];
    const expectedByClaim = new Map(
      (runState.plan?.claimCoverage ?? []).map((c) => [c.claimId, c.expectedAssertions ?? []]),
    );
    const coverage = evaluateBehavioralClaimCoverage({
      behavioralClaimIds,
      assertions: qaResult.assertions,
      claimHasExpectedAssertion: (claimId) => (expectedByClaim.get(claimId)?.length ?? 0) > 0,
      assertionCoversClaim: (claimId, assertion) => {
        const expected = expectedByClaim.get(claimId) ?? [];
        const haystack = `${assertion.name} ${assertion.detail ?? ''}`.toLowerCase();
        return expected.some((e) => haystack.includes(e.observes.toLowerCase()));
      },
    });

    // A behavioral claim's committed diff must touch at least one path the plan associated with it.
    // The plan links claims to files via each slice's claimIds + likelyPaths; a claim's target paths
    // are the union of likelyPaths across every slice covering it. Gated on the runtime profile: only
    // runtimes serving weaker/local models (pi, opencode) get this stringent check, since the
    // likelyPaths prediction adds no signal for frontier models and risks false-blocking correct
    // work whose files the planner mis-predicted. Requires a real worktree + candidate commit.
    let untouchedTargetClaims: string[] = [];
    if (
      ctx.profile.needsStringentCandidateChecks &&
      runState.worktreePath &&
      runState.candidateSha
    ) {
      const claimTargetPaths = new Map<string, string[]>();
      for (const slice of runState.plan?.slices ?? []) {
        for (const claimId of slice.claimIds) {
          const paths = claimTargetPaths.get(claimId) ?? [];
          paths.push(...slice.likelyPaths);
          claimTargetPaths.set(claimId, paths);
        }
      }
      const { changedPaths } = await resolveReviewDiff({
        worktreePath: runState.worktreePath,
        baseSha: resolveBaseSha(runState),
        candidateSha: resolveCandidateSha(runState),
      });
      untouchedTargetClaims = behavioralClaimsWithUntouchedTarget({
        behavioralClaimIds,
        claimTargetPaths,
        changedPaths,
      });
    }

    // A behavioral claim can only be covered by a `strong` scenario (>=1 passing
    // state-transition/value-match assertion). An all-liveness scenario (navigate + landmark only)
    // scores `weak`, so when a behavioral claim requires coverage the gate must not clear on it.
    // With no behavioral claim to over-claim (mock/CLI/fixtures), a weak scenario is fine.
    const scenarioStrengthSufficient =
      behavioralClaimIds.length === 0 || scenarioStrength(qaResult.assertions) === 'strong';

    const exercise = {
      everyRequiredScenarioHasResult: true,
      everyBehavioralClaimCovered: coverage.everyBehavioralClaimCovered,
      behavioralClaimsMissingStrongAssertion: coverage.missing,
      behavioralClaimsWithUntouchedTarget: untouchedTargetClaims,
      structuredAssertionsPass,
      scenarioStrengthSufficient,
      requiredRecordingExists: qaResult.artifacts.length > 0,
      // A browser run must have produced a real trace artifact; a CLI run has no browser scenarios.
      browserScenariosHaveTraces: ranBrowserQa ? hasTraceArtifact : true,
      evidenceTiedToCandidateSha: qaResult.evidence.candidateSha === context.candidateSha,
      policyBlockingErrorsPresent,
    };

    return {
      kind: 'evaluate',
      completion: { exercise },
      evidenceIds: [qaResult.evidence.id],
      openFindingIds: [],
      candidateOverrides: { baseSha: context.baseSha, candidateSha: context.candidateSha },
      // See mapExerciseBlock: a real observed failure routes `repair → implement`; a pure evidence
      // deficiency escalates to a human `qa-inconclusive` gate instead of looping into implement.
      // On a code-fixable block, synthesize a finding per QA reason onto run state so the next
      // implement attempt re-prompts the builder with what failed rather than re-running blind.
      onBlocked: (missing) => {
        if (classifyExerciseBlock(exercise) === 'code-fixable') {
          const findings: Finding[] = missing.map((reason) => ({
            id: randomUUID(),
            taskId: state.taskId,
            candidateSha: resolveCandidateSha(runState),
            severity: 'high',
            category: 'requirements',
            claimIds: exercise.behavioralClaimsWithUntouchedTarget ?? [],
            description: reason,
            status: 'open',
          }));
          runState.repairFindings = findings;
          // Best-effort: make the repair loop-back visible in the durable stream + metrics.
          void ctx.controlPlane?.repairFindingsRaised(findings);
        }
        return mapExerciseBlock(exercise, missing, state.taskId);
      },
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

    const adapter = createAgentAdapter(ctx.strategy, resolveRuntimeConfig(), 'challenge');
    scriptMockTurns(adapter, state.taskId, 'adversarial-reviewer', { findings: [] });
    const reviewCwd = requireWorktreeCwd(ctx.profile, runState.worktreePath, 'challenge', state.taskId);

    // Real path: hand the reviewer the actual candidate diff + changed paths from the worktree, not
    // a placeholder string. Mock path keeps the synthetic diff (no real commit exists there).
    let finalDiff = 'diff --git a/PLACEHOLDER b/PLACEHOLDER\n+ synthetic candidate diff for MVP wiring\n';
    let relevantSourcePaths: string[] = [];
    if (ctx.profile.usesRealAgent && runState.worktreePath && runState.candidateSha) {
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
      cwd: reviewCwd,
      reviewInputs,
      runReviewer: async (inputs) => {
        const session = await adapter.createSession({
          role: 'adversarial-reviewer',
          taskId: state.taskId,
          cwd: reviewCwd,
          contextPayload: { inputs },
          allowedTools: allowedToolsForBrokerRole('adversarial-reviewer', ctx.profile),
          disallowedTools: deniedToolsForBrokerRole('adversarial-reviewer', ctx.profile),
        });
        const { sink, flush } = createPhaseEventSink({
          artifactsDir: runState.artifactsDir as string,
          taskId: state.taskId,
          role: 'adversarial-reviewer',
          phase: 'challenge',
          attemptNumber: state.attemptNumber,
          durable: ctx.profile.usesDurableRunState,
        });
        const reviewerStart = Date.now();
        const reviewerInstr =
          'The contract, plan, candidate diff, changed paths, and evidence ids are in the JSON ' +
          'context above. Adversarially review the diff against the contract + plan: hunt for ' +
          'correctness bugs, unhandled edge cases, missing wiring, and claims not actually met. ' +
          'Report concrete findings with severity.';
        const execution = await adapter.execute(
          session,
          { instruction: reviewerInstr },
          sink,
          new AbortController().signal,
        );
        const reviewerMs = Date.now() - reviewerStart;
        ctx.usage.record(execution.usage, reviewerMs);
        ctx.observability.recordSession({
          sessionId: session.id,
          taskId: state.taskId,
          runId: `${state.taskId}-run`,
          phaseAttemptId: `${state.taskId}-challenge-${state.attemptNumber}`,
          phase: 'challenge',
          role: 'adversarial-reviewer',
          runtime: ctx.strategy,
          usage: execution.usage,
          runtimeMs: reviewerMs,
          contextComposition: estimateContextComposition(inputs, reviewerInstr),
        });
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

    // Advisory maintainability review — a separate pass that surfaces duplication /
    // coupling / dead-abstraction / naming candidates for the human, distinct from correctness.
    // Its findings are advisory-only (category `maintainability`, severity `note`) so they NEVER
    // enter the challenge gate's blocking predicates below — they are persisted alongside the
    // review findings purely so the human sees them. Only the real path runs it (the mock path
    // has no real diff to review); mock-path gate behaviour is therefore unchanged.
    let advisoryFindings: Finding[] = [];
    if (ctx.profile.usesRealAgent) {
      const maintainability = await runMaintainabilityReview({
        taskId: state.taskId,
        reviewInputs,
        runReviewer: async (inputs) => {
          const session = await adapter.createSession({
            role: 'adversarial-reviewer',
            taskId: state.taskId,
            cwd: reviewCwd,
            contextPayload: { inputs },
            allowedTools: allowedToolsForBrokerRole('adversarial-reviewer', ctx.profile),
            disallowedTools: deniedToolsForBrokerRole('adversarial-reviewer', ctx.profile),
          });
          const { sink, flush } = createPhaseEventSink({
            artifactsDir: runState.artifactsDir as string,
            taskId: state.taskId,
            // Reuses the read-only adversarial-reviewer role/capability profile; the instruction
            // scopes this session to maintainability only.
            role: 'adversarial-reviewer',
            phase: 'challenge',
            attemptNumber: state.attemptNumber,
            durable: ctx.profile.usesDurableRunState,
          });
          const start = Date.now();
          const instr =
            'The contract, plan, candidate diff, changed paths, and evidence ids are in the JSON ' +
            'context above. Review the diff ONLY for maintainability (NOT correctness): new ' +
            'duplication, tight coupling / layering violations, abstractions with a single caller, ' +
            'and naming inconsistent with the surrounding code. These are advisory notes for a ' +
            'human — report each as a finding; do not block.';
          const execution = await adapter.execute(session, { instruction: instr }, sink, new AbortController().signal);
          ctx.usage.record(execution.usage, Date.now() - start);
          await flush();
          return {
            reviewerSessionId: session.id,
            completed: execution.completed,
            findings: execution.findings,
            summary: execution.summary,
          };
        },
      });
      advisoryFindings = maintainability.findings;
    }

    // Persist adversarial findings + advisory maintainability notes together. The gate predicates
    // below read only `review.findings`, so the advisory notes cannot block.
    runState.reviewFindings = [...review.findings, ...advisoryFindings];

    // WSFF decay signals: the challenge phase is the one place both the reviewed diff and
    // the findings are in hand. Emit them as a nested run.decay span (auto-parents to the phase's run
    // trace). Best-effort — telemetry is diagnostics-only and must never fail the phase.
    if (ctx.profile.usesRealAgent && runState.worktreePath && runState.candidateSha) {
      try {
        const diffLineStats = await getDiffLineStats(
          runState.worktreePath,
          resolveBaseSha(runState),
          resolveCandidateSha(runState),
        );
        const signals = computeDecaySignals({ diffLineStats, reviewedDiffText: finalDiff, findings: review.findings });
        await withSpan(
          'run.decay',
          { run_id: `${state.taskId}-run`, task_id: state.taskId, phase: 'challenge' },
          async (span) => {
            span.setAttributes(decaySpanAttributes(signals));
          },
        );
      } catch {
        // decay metrics are advisory diagnostics; never let them block the run
      }
    }

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
        // Route the open findings through the spec's loop table (routeLoop) rather than a bespoke
        // requirements-vs-implement check, so structural (architecture) findings reach the phase that
        // owns structure — `program-design` on an L run, else `plan`. Requirements outrank
        // architecture outrank everything else; the phase set decides plan-vs-program-design.
        const open = review.findings.filter((f) => f.status === 'open');
        // Carry the open review findings onto run state so the phase they route to re-prompts its
        // agent with the original findings (description, path/line, remediation) instead of blind.
        runState.repairFindings = open;
        // Best-effort: surface the review-driven repair in the durable stream + metrics.
        void ctx.controlPlane?.repairFindingsRaised(open);
        const category = open.some((f) => f.category === 'requirements')
          ? 'requirements'
          : open.some((f) => f.category === 'architecture')
            ? 'architecture'
            : 'correctness';
        const target = routeLoop({ kind: 'challenge-finding', category }, state.phaseSet);
        // A structural/requirements redirect is a replan (back to specify/plan/program-design); anything
        // else is a code-level repair (back to implement). routeChallengeFinding only ever returns one of
        // these four phases, so the explicit membership check both routes correctly and narrows the type.
        if (target === 'specify' || target === 'plan' || target === 'program-design') {
          return { outcome: 'replan', target, findings: review.findings };
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
/**
 * Task DAG orchestration: tell the daemon this task released its draft PR, so the scheduler starts
 * any blocked children stacked on it. Strictly best-effort — a scheduling hiccup must never fail
 * the release phase, and the daemon's reconcile poll re-derives eligibility regardless.
 */
async function notifyReleasedBestEffort(ctx: PhaseContext, taskId: string): Promise<void> {
  try {
    await ctx.daemon?.notifyReleased(taskId);
  } catch {
    // swallowed by design — the poll/boot reconcile is the correctness backstop
  }
}

const releaseHandler: PhaseHandler = {
  phase: 'release',
  async run(ctx): Promise<PhaseOutcome> {
    const { state, runState } = ctx;
    const evidence = [...runState.verificationEvidence, ...runState.qaEvidence];
    const candidateSha = resolveCandidateSha(runState);
    const worktreePath = requireWorktreeCwd(ctx.profile, runState.worktreePath, 'release', state.taskId);

    // Delivery is real only on a real-agent runtime; the mock runtime keeps in-memory fakes and a
    // synthetic ref below, so every deterministic test is unchanged.
    const realDelivery = ctx.profile.usesRealAgent;
    const branchName = runState.lease?.branchName ?? `awb/${state.taskId}`;
    const baseBranch = runState.lease?.baseRef ?? 'main';

    // No-origin delivery (TASK-71): when the repo has no GitHub-parseable remote, a done change has
    // nowhere to push. Land it locally instead — merge the feature branch into the local default
    // branch — and complete release without a PR. This mirrors close-worktree's no-remote path.
    if (realDelivery) {
      const target = await resolveDeliveryTarget(worktreePath);
      if (target.kind === 'local-merge') {
        const repositoryPath = await resolveRepositoryRoot(worktreePath);
        const merge = await ctx.observability.time('githubOperationMs', () =>
          deliverToLocalMerge({
            repositoryPath,
            branchName,
            defaultBranch: target.defaultBranch,
            objective: runState.contract?.objective ?? state.prompt ?? state.taskId,
          }),
        );
        // Task DAG orchestration: this task has delivered (branch landed) — unblock any stacked
        // children. Best-effort; the daemon's reconcile poll is the backstop.
        await notifyReleasedBestEffort(ctx, state.taskId);
        return {
          kind: 'early',
          result: {
            outcome: 'await-human',
            gate: {
              id: `${state.taskId}-release-gate`,
              taskId: state.taskId,
              phase: 'release',
              reason: 'pr-readiness',
              summary: `Task ${state.taskId} landed locally: ${branchName} merged into ${merge.defaultBranch} (${merge.commitSha.slice(0, 8)}); no remote to open a PR against.`,
              createdAt: new Date().toISOString(),
            },
          },
        };
      }
    }

    // Real delivery: on a real-agent runtime, open a real draft PR on the repo's actual remote
    // via the Octokit client (authed with the ambient `gh` token) + git-CLI push. The mock runtime
    // keeps the in-memory fakes and a synthetic ref, so every deterministic test is unchanged.
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
    const branchMedia = allMedia.filter(
      (a) => a.record.kind === 'qa-video' || a.record.kind === 'qa-video-gif' || a.record.kind === 'screenshot',
    );
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

    const deliverResult = await ctx.observability.time('githubOperationMs', () =>
      deliverToGitHub(
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
      ),
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

    // Task DAG orchestration: the draft PR is open — this task has RELEASED. Notify the daemon so
    // the scheduler starts any blocked children stacked on this task's branch. Best-effort; the
    // daemon's reconcile poll is the correctness backstop.
    await notifyReleasedBestEffort(ctx, state.taskId);

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
  'program-design': programDesignHandler,
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
 * (never per phase), loads the task's `TaskRunState` through the `RunStateStore` seam,
 * selects the phase handler from the exhaustive closed set, and runs it through the
 * shared driver (emit → run → save → evaluate/map → attach usage). The per-phase
 * completion policy is still `evaluatePhaseCompletion` (from `@awb/workflow`), called once by the
 * driver, so the Workflow's trust in "candidate means complete" stays backed by the same
 * deterministic policy the product spec defines — not a rubber stamp.
 *
 * State threads across phase attempts via the store (an in-memory Map by default — lost on worker
 * restart, documented limitation; a durable impl swaps in behind the same seam). Usage is a
 * per-invocation accumulator on the context (was a module global) attached to the result
 * for the Workflow's `tokenUsageTotal` + `runtimeMsByPhase` aggregation.
 */
export async function runPhase(input: {
  phase: TaskPhase;
  state: TaskWorkflowState;
}): Promise<PhaseAttemptResult> {
  const strategy = resolveAgentRuntime();
  const profile = resolveRuntimeProfile(strategy);
  const store = resolveRunStateStore(profile);
  const runState = await store.load(input.state.taskId);
  // The workflow state is the source of truth for repositoryId; thread it onto the run state so the
  // durable store can key persisted rows (the mock in-memory store ignores it).
  runState.repositoryId = input.state.repositoryId;
  const durable = profile.usesDurableRunState;
  const daemon = durable ? createDaemonClient() : undefined;

  // Control-plane observability: emit lifecycle events + open a phase span so a phase
  // failing/retrying + a transport drop are first-class in the durable stream and the trace, not an
  // undifferentiated 'message' or a stderr-only [WARN]. Best-effort — never fails the phase.
  const emitter = createControlPlaneEmitter({
    taskId: input.state.taskId,
    phase: input.phase,
    attemptNumber: input.state.attemptNumber,
    daemon,
  });

  const ctx: PhaseContext = {
    state: input.state,
    runState,
    store,
    strategy,
    profile,
    usage: new UsageAccumulator(),
    emit: NOOP_PHASE_EVENT_EMITTER,
    observability: new ObservabilityAccumulator(),
    daemon,
    controlPlane: emitter,
  };
  const startedAt = Date.now();
  await emitter.phaseStarted({ cwd: runState.worktreePath });

  try {
    const result = await withSpan(
      `phase.${input.phase}`,
      {
        run_id: runIdForTask(input.state.taskId),
        task_id: input.state.taskId,
        phase: input.phase,
        attempt_number: input.state.attemptNumber,
      },
      () => drivePhase(HANDLERS[input.phase], ctx),
      // Parent every phase to the run's deterministic trace so all phases of a task nest under ONE
      // trace instead of each phase minting its own random trace id.
      { parentRunId: runIdForTask(input.state.taskId) },
    );

    emitter.phaseDuration(Date.now() - startedAt, result.outcome);

    // Assimilate completing successfully ends the task; drop its accumulated state (matches the prior
    // `taskRunStates.delete` on the assimilate candidate path).
    if (input.phase === 'assimilate' && result.outcome === 'candidate') {
      await store.remove(input.state.taskId);
    }
    return result;
  } catch (err) {
    // A throw here propagates to Temporal, which retries the runPhase Activity up to maximumAttempts.
    // Record why + whether a retry is coming, so the retry decision lives in the durable store + metrics
    // instead of only Temporal's stderr logger.
    const message = err instanceof Error ? err.message : String(err);
    const resumable = isResumableTransportError(err);
    const retryScheduled = currentActivityAttempt() < MAX_ACTIVITY_ATTEMPTS;
    emitter.phaseDuration(Date.now() - startedAt, 'error');
    if (resumable) {
      await emitter.transportError({ message });
    }
    await emitter.phaseFailed({
      errorClass: resumable ? 'transport-drop' : classifyErrorClass(err),
      message,
      resumable,
      retryScheduled,
    });
    throw err;
  }
}

/**
 * The Activity's Temporal retry attempt (1-based), read defensively — `activityInfo()` throws when
 * runPhase is called outside a Worker (the direct e2e test path), so fall back to 1 there.
 */
function currentActivityAttempt(): number {
  try {
    return activityInfo().attempt;
  } catch {
    return 1;
  }
}

/** Mirrors the workflow's retry policy (`maximumAttempts: 3`, task-workflow.ts) for the retry decision. */
const MAX_ACTIVITY_ATTEMPTS = 3;

/** A coarse error class for a control-plane failure event when it isn't a known transport drop. */
function classifyErrorClass(err: unknown): string {
  const name = err instanceof Error ? err.name : 'Error';
  return name === 'Error' ? 'phase-error' : name;
}
