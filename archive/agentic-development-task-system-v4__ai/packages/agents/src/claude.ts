/**
 * ClaudeAgentRuntimeAdapter — runs a real coding agent for one lifecycle stage
 * by shelling out to the locally-installed `claude` CLI in non-interactive
 * print mode (`claude -p ... --output-format json`).
 *
 * Why the CLI and not the Agent SDK: the CLI reuses the user's existing Claude
 * Code login, so it needs NO `ANTHROPIC_API_KEY`. (We deliberately avoid the
 * `--bare` flag, which would force API-key-only auth.)
 *
 * Safety properties this adapter guarantees:
 * - It ONLY operates inside the task worktree: the CLI is spawned with
 *   `cwd = worktreePath` and no `--add-dir`, so the worktree is the only root.
 *   With no worktree it refuses to run.
 * - It receives a STAGE PACKET (see `claudeStagePrompt`), never full task history.
 * - It enforces the per-stage tool policy from `STAGE_TOOL_POLICY`. The real
 *   read-only boundary is `--disallowed-tools` + `--permission-mode plan`
 *   (`--allowed-tools` alone is only an auto-approval allowlist).
 *
 * Like the mock, it is PURE COMPUTE from the daemon's perspective: it returns a
 * transcript + produced artifacts and never touches SQLite or git directly. The
 * daemon persists the result. (The agent itself may edit files inside the
 * worktree during the `implementation` stage — that is the point.)
 */

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArtifactKind, TokenUsage } from '@workbench/core';
import type {
  AgentRunInput,
  AgentRunResult,
  AgentRuntimeAdapter,
  ProducedArtifact,
  StreamHandlers,
} from './index.js';
import {
  ASK_TOOL,
  bufferingHandlers,
  claudeStagePrompt,
  isAgentStage,
  isEnterpriseProfile,
  mapPolicyToClaude,
  policyForStage,
  STAGE_TO_ARTIFACT,
  verifyRepoSkillCompliance,
} from './index.js';
import {
  type CliInvocation,
  type CliResult,
  type CliStreamResult,
  defaultRunCli,
  defaultRunCliStreaming,
  extractJsonBlock,
  type RunCli,
  type RunCliStreaming,
} from './run-shared.js';

/**
 * Diagnostic prompt capture. When `WORKBENCH_CAPTURE_PROMPTS=<dir>` is set, the
 * EXACT prompt sent to the CLI for each stage run is appended to
 * `<dir>/<seq>-<stage>.txt`, with a header naming the stage, mode (packet vs
 * resume turn), and the context artifact ids that were available. This exists to
 * prove what the stage handoff actually carries (see the context-handoff perf
 * work) and is a no-op when the env var is unset — zero behavior change.
 */
let captureSeq = 0;
function capturePromptToDisk(input: AgentRunInput, prompt: string): void {
  const dir = process.env.WORKBENCH_CAPTURE_PROMPTS;
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    const seq = String(++captureSeq).padStart(2, '0');
    const file = join(dir, `${seq}-${input.stage}.txt`);
    const header = [
      `===== stage=${input.stage} mode=${input.resume ? 'resume-turn' : 'stage-packet'} =====`,
      `taskId: ${input.taskId}`,
      `contextArtifactIds: ${
        input.contextArtifactIds.length ? input.contextArtifactIds.join(', ') : '(none)'
      }`,
      `reviewerFeedback: ${input.reviewerFeedback ? `${input.reviewerFeedback.length} chars` : '(none)'}`,
      `skillText: ${input.skillText ? `${input.skillText.length} chars` : '(none)'}`,
      `----- PROMPT (${prompt.length} chars) -----`,
      '',
    ].join('\n');
    appendFileSync(file, `${header}${prompt}\n`);
  } catch {
    /* capture is best-effort diagnostics — never break a run over it */
  }
}

// The CLI runner seams + result shapes live in `run-shared.ts` (reused by the
// Pi adapter). Re-exported here so existing `./claude.js` importers keep working.
export type {
  CliInvocation,
  CliResult,
  CliStreamResult,
  RunCli,
  RunCliStreaming,
} from './run-shared.js';

/**
 * The Anthropic `usage` object the CLI carries on its terminal `result` line.
 * Field names follow the Messages API. All optional — older CLI versions or the
 * mock runtime may omit it.
 */
export interface CliUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** The single-object JSON shape emitted by `claude -p --output-format json`. */
export interface CliJsonResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: CliUsage;
  permission_denials?: Array<{ tool_name?: string }>;
  terminal_reason?: string;
  session_id?: string;
}

/** Map the CLI's snake_case `usage` onto the core `TokenUsage` shape (camelCase, nulls). */
function tokenUsageFrom(usage: CliUsage | undefined): TokenUsage {
  return {
    inputTokens: usage?.input_tokens ?? null,
    outputTokens: usage?.output_tokens ?? null,
    cacheCreationInputTokens: usage?.cache_creation_input_tokens ?? null,
    cacheReadInputTokens: usage?.cache_read_input_tokens ?? null,
  };
}

/**
 * Pull the per-turn `usage` off an `assistant` stream line's `message`. The CLI
 * carries the Anthropic Messages `usage` object here — the REQUEST's input +
 * cache counts for THIS turn (plus output-so-far). This is the per-turn signal
 * the terminal `result.usage` (cumulative) can't give us. Returns all-null when
 * the line omits usage (older CLI versions).
 */
function turnUsageFrom(message: unknown): TokenUsage {
  const usage = (message as { usage?: CliUsage } | undefined)?.usage;
  return tokenUsageFrom(usage);
}

