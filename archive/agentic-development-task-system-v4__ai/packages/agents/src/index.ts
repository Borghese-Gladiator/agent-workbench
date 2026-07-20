/**
 * Agent Runtime Adapter — the abstraction for running a stage-specific agent
 * inside a task's worktree.
 *
 * This increment ships only the contract plus a deterministic
 * `MockAgentRuntimeAdapter`. A real implementation (Claude Code, etc.) will run
 * an actual coding agent and stream real artifacts/transcripts back, but it
 * plugs in behind the same `runStageAgent` method so the daemon never changes.
 *
 * The adapter is pure compute: it returns content (a transcript + produced
 * artifact bodies) and NEVER touches SQLite, disk, or git. The daemon persists
 * whatever comes back, keeping the browser→daemon→disk boundary intact.
 */

import {
  type AgentRunEventType,
  type AgentRuntime,
  type ArtifactKind,
  mockArtifactBody,
  mockArtifactTitle,
  type RuntimeConfig,
  type Stage,
} from '@workbench/core';
import type { Effort } from './effort.js';
import { ASK_TOOL, mapPolicyToClaude, policyForStage } from './policy.js';
import { runtimeProfile } from './runtime-profile.js';

/** The stages the mock adapter knows how to run. */
export const AGENT_STAGES = [
  'task_brief',
  'discovery',
  'feature_e2e',
  'agent_self_review',
] as const;

export type AgentStage = (typeof AGENT_STAGES)[number];

export function isAgentStage(value: unknown): value is AgentStage {
  return typeof value === 'string' && (AGENT_STAGES as readonly string[]).includes(value);
}

/** The artifact kind each runnable stage produces. */
export const STAGE_TO_ARTIFACT: Record<AgentStage, ArtifactKind> = {
  task_brief: 'task_brief',
  // Discovery and planning are one stage: it reads the codebase AND commits to a
  // plan, producing a single Execution Plan artifact (findings folded in).
  discovery: 'execution_plan',
  // The QA agent produces the durable demo/E2E proof bundle. The static_checks
  // stage (shell typecheck/test/lint) owns `validation_report` separately, written
  // by the driver — keeping the two halves as distinct artifacts.
  feature_e2e: 'demo_evidence',
  agent_self_review: 'self_review',
};

/**
 * Which prior-artifact KINDS each stage receives as inlined CONTEXT (full
 * bodies, not just ids). This is the fix for the turn-explosion root cause: a
 * stage that is told to consume the brief/plan/etc. must actually SEE them — the
 * bodies live in the daemon data dir, outside the agent's worktree sandbox, so
 * the agent cannot read them itself.
 *
 * Selection rules (deliberate):
 * - Only DURABLE, model-authored artifacts (brief / discovery / plan / validation
 *   / self-review). NEVER transcripts (`log`) or `diff` bodies — large, low-signal;
 *   the agent reads the real diff from git in its worktree.
 * - `raw_prompt` is omitted: it is already inlined as the `Request:` block.
 * - Only the LATEST body per kind is threaded (a re-run can produce several).
 * - Bodies are passed in FULL — no truncation. Truncating planning context would
 *   force the downstream stage to rediscover it, which is the exact bug we fix.
 *
 * Keyed by stage string (not just AgentStage) so the non-mock stages
 * (`implementation`, `delivery_prep`, `delivery_conflict`) participate too.
 */
export const STAGE_CONTEXT_KINDS: Record<string, ArtifactKind[]> = {
  task_brief: [],
  discovery: ['task_brief'],
  implementation: ['execution_plan', 'task_brief'],
  feature_e2e: ['execution_plan', 'task_brief'],
  agent_self_review: ['task_brief', 'execution_plan'],
  delivery_prep: ['execution_plan', 'validation_report', 'demo_evidence', 'self_review'],
  delivery_conflict: [],
};

/** The artifact kinds a stage receives as inlined context (full bodies). */
export function contextKindsForStage(stage: string): ArtifactKind[] {
  return STAGE_CONTEXT_KINDS[stage] ?? [];
}

/**
 * Stages that receive the project's memory log (durable decisions from prior
 * COMPLETED tasks). Scoped to `discovery` — the combined discovery+planning stage
 * — where prior decisions matter most and the agent is building understanding /
 * choosing an approach. Keeping it off implementation/review/verification avoids
 * re-introducing prompt/cost bloat.
 */
export const MEMORY_STAGES = new Set<string>(['discovery']);