export interface ClaudeAdapterOptions {
  /** Override the CLI runner — primarily for tests. */
  runCli?: RunCli;
  /** Override the streaming CLI runner — primarily for tests. */
  runCliStreaming?: RunCliStreaming;
  /** Path/name of the `claude` binary. Default `claude` (resolved on PATH). */
  bin?: string;
  /** Model alias/id to run on (e.g. 'opus'). Omit to use the CLI default. */
  model?: string;
  /** Max agentic turns per stage run. */
  maxTurns?: number;
  /**
   * Fail a streaming run after this long with zero stream activity (unless it
   * is long-polling the human ask-gate). 0 disables the watchdog.
   */
  stallTimeoutMs?: number;
  /**
   * Override how the Klaviyo MCP server definitions are sourced (default: read
   * from the user's `~/.claude.json`). Tests inject this so they don't depend on
   * the developer's real config. Receives the server names to look up; returns the
   * subset that exists, keyed by name.
   */
  readMcpServers?: (names: readonly string[]) => Record<string, McpServerDef>;
}

/**
 * 30 turns proved too tight in a live run: a multi-file implementation stage
 * failed `error_max_turns` mid-edit with the work fully on script. Runaway cost
 * is bounded by the stall watchdog and the human gates, so the cap is generous.
 */
const DEFAULT_MAX_TURNS = 100;

/**
 * Default stall watchdog: fail a streaming run after this long with zero stream
 * activity (unless it is waiting on the human ask-gate). Observed failure mode:
 * a run goes silent mid-stage and stays `running` forever — the lifecycle hangs
 * until someone kills the process. 10 minutes comfortably exceeds legitimate
 * silent periods (a long Bash tool call, a subagent fan-out in QA/review).
 */
const DEFAULT_STALL_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Orchestration/escape tools the model tends to probe for when it assumes the
 * full harness toolbox. The system prompt tells it NOT to hunt for these — but
 * ONLY for the ones this stage doesn't actually have. A tool on this list that
 * IS in `allowedTools` (e.g. `Task` on the review/QA stages, where the injected
 * skill MANDATES Task-subagent fan-out) must NOT be prohibited, or the prompt
 * contradicts the skill and the model resolves the conflict by reviewing inline.
 */
const PROBE_TOOLS = ['Task', 'Agent', 'Skill', 'Monitor', 'ToolSearch', 'ExitPlanMode'] as const;

/**
 * Per-stage system prompt: enumerate the tools this stage actually has, and
 * tell the agent NOT to hunt for others. A live discovery run burned its turn
 * budget probing Task/ToolSearch/Skill/Monitor/ExitPlanMode before this text
 * existed — the model assumes the full harness toolbox unless told otherwise.
 *
 * The "do not call" list is derived from `allowedTools`, not hardcoded: it names
 * only the probe tools this stage lacks. So a stage that legitimately has `Task`
 * (review/QA) is told to USE it as the skill directs, while a read-only stage is
 * still told it has only Read/Grep/Glob and nothing else.
 *
 * It also carries the cross-cutting OUTPUT-QUALITY standard (see
 * {@link OUTPUT_QUALITY_STANDARD}) — applied to every stage's artifact so output
 * is scaled to the actual work, not padded to a template.
 */
export function stageSystemPrompt(policy: {
  allowedTools: string[];
  stage?: string;
  /**
   * Escape/orchestration tools to explicitly warn the model away from when this
   * stage lacks them. Defaults to the Claude harness probe set; the Pi adapter
   * passes `[]` because Pi's tool surface has no such escape tools to probe for.
   */
  probeTools?: readonly string[];
}): string {
  const allowed = new Set(policy.allowedTools);
  const tools = policy.allowedTools.join(', ') || '(none)';
  // Only forbid the probe tools this stage does NOT have. Anything on the
  // allowlist is fair game and must not appear in the prohibition.
  const forbidden = (policy.probeTools ?? PROBE_TOOLS).filter((t) => !allowed.has(t));
  const prohibition = forbidden.length
    ? `do not call or search for ${forbidden.join(', ')}, or any other tool not listed above, `
    : 'do not call or search for any tool not listed above, ';
  return (
    'You are a stage-specific coding agent. Operate ONLY within the current working directory. ' +
    `Your ONLY available tools are: ${tools}. No other tools exist in this session — ` +
    prohibition +
    'and do not try to write files unless Edit/Write are listed above. ' +
    'Use the tools that ARE listed above as your instructions (including any injected skill) ' +
    'direct — if Task is listed, use it to dispatch subagents when the skill calls for it. ' +
    'Emit your full output (Markdown, then the requested json block) directly in your reply. ' +
    // No-preamble rule: plan-mode stages (brief/discovery/plan) reliably open with
    // a narration line ("Now I have enough information, let me write the plan.")
    // that becomes the first line of the stored artifact. Suppress it at the source
    // rather than trimming the deliverable after the fact.
    'Begin your reply DIRECTLY with the deliverable (the first Markdown heading or ' +
    'sentence of the artifact). Do NOT preface it with narration about what you are ' +
    'about to do, what you have finished, or that you are now writing it — no "Now I ' +
    'have enough information…", "Let me write…", or similar. ' +
    `${outputQualityStandard(policy.stage)} ` +
    'End your reply with the requested json block.'
  );
}

/**
 * Cross-cutting output-quality standard, injected into EVERY stage's system
 * prompt. It is intentionally a QUALITY bar, not a count: a one-line change gets
 * a one-line brief; a real feature gets as much as it genuinely needs. The point
 * is to stop the over-production we saw on a trivial task (a 7-row acceptance-
 * criteria table for `divide(a,b)`, where AC2–AC6 were just test cases for the
 * same goal) without capping a genuinely large task.
 */