/** Whether a stage should have the project memory log inlined into its prompt. */
export function stageWantsProjectMemory(stage: string): boolean {
  return MEMORY_STAGES.has(stage);
}

/**
 * The per-stage tool policy is now runtime-neutral (capabilities), defined in
 * `policy.ts`, with per-runtime mappers translating it to each runtime's tool
 * vocabulary. Re-exported here so existing importers keep working.
 */
export {
  ASK_TOOL,
  type Capability,
  type ClaudeToolPolicy,
  type CodexToolPolicy,
  DEFAULT_TOOL_POLICY,
  type MutationMode,
  mapPolicyToClaude,
  mapPolicyToCodex,
  mapPolicyToPi,
  type PiToolPolicy,
  policyForStage,
  STAGE_TOOL_POLICY,
  type StageToolPolicy,
} from './policy.js';

/** The Claude-named allowed-tool list for a stage (back-compat for the daemon). */
export function allowedToolsForStage(stage: string): string[] {
  return mapPolicyToClaude(policyForStage(stage)).allowedTools;
}

/** The Claude-named hard-denied tool list for a stage. */
export function disallowedToolsForStage(stage: string): string[] {
  return mapPolicyToClaude(policyForStage(stage)).disallowedTools;
}

// `Effort` lives in a leaf module so it can be read at top level by both this
// barrel and runtime-profile.ts without a circular-init hazard.
export { Effort } from './effort.js';

export interface AgentRunInput {
  taskId: string;
  stage: Stage;
  /** Working directory the agent would operate in, if a worktree exists. */
  worktreePath?: string;
  /** Artifact ids that make up the context packet handed to the agent. */
  contextArtifactIds: string[];
  /**
   * Resolved bodies of the prior artifacts this stage should READ (selected by
   * {@link contextKindsForStage}). Inlined into the prompt under `## Prior
   * context` so the agent doesn't re-derive what an upstream stage already wrote.
   * The daemon resolves ids -> bodies (it owns disk); the adapter stays pure.
   * Absent/empty for the first stage and on the resume path.
   */
  contextArtifacts?: { kind: ArtifactKind; title: string; body: string }[];
  /** Allowed tool policy — which tools the agent is permitted to use. */
  allowedTools: string[];
  /** Task title + raw request, so the mock can render plausible content. */
  taskTitle: string;
  rawRequest: string;
  /**
   * Ask the brief agent to surface a real, human-readable task title in its JSON
   * block (`title` key). Set ONLY for the `task_brief` stage when the current
   * title is generic (see {@link isGenericTitle}) — e.g. the request was just a
   * Linear URL and the title is a placeholder like "Linear Ticket". The daemon
   * reads that key back and renames the task before the worktree/branch are
   * created, so naming reflects the actual request. Absent otherwise.
   */
  deriveTitle?: boolean;
  /**
   * Reviewer feedback from the most recent rejection/bounce of this stage's
   * gate, if any. Threaded into the prompt so a regenerating agent actually
   * sees why the previous output was sent back.
   */
  reviewerFeedback?: string;
  /**
   * Wiring for the mid-run MCP question gate. When present (streaming runs of
   * the real claude CLI), the adapter spawns the CLI with a `workbench_ask` MCP
   * server as the permission-prompt tool; that server relays to the daemon at
   * `daemonUrl` for the given `runId`. Absent for one-shot/mock runs.
   */
  gate?: { daemonUrl: string; runId: string };
  /**
   * Skill instructions to inject into the stage prompt (review/QA stages). The
   * gated CLI path disables `.claude/skills/` discovery, so the daemon loads the
   * routed skill body (see `skills.ts`) and passes it here for inlining. Optional;
   * absent stages render unchanged.
   */
  skillText?: string;
  /**
   * Detected repo profile (from the skills router) used to verify the agent's
   * structured output carries the required skill-compliance proof. Absent for repos
   * with no enforced fields. See `verifyRepoSkillCompliance`.
   */
  repoProfile?: string;
  /**
   * Resume an existing Claude session instead of starting fresh. When set, the
   * adapter runs `claude --resume <sessionId>` and sends ONLY `message` as the
   * turn — no stage packet, no context ids, no reviewer-feedback block. This is
   * the brief-rejection path: the session already holds the full prior context,
   * so the reviewer's comment is the only new input. The produced artifact kind
   * still follows the stage.
   */
  resume?: { sessionId: string; message: string };
  /**
   * Per-run model override (`--model`), preferred over the adapter's constructed
   * default when set. The daemon fills this from {@link modelForStage} so cheap
   * stages run on a faster model without rebuilding the adapter per stage. Absent
   * -> the adapter uses its default model.
   */
  model?: string;
  /**
   * Per-run effort override (`--effort`). The daemon fills this from
   * {@link effortForStage} alongside {@link model}. Absent -> no `--effort` flag,
   * so the CLI/model default applies.
   */
  effort?: Effort;
  /**
   * Extra environment variables for the spawned CLI process (merged over
   * `process.env`). Used by the QA stage to point the shared Playwright harness
   * at the target app (QA_TARGET_DIR / QA_DEV_COMMAND / QA_BASE_URL / QA_SPEC_DIR
   * / QA_OUTPUT_DIR) so the agent runs the workbench's harness instead of
   * scaffolding Playwright into the target. Absent for stages that need no extra env.
   */
  env?: Record<string, string>;
  /**
   * External abort signal to terminate the run. The streaming adapter folds this
   * into its internal stall watchdog so an operator "stop session" kills the
   * spawned CLI subprocess (SIGKILL), surfacing a `failed` result. Absent for the
   * mock adapter and runs with no stop affordance.
   */
  signal?: AbortSignal;
  /**
   * The project's distilled memory log — durable decisions from earlier COMPLETED
   * tasks of THIS project. Inlined as a `## Project memory` section for the stages
   * in {@link MEMORY_STAGES} (the combined discovery stage) so a new task starts knowing
   * what the project already decided. Distinct from `contextArtifacts`, which is
   * the current task's own prior stages. Absent/empty when the project has none.
   */
  projectMemory?: string;
  /**
   * Send this exact string as the one-shot prompt INSTEAD of the stage packet
   * (`claudeStagePrompt`). Used by off-lifecycle one-shot runs (e.g. the closeout
   * memory summarizer) that aren't a real Stage and supply their own prompt. Like
   * `resume.message`, it bypasses prompt assembly; unlike resume, it starts a
   * fresh session. Ignored on the resume path (resume wins).
   */
  promptOverride?: string;
}

/** A piece of content the agent produced; the daemon turns these into artifacts. */
export interface ProducedArtifact {
  kind: ArtifactKind;
  title: string;
  body: string;
}

export interface AgentRunResult {
  status: 'succeeded' | 'failed';
  /** Full transcript of the run, stored as a `log` artifact by the daemon. */
  transcript: ProducedArtifact;
  /** Stage output artifacts (e.g. the Task Brief). Empty when the run failed. */
  produced: ProducedArtifact[];
  /** Present only when `status === 'failed'`. */
  error?: string;
  /**
   * The Claude CLI session id this run ran under, captured from the stream's
   * `system`/`init` event. The daemon persists it on the AgentRun so a later
   * run can `--resume` it. Absent for the mock adapter and one-shot JSON runs
   * that don't surface a session id.
   */
  sessionId?: string;
}

/**
 * A streamed event emitted by `streamStageAgent` as the run progresses. It is a
 * typed `(type, payload)` pair that the daemon persists as an `AgentRunEvent`
 * and forwards to SSE subscribers. `payload` is a bounded JSON value.
 */
export interface StreamEvent {
  type: AgentRunEventType;
  payload: unknown;
}

/**
 * A structured question the agent raises mid-run (Anthropic `AskUserQuestion`
 * shape). When `options` is null the answer is free text. A permission decision
 * is the degenerate case: two options (allow/deny).
 */
export interface AgentQuestionRequest {
  /** Short chip label, e.g. "Auth method". */
  header: string;
  /** Full question text. */
  question: string;
  /** 2–4 choices, or null for a free-text answer. */
  options: { label: string; description: string }[] | null;
  multiSelect: boolean;
  /**
   * Marks a question that originated from a tool-permission boundary rather than
   * a deliberate ask, so the daemon can render/record it as allow/deny.
   */
  permission?: { toolName: string; toolInput: unknown };
}

/** The human's answer to an `AgentQuestionRequest`. */
export type AgentQuestionAnswer = { selected: string[] } | { text: string };

/**
 * Handlers the daemon supplies to a streaming run:
 * - `onEvent` receives each streamed event in order.
 * - `requestInput` is awaited when the agent needs a human answer mid-run; it
 *   resolves once the human responds, and the run resumes. (Wired to the MCP
 *   permission-prompt tool in the Claude adapter.)
 */