const OUTPUT_QUALITY_BASE = [
  'Output quality bar (applies to everything you write):',
  '— Scale your output to the actual work. A trivial change gets a few sentences;',
  'a large feature gets as much as it genuinely needs. Never pad to fill a template.',
  '— State only what MATTERS, at the right altitude. A goal/acceptance criterion is',
  'a distinct user-visible outcome or risk — NOT a test case, NOT a restatement of the',
  'request, NOT an implementation step. Most features have only 2–3 real goals; if you',
  'find yourself writing more, you are probably listing test cases or steps — collapse them.',
  '— Do not restate the request, the instructions, or what an earlier stage already said.',
  'Reference it and move on. Prefer a short paragraph over a long table or a formatted report.',
  '— Omit any section that adds nothing for THIS task (e.g. an assumptions list when nothing',
  'was actually ambiguous). Empty-but-present sections are noise.',
];

/**
 * The aggressive prune clause: delete any sentence that doesn't change the work.
 * This is correct guidance when the artifact SUMMARISES work that happened
 * elsewhere (a brief restating intent; a self-review narrating a diff) — there,
 * a sentence that "only shows you understood the task" is pure theater.
 *
 * It is WRONG for stages where the artifact body IS the deliverable — the
 * Execution Plan and Discovery. There, the ordered change list, the validation
 * table, and the design narrative literally ARE "the files edited / the order of
 * the work / the tests run." A live plan run collapsed to a single closing
 * sentence (no json block) because, in read-only `plan` mode with no file to
 * write, the model read its own plan as cuttable narration and obeyed this
 * clause. So we append it only for summary stages, never for plan/discovery.
 */
const OUTPUT_QUALITY_PRUNE = [
  '— Before you finalize, delete any sentence that would not change one of: the files edited,',
  'the order of the work, the tests run, the operator’s decision, or the risk handling. If a',
  'sentence only shows that you understood the task, cut it.',
].join(' ');

/** Stages whose artifact summarises work done elsewhere — the prune clause applies. */
const PRUNE_CLAUSE_STAGES = new Set<string>(['task_brief', 'agent_self_review']);

/**
 * Cross-cutting output-quality standard, injected into EVERY stage's system
 * prompt. Intentionally a QUALITY bar, not a count: a one-line change gets a
 * one-line brief; a real feature gets as much as it genuinely needs. The base
 * bar (scale to the work, right altitude, no padding, omit empty sections)
 * applies to every stage. The aggressive prune clause is appended ONLY for
 * summary stages (see {@link OUTPUT_QUALITY_PRUNE}) — applying it to planning
 * made the model delete its own plan.
 */
export function outputQualityStandard(stage?: string): string {
  const base = OUTPUT_QUALITY_BASE.join(' ');
  return stage && PRUNE_CLAUSE_STAGES.has(stage) ? `${base} ${OUTPUT_QUALITY_PRUNE}` : base;
}

/** @deprecated kept for callers/tests; the full bar incl. the prune clause. */
export const OUTPUT_QUALITY_STANDARD = `${OUTPUT_QUALITY_BASE.join(' ')} ${OUTPUT_QUALITY_PRUNE}`;

/**
 * Tools that mutate the worktree. When the human gate is active these are kept
 * OFF the `--allowed-tools` auto-approval list so each use routes to the
 * permission-prompt tool (the gate) instead of auto-approving.
 */
const MUTATING_TOOLS = new Set(['Edit', 'Write', 'Bash', 'NotebookEdit']);

/**
 * MCP servers re-admitted into the sandbox for Klaviyo (`app`/`fender`) repos so
 * the brief/discovery agents can reach the originating ticket (Linear) and related
 * production errors (Sentry). The spawned CLI runs with `--strict-mcp-config`,
 * which discards the user's global servers; we copy just these two BY NAME from the
 * user's own `~/.claude.json` so the agent reuses the already-authenticated HTTP
 * servers (OAuth lives in the CLI credential store, not the config file). Read-only
 * issue/error context — never a write surface.
 */
const ENTERPRISE_MCP_SERVER_NAMES = ['linear-server', 'sentry'] as const;
/** Stages that get the enterprise MCP servers (issue/error context gathering). */
const ENTERPRISE_MCP_STAGES = new Set<string>(['task_brief', 'discovery']);

/** Shape of one entry under `mcpServers` in `~/.claude.json` (HTTP or stdio). */
export type McpServerDef = Record<string, unknown>;

/** How server definitions are sourced — the real one reads `~/.claude.json`. */
export type ReadMcpServers = (names: readonly string[]) => Record<string, McpServerDef>;

/**
 * Read the named MCP server definitions out of the user's `~/.claude.json`. Returns
 * only the servers that exist there (missing file / missing server / parse error all
 * yield `{}`), so a user without Linear or Sentry configured simply gets neither —
 * no crash, no fabricated config.
 */
const readUserMcpServers: ReadMcpServers = (names) => {
  let parsed: { mcpServers?: Record<string, McpServerDef> };
  try {
    parsed = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8'));
  } catch {
    return {};
  }
  const all = parsed.mcpServers ?? {};
  const out: Record<string, McpServerDef> = {};
  for (const name of names) {
    if (all[name]) out[name] = all[name]!;
  }
  return out;
};

/**
 * The MCP servers to wire for this run: the Linear/Sentry servers when the repo is a
 * Klaviyo enterprise profile AND the stage is an issue/error-context stage; otherwise
 * none. Copied from the user's own config via `read` (see {@link readUserMcpServers}).
 */
function enterpriseMcpServers(
  input: AgentRunInput,
  read: ReadMcpServers,
): Record<string, McpServerDef> {
  if (!isEnterpriseProfile(input.repoProfile ?? null)) return {};
  if (!ENTERPRISE_MCP_STAGES.has(input.stage)) return {};
  return read(ENTERPRISE_MCP_SERVER_NAMES);
}

/**
 * Write a temp `mcp.json` for the given server map and return the CLI flags that
 * register it strictly (no inherited servers). Returns `[]` for an empty map so the
 * caller adds nothing. Shared by the one-shot and streaming paths.
 *
 * `--strict-mcp-config` is intentional: the spawned agent gets EXACTLY these servers
 * and nothing discovered from settings — the same sandbox guarantee the gate path
 * relies on. (When the gate is active the caller also adds `--setting-sources ""`.)
 */
function mcpConfigArgs(servers: Record<string, McpServerDef>): string[] {
  if (Object.keys(servers).length === 0) return [];
  const cfgDir = mkdtempSync(join(tmpdir(), 'wb-mcp-'));
  const cfgPath = join(cfgDir, 'mcp.json');
  writeFileSync(cfgPath, JSON.stringify({ mcpServers: servers }));
  return ['--mcp-config', cfgPath, '--strict-mcp-config'];
}

export class ClaudeAgentRuntimeAdapter implements AgentRuntimeAdapter {
  private readonly runCli: RunCli;
  private readonly runCliStreaming: RunCliStreaming;
  private readonly bin: string;
  private readonly model?: string;
  private readonly maxTurns: number;
  private readonly stallTimeoutMs: number;
  private readonly readMcpServers: ReadMcpServers;

  constructor(opts: ClaudeAdapterOptions = {}) {
    this.runCli = opts.runCli ?? defaultRunCli;
    this.runCliStreaming = opts.runCliStreaming ?? defaultRunCliStreaming;
    this.bin = opts.bin ?? 'claude';
    this.model = opts.model;
    this.maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
    this.stallTimeoutMs = opts.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    this.readMcpServers = opts.readMcpServers ?? readUserMcpServers;
  }

  async runStageAgent(input: AgentRunInput): Promise<AgentRunResult> {
    // Confinement: never run without a worktree to run *inside*.
    if (!input.worktreePath) {
      return {
        status: 'failed',
        transcript: transcriptArtifact(input, this.bin, [], {
          note: 'aborted: no worktree path — refusing to run',
        }),
        produced: [],
        error: 'claude adapter requires a task worktree (no worktreePath provided)',
      };
    }

    const policy = mapPolicyToClaude(policyForStage(input.stage));
    // Resume mode sends ONLY the reviewer's comment (the session holds the rest).
    const prompt = input.resume
      ? input.resume.message
      : (input.promptOverride ?? claudeStagePrompt(input));
    capturePromptToDisk(input, prompt);
    // One-shot runs have no gate, so the ask MCP server isn't spawned — never
    // advertise its tool as allowed.
    const allowed = (input.allowedTools.length ? input.allowedTools : policy.allowedTools).filter(
      (t) => t !== ASK_TOOL,
    );

    const args = ['-p', prompt, '--output-format', 'json', '--max-turns', String(this.maxTurns)];
    if (input.resume) args.push('--resume', input.resume.sessionId);
    args.push('--permission-mode', policy.permissionMode);
    if (allowed.length) args.push('--allowed-tools', ...allowed);
    if (policy.disallowedTools.length) args.push('--disallowed-tools', ...policy.disallowedTools);
    args.push(
      '--append-system-prompt',
      stageSystemPrompt({ allowedTools: allowed, stage: input.stage }),
    );
    // Per-run override (set per-stage by the daemon) wins over the adapter default.
    const model = input.model ?? this.model;
    if (model) args.push('--model', model);
    if (input.effort) args.push('--effort', input.effort);
    // Klaviyo repos: re-admit Linear/Sentry into the sandbox for the brief/discovery
    // stages so the agent can reach the ticket and related errors. The one-shot path
    // has no gate (no ask server), so this is the only MCP config it carries.
    args.push(...mcpConfigArgs(enterpriseMcpServers(input, this.readMcpServers)));

    let cli: CliResult;
    try {
      cli = await this.runCli({ bin: this.bin, args, cwd: input.worktreePath });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: 'failed',
        transcript: transcriptArtifact(input, this.bin, args, { note: `spawn failed: ${message}` }),
        produced: [],
        error: `failed to run claude CLI: ${message}`,
      };
    }

    const parsed = parseCliJson(cli.stdout);

    // Non-zero exit, unparseable output, explicit error, or a non-success
    // subtype all mean the run failed.
    const failed =
      cli.code !== 0 ||
      parsed === null ||
      Boolean(parsed.is_error) ||
      (parsed.subtype !== undefined && parsed.subtype !== 'success');

    const transcript = transcriptArtifact(input, this.bin, args, {
      result: parsed?.result,
      subtype: parsed?.subtype,
      turns: parsed?.num_turns,
      cost: parsed?.total_cost_usd,
      exitCode: cli.code,
      denials: (parsed?.permission_denials ?? []).map((d) => d.tool_name ?? '?'),
      stderr: cli.stderr,
    });

    if (failed) {
      const reason = parsed
        ? `subtype: ${parsed.subtype ?? 'unknown'}${parsed.terminal_reason ? `, ${parsed.terminal_reason}` : ''}`
        : `exit ${cli.code}, unparseable output`;
      return {
        status: 'failed',
        transcript,
        produced: [],
        error: `claude run did not succeed (${reason})`,
        sessionId: parsed?.session_id,
      };
    }