export interface StreamHandlers {
  onEvent(event: StreamEvent): void;
  requestInput(question: AgentQuestionRequest): Promise<AgentQuestionAnswer>;
  /**
   * Called once with the spawned process group id, as soon as the child exists
   * (before any stream line). The daemon persists it so a later boot can reap an
   * orphaned process group. Optional + best-effort: adapters that spawn nothing
   * (mock) never call it, and a runner that can't determine a pgid omits it.
   */
  onSpawn?(pgid: number): void;
}

export interface AgentRuntimeAdapter {
  /** One-shot run: buffers internally and returns the final result. */
  runStageAgent(input: AgentRunInput): Promise<AgentRunResult>;
  /**
   * Streaming run: emits events through `handlers.onEvent` as they happen and
   * may pause for input via `handlers.requestInput`. Returns the same
   * `AgentRunResult` as `runStageAgent` on completion. Optional so existing
   * adapters keep compiling; `runStageAgent` is the always-present contract.
   */
  streamStageAgent?(input: AgentRunInput, handlers: StreamHandlers): Promise<AgentRunResult>;
}

/**
 * Buffering handlers that turn a streaming run into the one-shot contract:
 * events are discarded and any input request is auto-approved. Used so
 * `runStageAgent` can delegate to `streamStageAgent` without changing behavior.
 */
export function bufferingHandlers(): StreamHandlers {
  return {
    onEvent() {
      /* discard — one-shot callers don't observe events */
    },
    async requestInput(question) {
      // Auto-approve permission prompts; pick the first option otherwise.
      if (question.permission) return { selected: ['allow'] };
      if (question.options && question.options.length > 0) {
        return { selected: [question.options[0]!.label] };
      }
      return { text: '' };
    },
  };
}

/** Human-facing instruction for each runnable stage, used to build the packet. */
const STAGE_INSTRUCTIONS: Record<AgentStage, string> = {
  task_brief:
    'Write a Task Brief. Add a "## Acceptance Criteria" Markdown table ' +
    '(`ID | Requirement | Risk (H/M/L)`, stable IDs AC1, AC2, …) — ONE row per real, ' +
    'user-visible GOAL of this task, not per test case. Most tasks have 2–3 goals; ' +
    'these IDs are the durable contract later stages bind to. Add a brief scope note ' +
    'only if something is genuinely in/out of scope in a non-obvious way, and an ' +
    '"## Open assumptions" section ONLY where the request was actually ambiguous and ' +
    'you made a call — omit it entirely when nothing was ambiguous. Do not restate the ' +
    'request. Read-only — do not modify any files.',
  discovery:
    'Do Discovery and produce the Execution Plan in one pass. First find the files, ' +
    'modules, and conventions relevant to this task (where to change, what pattern to ' +
    'follow, what to watch out for) — keep this part tight, a small change warrants a ' +
    'few sentences, not a formatted report. Then commit to ONE approach and write the ' +
    'Execution Plan. The implementation stage runs as a SEPARATE agent that will NOT ' +
    're-explore the repo — it applies your plan directly — so the plan must carry every ' +
    'concrete fact it needs. Write the change list as a "## Changes" section with one ' +
    'entry per file in apply order, each as `### <path> — create|modify|delete` followed ' +
    'by a CONCRETE brief: for a modify, the exact functions/symbols/lines to touch and ' +
    'what they become (include the real current signature you confirmed while exploring, ' +
    'not a paraphrase); for a create, the shape of the file (key functions/exports + ' +
    'behavior). The bar: a competent implementer could apply each entry WITHOUT opening ' +
    'the file first. Do not list rejected alternatives unless a real fork needs the ' +
    'operator to decide (see "Asking the operator"). Include a "## Validation by ' +
    'criterion" table (`Criterion ID | Validation method | Test type | Automated?`) — ' +
    'one row per Acceptance Criteria ID from the brief, binding each to how it will be ' +
    'proven (test type = unit/integration/e2e/manual; Automated? = yes/no). Every brief ' +
    'criterion must appear; if one cannot be validated, say so and why. Read-only — ' +
    'do not modify any files.',
  feature_e2e:
    'Verification: run the end-to-end Playwright suite and assemble a durable proof ' +
    'bundle (video + trace + verdict), then produce a validation report summarising ' +
    'typecheck/lint/test results and the E2E outcome. For EACH scenario, answer the gate ' +
    '"would this have failed before this change?" (yes = it genuinely proves the change; ' +
    'no = the scenario is not actually exercising the new behavior — flag it). Include a ' +
    '"## Criterion coverage" table mapping each Acceptance Criteria ID to the scenario(s) ' +
    'that prove it; any unmapped criterion is a coverage gap, not a pass. Run everything ' +
    'via the QA skills below; do not modify source files.',
  agent_self_review:
    'Self-review the implementation. Run `git diff` (against the base) ONCE to get the ' +
    'scope of what this task changed, then review it against the Acceptance Criteria in ' +
    'the Task Brief and the per-file briefs in the Execution Plan (both in your context) — ' +
    'judging what looks correct, risky, or missing. HOW to run the review (inline here, or ' +
    'dispatched to subagents) is dictated by the injected skill instructions below — follow ' +
    'them exactly; do not add a subagent layer they do not call for. Read-only — do not ' +
    'edit files.',
};