    const kind: ArtifactKind = isAgentStage(input.stage) ? STAGE_TO_ARTIFACT[input.stage] : 'log';
    const produced = buildProduced(kind, input.stage, parsed.result ?? '', input.repoProfile);
    return { status: 'succeeded', transcript, produced, sessionId: parsed.session_id };
  }

  /**
   * Streaming run. Spawns the CLI with `--output-format stream-json` and parses
   * the NDJSON event stream line-by-line, emitting a `StreamEvent` per relevant
   * message and accumulating the final result to build the same
   * `AgentRunResult` as `runStageAgent`. The mid-run input gate (MCP
   * permission-prompt tool) is layered on in a later increment; `handlers`
   * carries the seam for it now.
   */
  async streamStageAgent(input: AgentRunInput, handlers: StreamHandlers): Promise<AgentRunResult> {
    if (!input.worktreePath) {
      return {
        status: 'failed',
        transcript: transcriptArtifact(input, this.bin, [], {
          note: 'aborted: no worktree path — refusing to run',
        }),
        produced: [],
        error: 'claude adapter requires a task worktree (no worktreePath provided)',
      };
    }

    const policy = mapPolicyToClaude(policyForStage(input.stage));
    // Resume mode (rejection redo): the session already holds the full prior
    // context, so we send ONLY the reviewer's comment as this turn — not the
    // stage packet. Otherwise build the normal stage packet.
    const prompt = input.resume
      ? input.resume.message
      : (input.promptOverride ?? claudeStagePrompt(input));
    capturePromptToDisk(input, prompt);
    let allowed = input.allowedTools.length ? input.allowedTools : policy.allowedTools;

    const args = [
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--max-turns',
      String(this.maxTurns),
    ];
    // Continue the prior session so the model sees the brief it already wrote
    // and the conversation that produced it — the comment is a follow-up turn.
    if (input.resume) args.push('--resume', input.resume.sessionId);
    // With the gate active, `acceptEdits` would auto-approve edits and the
    // prompt tool would never fire — so downgrade to `default` so each
    // mutating tool routes to the human gate. (Read-only `plan` stages keep
    // their mode; they don't mutate, so no prompts are expected.)
    const permissionMode =
      input.gate && policy.permissionMode === 'acceptEdits' ? 'default' : policy.permissionMode;
    args.push('--permission-mode', permissionMode);
    // `--allowed-tools` is an AUTO-APPROVAL allowlist: any tool on it bypasses
    // the permission-prompt tool (confirmed in the spike). So with the gate
    // active, drop the mutating tools from the allowlist — they must route to
    // the human gate, not auto-approve.
    if (input.gate) {
      allowed = allowed.filter((t) => !MUTATING_TOOLS.has(t));
    } else {
      // Without a gate the ask MCP server isn't spawned, so don't advertise its
      // tool as allowed.
      allowed = allowed.filter((t) => t !== ASK_TOOL);
    }
    if (allowed.length) args.push('--allowed-tools', ...allowed);
    if (policy.disallowedTools.length) args.push('--disallowed-tools', ...policy.disallowedTools);
    args.push(
      '--append-system-prompt',
      stageSystemPrompt({ allowedTools: allowed, stage: input.stage }),
    );
    // Per-run override (set per-stage by the daemon) wins over the adapter default.
    const model = input.model ?? this.model;
    if (model) args.push('--model', model);
    if (input.effort) args.push('--effort', input.effort);

    // Build the spawned agent's MCP server set: the `ask` gate relay (when a human
    // gate is active) PLUS the Klaviyo Linear/Sentry servers (brief/discovery on
    // `app`/`fender`). Both go into a single `--mcp-config` written by `mcpConfigArgs`
    // — `--strict-mcp-config` then makes these the agent's ONLY servers.
    let gateEnv: Record<string, string> | undefined;
    const mcpServers: Record<string, McpServerDef> = {
      ...enterpriseMcpServers(input, this.readMcpServers),
    };
    if (input.gate) {
      // Mid-run human gate: wire a `workbench_ask` MCP server as the
      // permission-prompt tool. `--setting-sources ""` is REQUIRED — without it a
      // local `permissions.allow` rule shadows the prompt tool and the gate never
      // fires (confirmed in the spike).
      mcpServers.ask = { command: process.execPath, args: [askServerPath()] };
    }
    args.push(...mcpConfigArgs(mcpServers));
    if (input.gate) {
      args.push('--permission-prompt-tool', 'mcp__ask__workbench_ask');
      args.push('--setting-sources', '');
      gateEnv = {
        WORKBENCH_DAEMON_URL: input.gate.daemonUrl,
        WORKBENCH_RUN_ID: input.gate.runId,
      };
    }
    // Merge any caller-supplied env (e.g. the QA harness wiring) over the gate
    // env. Both are layered on top of `process.env` by the spawner.
    const spawnEnv =
      input.env || gateEnv ? { ...(gateEnv ?? {}), ...(input.env ?? {}) } : undefined;

    // Accumulated terminal state, filled from the final `result` event (and the
    // `system`/`init` event for the session id).
    const acc: StreamAccumulator = newStreamAccumulator();

    // Stall watchdog: a run with zero stream activity for `stallTimeoutMs` is
    // wedged — kill it and fail explicitly rather than hanging the lifecycle
    // forever. EXCEPT while the last event is a pending `workbench_ask` call:
    // the human gate long-poll is legitimately silent for as long as the
    // operator takes to answer.
    const watchdog = new AbortController();
    let lastActivity = Date.now();
    let stalled = false;
    // An external "stop session" signal folds into the same watchdog: aborting
    // it kills the spawned CLI (the runner wires SIGKILL to `signal`). Tracked
    // separately from `stalled` so the failure message names the real cause.
    let stopped = false;
    if (input.signal) {
      if (input.signal.aborted) {
        stopped = true;
        watchdog.abort();
      } else {
        input.signal.addEventListener(
          'abort',
          () => {
            stopped = true;
            watchdog.abort();
          },
          { once: true },
        );
      }
    }
    const checker =
      this.stallTimeoutMs > 0
        ? setInterval(
            () => {
              if (acc.askPending) {
                lastActivity = Date.now(); // gate long-poll: keep the window open
                return;
              }
              if (Date.now() - lastActivity > this.stallTimeoutMs) {
                stalled = true;
                watchdog.abort();
              }
            },
            Math.min(this.stallTimeoutMs, 15_000),
          )
        : undefined;

    // Anchor turn 1's TTFT clock at the moment we hand the prompt to the CLI, so
    // the first turn's gap (prompt → first token, incl. cold-process prefill) is
    // measured, not collapsed to zero by the first stream line.
    acc.turnBoundaryMs = Date.now();

    let stream: CliStreamResult;
    try {
      stream = await this.runCliStreaming(
        { bin: this.bin, args, cwd: input.worktreePath, env: spawnEnv, signal: watchdog.signal },
        (line) => {
          lastActivity = Date.now();
          consumeStreamLine(line, acc, handlers);
        },
        handlers.onSpawn,
      );
    } catch (err) {
      // A stop-induced kill can surface as a spawn/stream error — report it as a
      // stop, not a spawn failure, so the run reads as operator-terminated.
      if (stopped) {
        const message = 'stopped by operator';
        handlers.onEvent({ type: 'error', payload: { message } });
        return {
          status: 'failed',
          transcript: transcriptArtifact(input, this.bin, args, { note: message }),
          produced: [],
          error: `claude run did not succeed (${message})`,
          sessionId: acc.sessionId,
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      handlers.onEvent({ type: 'error', payload: { message } });
      return {
        status: 'failed',
        transcript: transcriptArtifact(input, this.bin, args, { note: `spawn failed: ${message}` }),
        produced: [],
        error: `failed to run claude CLI: ${message}`,
      };
    } finally {
      if (checker) clearInterval(checker);
    }

    if (stopped) {
      const message = 'stopped by operator';
      handlers.onEvent({ type: 'error', payload: { message } });
      return {
        status: 'failed',
        transcript: transcriptArtifact(input, this.bin, args, { note: message }),
        produced: [],
        error: `claude run did not succeed (${message})`,
        sessionId: acc.sessionId,
      };
    }

    if (stalled) {
      const message = `stalled: no stream activity for ${this.stallTimeoutMs}ms — killed`;
      handlers.onEvent({ type: 'error', payload: { message } });
      return {
        status: 'failed',
        transcript: transcriptArtifact(input, this.bin, args, { note: message }),
        produced: [],
        error: `claude run did not succeed (${message})`,
        sessionId: acc.sessionId,
      };
    }

    const failed =
      stream.code !== 0 ||
      Boolean(acc.isError) ||
      (acc.subtype !== undefined && acc.subtype !== 'success');

    const transcript = transcriptArtifact(input, this.bin, args, {
      result: acc.finalText,
      subtype: acc.subtype,
      turns: acc.turns,
      cost: acc.cost,
      exitCode: stream.code,
      denials: acc.denials,
      stderr: stream.stderr,
    });

    if (failed) {
      const reason = acc.subtype ? `subtype: ${acc.subtype}` : `exit ${stream.code}`;
      return {
        status: 'failed',
        transcript,
        produced: [],
        error: `claude run did not succeed (${reason})`,
        sessionId: acc.sessionId,
      };
    }

    const kind: ArtifactKind = isAgentStage(input.stage) ? STAGE_TO_ARTIFACT[input.stage] : 'log';
    const produced = buildProduced(kind, input.stage, acc.finalText, input.repoProfile);
    return { status: 'succeeded', transcript, produced, sessionId: acc.sessionId };
  }
}

/**
 * Terminal state accumulated across stream lines (one per streaming run).
 * Exported (with `consumeStreamLine`) so per-turn TTFT logic can be unit-tested
 * with an injected clock without spawning a CLI.
 */
export interface StreamAccumulator {
  finalText: string;
  subtype?: string;
  isError?: boolean;
  turns?: number;
  cost?: number;
  /** Wall-clock + model-API durations from the terminal `result` line (ms). */
  durationMs?: number;
  durationApiMs?: number;
  /** Token breakdown from the terminal `result` line's `usage` object. */
  usage?: TokenUsage;
  denials: string[];
  sessionId?: string;
  /**
   * True while the most recent stream line was a `workbench_ask` tool call —
   * i.e. the run is long-polling the human gate. The stall watchdog must not
   * kill the run in this state. Any subsequent line (the gate answered) clears
   * it.
   */
  askPending?: boolean;
  /**
   * Per-turn TTFT tracking. `turnIndex` is the 1-based count of model turns seen
   * so far. `turnBoundaryMs` is the timestamp the current turn's clock started
   * (run start, then reset to each `tool_result` — the model is handed the result
   * and must produce the next turn). `awaitingFirstToken` is true between a
   * boundary and the next turn's first model line; the first `assistant` line in
   * that window emits the `turn` event and clears the flag.
   */
  turnIndex: number;
  turnBoundaryMs: number | null;
  /** Arrival time of the current turn's first model emission; null until stamped. */
  firstTokenMs: number | null;
  awaitingFirstToken: boolean;
}

/**
 * Parse one NDJSON line from `--output-format stream-json` and emit the relevant
 * `StreamEvent`s, accumulating terminal state. Event schema confirmed in the
 * spike (CLI 2.1.167): top-level `type` ∈ {system, assistant, stream_event,
 * user, result, ...}; `stream_event.event` carries the Anthropic streaming
 * deltas; the terminal `result` carries subtype/cost/turns/denials.
 */
/** Factory for a fresh accumulator (run start state). Exported for tests. */
export function newStreamAccumulator(): StreamAccumulator {
  return {
    finalText: '',
    denials: [],
    turnIndex: 0,
    turnBoundaryMs: null,
    firstTokenMs: null,
    awaitingFirstToken: true,
  };
}

export function consumeStreamLine(
  line: string,
  acc: StreamAccumulator,
  handlers: StreamHandlers,
  now: () => number = Date.now,
): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return; // ignore non-JSON noise
  }

  // Any complete line means the stream is moving again — only an ask tool call
  // (re-set below) leaves the run in the gate long-poll state.
  acc.askPending = false;

  const type = msg.type;

  // The opening `system`/`init` line carries the session id we later `--resume`.
  // (`result` also echoes it; capture from either, first wins.)
  if (typeof msg.session_id === 'string' && !acc.sessionId) {
    acc.sessionId = msg.session_id;
  }

  if (type === 'stream_event') {
    const event = msg.event as
      | { type?: string; delta?: { type?: string; text?: string } }
      | undefined;
    // The FIRST streamed model emission of a turn is the true first token. Stamp
    // its arrival so the `turn` event (built on the later `assistant` line, which
    // carries usage) can report an accurate TTFT measured to first token, not to
    // end-of-generation.
    const isModelEmission =
      event?.type === 'message_start' ||
      event?.type === 'content_block_start' ||
      event?.type === 'content_block_delta';
    if (isModelEmission && acc.awaitingFirstToken) {
      acc.firstTokenMs = now();
      acc.awaitingFirstToken = false;
    }
    if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      handlers.onEvent({ type: 'assistant_text', payload: { text: event.delta.text ?? '' } });
    }
    return;
  }

  if (type === 'assistant') {
    // The full `assistant` message line closes a turn's generation and carries
    // `message.usage`. Emit one `turn` event per such line: TTFT from the turn
    // boundary to first token (stamped on the first stream_event; fall back to
    // this line's arrival if partial-message events were absent), plus the
    // per-turn token usage. Done before the tool_call fan-out so the `turn`
    // event precedes its tool calls in seq order.
    if (acc.firstTokenMs == null && acc.awaitingFirstToken) {
      acc.firstTokenMs = now();
      acc.awaitingFirstToken = false;
    }
    acc.turnIndex += 1;
    const ttftMs =
      acc.turnBoundaryMs != null && acc.firstTokenMs != null
        ? Math.max(0, acc.firstTokenMs - acc.turnBoundaryMs)
        : null;
    handlers.onEvent({
      type: 'turn',
      payload: { index: acc.turnIndex, ttftMs, ...turnUsageFrom(msg.message) },
    });

    const content = (msg.message as { content?: unknown[] } | undefined)?.content ?? [];
    for (const block of content) {
      const b = block as { type?: string; name?: string; input?: unknown };
      if (b.type === 'tool_use') {
        // Entering the human-gate long-poll: silence after this line is the
        // operator thinking, not a wedge (see the stall watchdog).
        if (b.name === ASK_TOOL) acc.askPending = true;
        handlers.onEvent({ type: 'tool_call', payload: { name: b.name, input: b.input } });
      }
    }
    return;
  }

  if (type === 'user') {
    const content = (msg.message as { content?: unknown[] } | undefined)?.content ?? [];
    for (const block of content) {
      const b = block as { type?: string; content?: unknown; is_error?: boolean };
      if (b.type === 'tool_result') {
        // A tool result handed back to the model opens the NEXT turn: reset the
        // boundary clock and re-arm first-token capture.
        acc.turnBoundaryMs = now();
        acc.firstTokenMs = null;
        acc.awaitingFirstToken = true;
        handlers.onEvent({
          type: 'tool_result',
          payload: { status: b.is_error ? 'error' : 'ok', summary: boundedSummary(b.content) },
        });
      }
    }
    return;
  }

  if (type === 'result') {
    acc.subtype = msg.subtype as string | undefined;
    acc.isError = Boolean(msg.is_error);
    acc.turns = msg.num_turns as number | undefined;
    acc.cost = msg.total_cost_usd as number | undefined;
    acc.durationMs = msg.duration_ms as number | undefined;
    acc.durationApiMs = msg.duration_api_ms as number | undefined;
    acc.usage = tokenUsageFrom(msg.usage as CliUsage | undefined);
    acc.finalText = (msg.result as string | undefined) ?? acc.finalText;
    const denials = (msg.permission_denials as Array<{ tool_name?: string }> | undefined) ?? [];
    acc.denials = denials.map((d) => d.tool_name ?? '?');
    handlers.onEvent({
      type: 'cost',
      payload: {
        totalCostUsd: acc.cost ?? null,
        numTurns: acc.turns ?? null,
        durationMs: acc.durationMs ?? null,
        durationApiMs: acc.durationApiMs ?? null,
        ...acc.usage,
      },
    });
    handlers.onEvent({
      type: 'result',
      payload: { subtype: acc.subtype, isError: acc.isError, denials: acc.denials },
    });
  }
}

/** Bound a tool-result content to a short string summary for an event payload. */
function boundedSummary(content: unknown): string {
  let text: string;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content
      .map((c) =>
        typeof c === 'object' && c && 'text' in c ? String((c as { text: unknown }).text) : '',
      )
      .join('');
  } else text = JSON.stringify(content ?? '');
  return text.length > 500 ? text.slice(0, 500) + '…' : text;
}

/** Absolute path to the shipped `workbench-ask` MCP server script. */
function askServerPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'workbench-ask-server.mjs');
}

/** Parse the single-object JSON the CLI prints; tolerant of trailing whitespace. */
export function parseCliJson(stdout: string): CliJsonResult | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed) as CliJsonResult;
    return typeof obj === 'object' && obj !== null ? obj : null;
  } catch {
    return null;
  }
}

/** Build the transcript artifact body (a `log`). */
function transcriptArtifact(
  input: AgentRunInput,
  bin: string,
  args: string[],
  meta: {
    result?: string;
    subtype?: string;
    turns?: number;
    cost?: number;
    exitCode?: number | null;
    denials?: string[];
    stderr?: string;
    note?: string;
  } = {},
): ProducedArtifact {
  const policy = mapPolicyToClaude(policyForStage(input.stage));
  // Redact the prompt from the recorded argv (it follows `-p`) to keep the
  // transcript focused on the invocation shape, not the (large) packet.
  const redactedArgs = args.map((a, i) => (args[i - 1] === '-p' ? '<stage-packet>' : a));

  const header = [
    `# Agent Transcript (claude CLI)`,
    ``,
    `Task: ${input.taskTitle}`,
    `Stage: ${input.stage}`,
    `Worktree (cwd): ${input.worktreePath ?? '(none)'}`,
    `Allowed tools: ${policy.allowedTools.join(', ') || '(none)'}`,
    `Disallowed tools: ${policy.disallowedTools.join(', ') || '(none)'}`,
    `Permission mode: ${policy.permissionMode}`,
    `Context artifacts: ${input.contextArtifactIds.join(', ') || '(none)'}`,
    meta.note ? `Note: ${meta.note}` : null,
    meta.exitCode !== undefined ? `Exit code: ${meta.exitCode}` : null,
    meta.subtype ? `Result subtype: ${meta.subtype}` : null,
    meta.turns !== undefined ? `Turns: ${meta.turns}` : null,
    meta.cost !== undefined ? `Cost (USD): ${meta.cost}` : null,
    meta.denials && meta.denials.length ? `Permission denials: ${meta.denials.join(', ')}` : null,
    ``,
    `## Invocation`,
    ``,
    '```',
    `${bin} ${redactedArgs.join(' ')}`,
    '```',
    ``,
  ].filter((l): l is string => l !== null);

  const tail: string[] = [];
  if (meta.result) {
    tail.push(`## Final output`, ``, meta.result, ``);
  }
  if (meta.stderr && meta.stderr.trim()) {
    tail.push(`## stderr`, ``, '```', meta.stderr.trim(), '```', ``);
  }

  return {
    kind: 'log',
    title: `Agent run (claude) — ${input.stage}`,
    body: [...header, ...tail].join('\n'),
  };
}