/**
 * Instruction + artifact kind for stages that run a REAL coding agent but are NOT
 * `AGENT_STAGES` (the mock-runnable, read-only set). `implementation` is the
 * mutating stage: it actually edits the worktree, so the mock can't fake it, but
 * the real claude adapter still needs a concrete prompt + the edit tool policy.
 */
const NON_MOCK_STAGE_INSTRUCTIONS: Partial<
  Record<string, { instruction: string; kind: ArtifactKind }>
> = {
  implementation: {
    instruction:
      "Implementation: apply the approved Execution Plan's `## Changes` list. The plan " +
      'already mapped the repo and specified each file change concretely — treat it as ' +
      'authoritative and DO NOT re-survey the repo (no `pwd`/`ls`/`cat`/glob to re-learn ' +
      'the layout) and do NOT re-read a file just to confirm what the plan already states. ' +
      'Go straight to the edits: apply each change entry in order, creating and editing ' +
      "files as the plan specifies. Open a file ONLY when the plan's brief is genuinely " +
      'insufficient to apply the change (e.g. an exact anchor it omitted) — that is the ' +
      'exception, not the default. Do NOT re-plan or re-scope; implement what was ' +
      'approved. After applying the changes, run the project checks to verify your work. ' +
      'Keep changes focused on the task.',
    kind: 'diff',
  },
  delivery_conflict: {
    instruction:
      'Delivery blocked by merge conflicts. The conflicted files and the base branch are listed in the feedback below. Reproduce the merge in the working tree (e.g. `git merge <base>`), resolve every conflict so both intents are preserved where sensible, and do NOT change unrelated code. When done, the working tree must be conflict-free and committable (no remaining `<<<<<<<`/`=======`/`>>>>>>>` markers). Do not push or open a PR — delivery is re-attempted automatically after you finish.',
    kind: 'log',
  },
  delivery_prep: {
    instruction:
      'Delivery preparation: write the delivery artifact for this task from the REAL branch diff and the prior task artifacts (plan / validation / self-review). The body you produce is used verbatim as the PR description or the squash-commit message, so it must stand alone. Read-only on source — inspect the diff with git, do NOT edit files. The active delivery policy and the writing standard are in the injected skill below; follow it exactly.',
    kind: 'delivery_package',
  },
};

/**
 * Stages where the agent is allowed (and instructed) to ask the operator a
 * deliberate question via {@link ASK_TOOL}. Must stay in sync with the stages
 * whose `allowedTools` include `ASK_TOOL`.
 */
export const ASK_STAGES = new Set<AgentStage>(['discovery']);

/** A stage-prompt clause telling the agent when/how to ask the operator. */
const ASK_INSTRUCTION = [
  '',
  '## Asking the operator',
  'Ask ONLY when ALL of these are true:',
  '1. There are at least two genuinely viable choices.',
  '2. The choice changes the implementation or user-visible behavior.',
  '3. The task, prior context, and existing project conventions do NOT already make',
  '   one choice the obvious default.',
  '4. Getting it wrong has a meaningful cost.',
  'Do NOT ask about naming, file placement, style, test examples, or error wording when',
  'project conventions give a reasonable default — just pick it. When you do ask, call the',
  '`mcp__ask__workbench_ask` tool with a short `header`, the `question`, and 2–4 labelled',
  '`options` (each with a `description`); set `multiSelect: true` only if more than one may',
  'apply. Wait for the answer, then continue.',
].join('\n');

/**
 * A `task_brief` clause asking the agent to name the task. Added only when the
 * current title is generic (see {@link isGenericTitle}) — typically the request
 * was just a Linear/issue URL and the title is a placeholder. The agent has
 * already read the request (and, for enterprise repos, the linked ticket via the
 * Linear MCP), so it can produce a real title. The daemon reads `title` back out
 * of the JSON block and renames the task.
 */