/**
 * Build the produced stage artifact. If the final text contains a fenced json
 * block we parse it and store a normalized structured body; we always keep the
 * full prose too so nothing is lost.
 *
 * When the run carries a repo profile, the parsed json is verified against that
 * (profile, stage)'s required skill-compliance fields; if proof is missing, a
 * non-fatal warning banner is prepended so the human gate sees it's unverified.
 */
function buildProduced(
  kind: ArtifactKind,
  stage: string,
  finalText: string,
  repoProfile?: string,
): ProducedArtifact[] {
  const structured = extractJsonBlock(finalText);
  const title = `${stage} (claude)`;
  const warning = verifyRepoSkillCompliance(repoProfile ?? null, stage, structured);
  const emptiness = detectEmptyArtifact(stage, finalText, structured);
  const banner = [
    ...(emptiness ? [`> ⚠️ **Artifact looks empty/unstructured:** ${emptiness}`, ``] : []),
    ...(warning ? [`> ⚠️ **Skill compliance:** ${warning}`, ``] : []),
  ];
  // `finalText` is the agent's own output and ALREADY ends with its fenced ```json
  // block (the prompt asks for exactly one). We used to append a SECOND,
  // re-serialized copy under "## Structured summary" — pure duplication that
  // doubled the json in every stored body (and, once those bodies are threaded
  // into downstream prompts, doubled it there too). Nothing reads the stored
  // block programmatically: gates/verification use the parsed `structured`
  // object below, not the body text. So we store the agent's prose verbatim and
  // keep `structured` only as the in-memory value for compliance checks.
  const body = [...banner, finalText || '(empty agent output)'].join('\n');
  return [{ kind, title, body }];
}