const DERIVE_TITLE_INSTRUCTION = [
  '',
  '## Naming this task',
  'The current task title is a placeholder, not a real name. Include a `title` key in',
  'your final json block: a concise, specific, imperative summary of what this task',
  'actually does (e.g. "Add CSV export to the campaigns report"), derived from the real',
  'request — including the linked ticket if the request is just a URL. Do NOT echo the',
  'URL, the ticket id alone, or a generic label like "Linear Ticket" as the title.',
].join('\n');

/**
 * Whether a task title is a placeholder rather than a real name — the trigger for
 * asking the brief agent to derive one. True for empty/very short strings, bare
 * URLs, a lone issue id (e.g. `CORE-242`), and known generic labels. False for
 * any title that reads like an actual description of the work.
 */
export function isGenericTitle(title: string): boolean {
  const t = title.trim();
  if (t.length < 4) return true;
  const lower = t.toLowerCase();
  // Known placeholder labels.
  if (['task', 'linear ticket', 'ticket', 'untitled', 'new task'].includes(lower)) return true;
  // A bare URL (the whole title is one token starting with a scheme).
  if (/^https?:\/\/\S+$/.test(t)) return true;
  // A lone issue identifier like CORE-242 with nothing else.
  if (/^[a-z]+-\d+$/i.test(t)) return true;
  return false;
}

const ARTIFACT_LABELS: Record<string, string> = {
  task_brief: 'Task Brief',
  discovery: 'Discovery',
  execution_plan: 'Execution Plan',
  validation_report: 'Validation Report',
  demo_evidence: 'Demo Evidence',
  self_review: 'Self-Review',
  delivery_package: 'Delivery Package',
};

/**
 * Strip the machine-readable noise from an artifact body before inlining it as
 * CONTEXT for a downstream stage: the fenced ```json block(s) the agent emits as
 * its structured summary, plus any trailing `## Structured summary` heading that
 * introduced one. A downstream stage reads the PROSE — the json is a dup of what
 * the prose already says and only inflates the prompt. Storage keeps the json
 * (gates/UI); this trimming applies only to the threaded copy.
 */