/**
 * Stages whose stored artifact is a real deliverable and is threaded into a
 * DOWNSTREAM stage's prompt — so a thin/structureless body here silently
 * starves the next stage. These must carry both prose and a parsed json block.
 * (`discovery` now produces the Execution Plan threaded into implementation, so
 * it IS contract-bound to emit structure on a real agent run. The "skipped —
 * empty repo" collapse is written deterministically by the daemon, not the
 * agent, so it never reaches this check.)
 */
const STRUCTURE_REQUIRED_STAGES = new Set<string>([
  'task_brief',
  'discovery',
  'feature_e2e',
  'agent_self_review',
]);

/** Prose length below which a structure-required artifact is treated as a stub. */
const MIN_PROSE_CHARS = 200;

/**
 * Non-fatal check: did a structure-required stage come back without its json
 * block, or with a body so short it's effectively a stub? Returns a short reason
 * for the gate banner, or null when the artifact looks substantive. Never throws
 * — the run still parks at the human gate, which can bounce. This catches the
 * regression where a planning agent collapsed to one closing sentence and
 * dropped the required json block, which then threaded an empty plan downstream.
 */
export function detectEmptyArtifact(
  stage: string,
  finalText: string,
  structured: unknown | null,
): string | null {
  if (!STRUCTURE_REQUIRED_STAGES.has(stage)) return null;
  // Prose = the body with its fenced json block(s) removed.
  const prose = finalText.replace(/```json\s*\n[\s\S]*?```/gi, '').trim();
  const noJson = structured === null;
  const tinyProse = prose.length < MIN_PROSE_CHARS;
  if (noJson && tinyProse) {
    return `no structured json block and only ${prose.length} chars of prose — the plan/summary may have collapsed; review before approving.`;
  }
  if (noJson)
    return 'no structured json block was emitted — downstream stages thread this artifact; review before approving.';
  if (tinyProse)
    return `only ${prose.length} chars of prose outside the json block — unusually thin for this stage; review before approving.`;
  return null;
}

// `extractJsonBlock` now lives in `run-shared.ts`; re-exported here so existing
// `./claude.js` importers (and the `index.ts` barrel) keep resolving it.
export { extractJsonBlock } from './run-shared.js';