export function stripStructuredJson(body: string): string {
  return body
    .replace(/```json\s*\n[\s\S]*?```/gi, '')
    .replace(/^#{1,6}\s*Structured summary\s*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Render the `## Prior context` section: the bodies of the upstream artifacts
 * this stage consumes (PROSE only — the redundant structured-json is stripped),
 * so the agent reads them instead of re-deriving them. Each body is headed by
 * its kind label. Returns `[]` when there is no context to inline (the section
 * is omitted entirely).
 */
function renderPriorContext(artifacts: AgentRunInput['contextArtifacts']): string[] {
  if (!artifacts?.length) return [];
  const lines: string[] = [
    `## Prior context`,
    `The following artifacts were produced by EARLIER stages of THIS task. They`,
    `are the authoritative record of what was already decided/understood — read`,
    `them and build on them; do NOT re-derive what they already cover.`,
    ``,
  ];
  for (const a of artifacts) {
    const label = ARTIFACT_LABELS[a.kind] ?? a.kind;
    lines.push(`### ${label} — ${a.title}`, ``, stripStructuredJson(a.body), ``);
  }
  return lines;
}

/**
 * Render the `## Project memory` section: durable decisions from earlier
 * COMPLETED tasks of this project (distinct from `## Prior context`, which is
 * this task's own upstream stages). Returns `[]` when there is no memory yet.
 */
function renderProjectMemory(memory: string | undefined): string[] {
  const body = memory?.trim();
  if (!body) return [];
  return [
    `## Project memory`,
    `Durable decisions from EARLIER COMPLETED tasks of THIS project (architecture,`,
    `implementation, naming, conventions, and the reasoning). They are precedent:`,
    `follow them unless this task's request explicitly overrides one, and call out`,
    `any conflict you find rather than silently diverging.`,
    ``,
    body,
    ``,
  ];
}

/**
 * Build the stage packet — the context the agent receives. It is the current
 * stage's instruction, the task title/request, the FULL bodies of the upstream
 * artifacts this stage consumes (`## Prior context`), and the ids of all context
 * artifacts (footnote). It deliberately does NOT include task history, stage
 * runs, approvals, or other tasks.
 *
 * Asks the agent to end with a fenced ```json block so the daemon can store a
 * structured artifact alongside the prose.
 */
export function assembleStagePrompt(input: AgentRunInput): string {
  const nonMock = NON_MOCK_STAGE_INSTRUCTIONS[input.stage];
  const instruction = isAgentStage(input.stage)
    ? STAGE_INSTRUCTIONS[input.stage]
    : (nonMock?.instruction ?? `Run the "${input.stage}" stage.`);
  const kind = isAgentStage(input.stage)
    ? STAGE_TO_ARTIFACT[input.stage]
    : (nonMock?.kind ?? 'log');
  // Only invite the agent to ask when the gate is actually wired (the ask tool
  // exists this run) AND the stage is ask-enabled — otherwise it would call a
  // tool that isn't present.
  const canAsk = Boolean(input.gate) && isAgentStage(input.stage) && ASK_STAGES.has(input.stage);
  return [
    `# Stage: ${input.stage}`,
    ``,
    `## Task`,
    `Title: ${input.taskTitle}`,
    ``,
    `Request:`,
    input.rawRequest,
    ``,
    `## Your job`,
    instruction,
    input.deriveTitle ? DERIVE_TITLE_INSTRUCTION : ``,
    canAsk ? ASK_INSTRUCTION : ``,
    ``,
    ...renderProjectMemory(input.projectMemory),
    ...renderPriorContext(input.contextArtifacts),
    input.contextArtifactIds.length
      ? `_All context artifact ids for this task: ${input.contextArtifactIds.join(', ')}._`
      : `No prior context artifacts.`,
    ``,
    // Skill injection: the gated CLI path can't auto-load `.claude/skills/`, so the
    // daemon inlines the routed review/QA skill here. Only rendered when present.
    ...(input.skillText ? [`## Skill`, ``, input.skillText, ``] : []),
    ...(input.reviewerFeedback?.trim()
      ? input.stage === 'agent_self_review'
        ? [
            `## Re-review (scoped — this is NOT a fresh review)`,
            `This change was already self-reviewed and then sent back. Your job now is`,
            `narrow: confirm the prior findings were resolved in the new diff, and flag`,
            `ONLY new *blocking* regressions the fix introduced. Do NOT re-surface fresh`,
            `nice-to-haves, style nits, or should-fix items as blockers — those do not`,
            `bounce. The verdict is \`request_changes\` only if a prior finding is still`,
            `unresolved OR the fix introduced a new blocking bug; otherwise \`approve\`.`,
            ``,
            input.reviewerFeedback.trim(),
            ``,
          ]
        : [
            `## Reviewer feedback to address`,
            `A previous attempt at this stage was sent back. Address this feedback:`,
            input.reviewerFeedback.trim(),
            ``,
          ]
      : []),
    `## Output`,
    `Write your ${kind} as clear Markdown. Then, as the LAST thing in your`,
    `response, emit a single fenced \`\`\`json block with a structured summary`,
    `of the ${kind} (keys appropriate to the stage). The json block is parsed`,
    `and stored as a structured artifact.`,
  ].join('\n');
}

/**
 * The stage packet is runtime-neutral — it is the same context whether a Claude
 * or Pi agent runs the stage. `claudeStagePrompt` is the historical name kept as
 * an alias so existing importers (and the Claude adapter) keep working.
 */
export const claudeStagePrompt = assembleStagePrompt;

/**
 * Build the adapter for a project's runtime + config via its {@link RuntimeProfile}.
 *
 * `deps` lets a caller substitute a pre-constructed adapter for a runtime — the
 * daemon does this for `claude` so its adapter carries the MCP-server reader +
 * stall config that aren't expressible as plain {@link RuntimeConfig}. Absent, the
 * profile constructs the adapter from `config`.
 */
export function createAgentAdapter(
  kind: AgentRuntime,
  config: RuntimeConfig = {},
  deps?: Partial<Record<AgentRuntime, AgentRuntimeAdapter>>,
): AgentRuntimeAdapter {
  return deps?.[kind] ?? runtimeProfile(kind).createAdapter(config);
}

/**
 * Deterministic mock adapter. Produces a canned artifact for each supported
 * stage and a transcript describing the (simulated) run. No Claude, no shell.
 */
export class MockAgentRuntimeAdapter implements AgentRuntimeAdapter {
  async runStageAgent(input: AgentRunInput): Promise<AgentRunResult> {
    if (!isAgentStage(input.stage)) {
      return {
        status: 'failed',
        transcript: this.transcript(input, 'failed'),
        produced: [],
        error: `mock agent does not support stage "${input.stage}"`,
      };
    }

    const kind = STAGE_TO_ARTIFACT[input.stage];
    const produced: ProducedArtifact = {
      kind,
      title: mockArtifactTitle(kind),
      body: mockArtifactBody(kind, {
        taskTitle: input.taskTitle,
        rawRequest: input.rawRequest,
      }),
    };

    return {
      status: 'succeeded',
      transcript: this.transcript(input, 'succeeded', kind),
      produced: [produced],
    };
  }

  /**
   * Streaming variant: emits a couple of scripted events, and — when
   * `WORKBENCH_MOCK_ASK=1` — raises one structured question mid-run so the
   * interactive gate (and the UI quiz) can be exercised without an API key.
   * Otherwise it mirrors `runStageAgent`.
   */
  async streamStageAgent(input: AgentRunInput, handlers: StreamHandlers): Promise<AgentRunResult> {
    if (!isAgentStage(input.stage)) {
      return this.runStageAgent(input);
    }
    handlers.onEvent({
      type: 'assistant_text',
      payload: { text: `Running ${input.stage} (mock).` },
    });

    let chosen = '';
    if (process.env.WORKBENCH_MOCK_ASK === '1') {
      const answer = await handlers.requestInput({
        header: 'Approach',
        question: `Which approach should the ${input.stage} agent take?`,
        options: [
          { label: 'Conservative', description: 'Smallest change that works' },
          { label: 'Thorough', description: 'Refactor for clarity too' },
        ],
        multiSelect: false,
      });
      chosen = 'selected' in answer ? answer.selected.join(', ') : answer.text;
      handlers.onEvent({ type: 'assistant_text', payload: { text: `Operator chose: ${chosen}` } });
    }

    const kind = STAGE_TO_ARTIFACT[input.stage];
    const body =
      mockArtifactBody(kind, { taskTitle: input.taskTitle, rawRequest: input.rawRequest }) +
      (chosen ? `\n\n_Operator chose: ${chosen}_\n` : '');
    handlers.onEvent({
      type: 'cost',
      payload: {
        totalCostUsd: 0,
        numTurns: 1,
        inputTokens: null,
        outputTokens: null,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
      },
    });
    return {
      status: 'succeeded',
      transcript: this.transcript(input, 'succeeded', kind),
      produced: [{ kind, title: mockArtifactTitle(kind), body }],
    };
  }

  /** Build a deterministic transcript body (stored as a `log` artifact). */
  private transcript(
    input: AgentRunInput,
    outcome: 'succeeded' | 'failed',
    producedKind?: ArtifactKind,
  ): ProducedArtifact {
    const lines = [
      `# Agent Transcript (mock)`,
      ``,
      `Task: ${input.taskTitle}`,
      `Stage: ${input.stage}`,
      `Outcome: ${outcome}`,
      ``,
      `## Inputs`,
      ``,
      `- worktree path: ${input.worktreePath ?? '(none)'}`,
      `- allowed tools: ${input.allowedTools.length ? input.allowedTools.join(', ') : '(none)'}`,
      `- context artifacts: ${
        input.contextArtifactIds.length ? input.contextArtifactIds.join(', ') : '(none)'
      }`,
      ``,
      `## Transcript`,
      ``,
      `> (mock) Read context packet.`,
      `> (mock) Inspected worktree at ${input.worktreePath ?? '(no worktree)'}.`,
    ];
    if (outcome === 'succeeded' && producedKind) {
      lines.push(`> (mock) Produced ${producedKind} artifact.`);
    } else {
      lines.push(`> (mock) Aborted: stage not supported by the mock adapter.`);
    }
    lines.push('');
    return { kind: 'log', title: `Agent run — ${input.stage}`, body: lines.join('\n') };
  }
}

export {
  type ClaudeAdapterOptions,
  ClaudeAgentRuntimeAdapter,
  consumeStreamLine,
  extractJsonBlock,
  newStreamAccumulator,
  type StreamAccumulator,
  stageSystemPrompt,
} from './claude.js';
export { type CodexAdapterOptions, CodexAgentRuntimeAdapter } from './codex.js';
export { type PiAdapterOptions, PiAgentRuntimeAdapter } from './pi.js';
export {
  type RuntimeConfigField,
  type RuntimeProfile,
  runtimeProfile,
} from './runtime-profile.js';
export {
  composeExternalToolsText,
  composeSkillText,
  envSetupPreamble,
  isEnterpriseProfile,
  loadSkill,
  type RepoProfile,
  requiredComplianceFields,
  skillExists,
  skillForDelivery,
  skillForPlan,
  skillForReadme,
  skillForReview,
  skillForWrite,
  skillsForQa,
  skillsForReview,
  stripFrontmatter,
  type ToolDocTier,
  verifyRepoSkillCompliance,
} from './skills.js';
