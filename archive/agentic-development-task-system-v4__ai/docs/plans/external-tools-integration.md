# External helper tools for enterprise tasks (klaviyo-local-seed as the first)

## Problem

Enterprise repos (app/fender) need real local state to verify work: a loginable
account, feature flags, dashboards, seeded events. Today the QA/e2e stages either
rubber-stamp via static greps or fail for environment reasons, because the stage
agent has no sanctioned way to construct that state. `~/GitHub/klaviyo-local-seed`
already solves this as a standalone, agent-ready CLI (`bin/seed account|flags|
dashboard|events|scenario|verify|sql|py|doctor|destroy`) with its own CLAUDE.md and
skills. The workbench has no way to hand such a tool to a task agent.

## Generalize or one-off?

**Generalize the mechanism, keep the tool knowledge in the tool's own repo.**

The workbench only needs three generic capabilities, none of which are
seed-specific:

1. Know a tool exists for this project and where it lives.
2. Inline the tool's own usage doc into the right stage prompts (the workbench
   already inlines skills into prompts because the gated CLI disables
   `.claude/skills` discovery — the seed repo's shipped skills won't be found
   otherwise).
3. Optionally run fixed, deterministic commands at lifecycle points
   (preflight / teardown).

Everything seed-specific (gotchas, flag systems, DD requirements) already lives in
klaviyo-local-seed's CLAUDE.md, which is written for agents. The workbench should
mount that doc, not duplicate it. A second tool (e.g. a fixture generator for
fender, a log-tailing helper) then registers the same way.

## Design

### Config: `Project.externalTools`

New optional field on `Project` (`packages/core/src/entities.ts`), stored as a JSON
column via migration (same pattern as `runtime_config_json`, migration 0017):

```ts
interface ExternalTool {
  name: string;              // "klaviyo-local-seed"
  root: string;              // absolute path to the tool's repo
  docPath: string;           // relative doc to inline, e.g. "CLAUDE.md"
  stages: Stage[];           // which stage prompts get the doc
  allowedCommands?: string[];// Bash prefixes to allow, e.g. "bin/seed sql"
  preflightCommand?: string; // e.g. "bin/seed doctor" — daemon-run, read-only
  teardownCommand?: string;  // e.g. cleanup at closeout (needs seeded-id capture)
}
```

Registered for the enterprise projects in `apps/daemon/src/seed-enterprise.ts`
(`enterpriseProjects()`), so `[klaviyo] app` gets klaviyo-local-seed by
construction. UI editing can come later; SQLite edit works meanwhile.

### Prompt injection (the core, phase 1)

`apps/daemon/src/service.ts:skillTextForStage` already composes per-stage skill
text. Add a `composeExternalToolsText(tools, stage)` in
`packages/agents/src/skills.ts` that, for each tool whose `stages` includes the
current stage, reads `<root>/<docPath>` and appends:

```
## External tool: klaviyo-local-seed
Located at <root>. Invoke via `<root>/bin/seed ...`.
<contents of its CLAUDE.md>
```

This follows the existing grain exactly — `envSetupPreamble` is the precedent for
profile-gated "here's how to work in this environment" injection, and enterprise
env setup is already agent-instructed, not daemon-executed.

Stage fit for seed specifically:

- `implementation` — reproduce bugs / construct data while building.
- `feature_e2e` — the big win: `seed scenario full` + `seed verify` +
  the tool's `dogfood-frontend` Playwright flow gives real runtime verification
  instead of grep-based rubber-stamping.
- `discovery` — `seed sql` / `seed py` to inspect real data shapes. Blocked
  today: discovery is a read-only stage (no shell). Requires the
  `allowedCommands` mechanism below; defer if noisy.

### Tool policy (phase 1.5)

Read-only stages deny shell, so `seed sql` in discovery needs scoped allowance.
`packages/agents/src/policy.ts` (`mapPolicyToClaude`) can translate
`allowedCommands` into Claude `Bash(<prefix>:*)` allowed-tools entries per stage.
This is also the mitigation for the known "Monitor/Task as Bash escape" problem —
scoped prefixes rather than opening shell wholesale.

### Daemon-run preflight (phase 2)

Run `preflightCommand` (`bin/seed doctor` — explicitly write-free) through the
`SyncValidationRunner` seam before `feature_e2e`, captured as an artifact. A
failing doctor marks the stage blocked-on-environment instead of failing the
agent's work — this directly addresses the recurring "parked-at-verification
FAILED was actually the worktree env" false-negative class.

Same seam handles `teardownCommand` at closeout. Caveat: `seed destroy` needs the
company id, so teardown requires the agent (or a parse of seed output) to record
seeded ids as a task artifact first. Defer until phase 1 proves out; `seed
account` idempotency-by-email limits the mess meanwhile.

## Constraints and risks

- **Shared mutable state.** Seeded data lands in the one local MySQL, not the
  task worktree. Parallel tasks can collide. Convention: derive the account email
  from the task id (`task-<id>@seed.local`) so tasks stay disjoint and teardown
  is targetable.
- **Env fragility.** Seed requires app's venv + `make services-up` (and Kafka/
  liveloader for events, which fail *silently* to all-zero DD). `seed doctor`
  preflight exists precisely for this; without it the tool becomes a new source
  of confusing e2e failures.
- **Doc size.** Seed's CLAUDE.md is ~75 lines — fine to inline. The mechanism
  should cap/trim inlined docs so a future tool with a huge doc doesn't blow the
  stage prompt (cf. the plan-stage prompt-quality regression).
- **Runtime awareness.** Injection is prompt-level, so it works for any
  RuntimeProfile; the `allowedCommands` policy mapping is per-runtime
  (`mapPolicyToClaude` / `mapPolicyToPi`). The tool must remain usable by small
  local models — see "Making it work for any model" below; do NOT gate the
  integration to the claude runtime.

## Making it work for any model

Requirement: the integration must not assume a frontier model. A small local
model (pi profile / Ollama) can't be trusted to navigate 12 subcommands and their
flags from a 75-line doc. Instead of gating those models off, shift complexity
away from the model in tiers:

- **Tier A — daemon-seeded baseline (zero CLI use).** For every enterprise task,
  the daemon runs the deterministic part itself before the stage:
  `seed doctor`, then `seed scenario full --email task-<id>@seed.local ...`
  (idempotent, so re-runs are safe). It injects the results into the stage as
  env vars (`SEED_EMAIL`, `SEED_PASSWORD`, `SEED_COMPANY_ID`) and one prompt
  line: "A loginable local account exists; credentials are in the environment."
  The model never invokes the CLI at all — this works for literally any model,
  the same way the QA harness already injects `QA_*` env vars.
- **Tier B — recipe card, not the full doc.** What gets inlined into stage
  prompts is a short card of 3–6 exact copy-paste commands relevant to that
  stage (seed events for a metric, seed dashboard, seed verify), not the whole
  CLAUDE.md. Small models are reliable at copying a literal command and
  substituting one flag value; they are unreliable at synthesizing invocations
  from prose. The card lives in the seed repo (e.g. `docs/recipes/<stage>.md`)
  so the tool owns its own agent UX; `docPath` in the registry points at it.
- **Tier C — full doc for models that can use it.** `RuntimeProfile` gains a
  `toolDocTier: 'full' | 'recipes'` hint; claude gets the full CLAUDE.md
  appended after the recipe card, pi gets the card only.

CLI-side changes in klaviyo-local-seed that make every tier safer (small,
independent of the workbench):

- `--json` on read/verify commands so any model (or the daemon) can parse
  results instead of scraping prose output.
- Error messages that name the next command to run ("Kafka container down —
  run `make services-up` in the app repo, then re-run"), since small models
  follow literal instructions in errors far better than they diagnose.
- Keep the existing guardrails load-bearing: idempotency on email, `destroy`
  requiring `--yes`, `doctor` as the no-writes probe.

## Alternatives considered

- **MCP server wrapper** (wire like linear-server/sentry via
  `enterpriseMcpServers`): more structured calls, but seed is CLI-first with no
  MCP surface, the agent already has shell in the stages that matter, and every
  new tool would need an MCP wrapper written. Skip unless a read-only-stage need
  (discovery `seed sql`) makes a narrow MCP facade attractive later.
- **Daemon-executed seeding only** (fixed command at worktree creation): reliable
  but wrong altitude — *what* to seed depends on the task ("test the SMS funnel"
  needs different data than "fix dashboard widgets"). The agent must choose;
  deterministic daemon commands are only right for preflight/teardown.
- **Hardcode seed into the enterprise skill text**: cheapest, but buys nothing
  over the registry once one more tool shows up, and couples workbench releases
  to seed-tool doc changes.

## Phasing

1. **Phase 1** — `ExternalTool` type + migration + seed-enterprise registration +
   recipe-card prompt injection (Tier B) for `implementation` and `feature_e2e`;
   full-doc append for the claude profile (Tier C). Live-test on a real app task.
   **IMPLEMENTED 2026-07-02**: `ExternalToolConfig` in core entities, migration
   `0018_add_project_external_tools`, `composeExternalToolsText` +
   `RuntimeProfile.toolDocTier` in @workbench/agents, injection via
   `skillTextForStage`, canonical registration + boot-time drift correction in
   `seed-enterprise.ts`, recipe cards authored in
   `~/GitHub/klaviyo-local-seed/docs/recipes/`.
   **LIVE-PROVEN 2026-07-02** on a full fender lifecycle (smart-dashboard UI
   revamp → draft PR klaviyo/fender#63396): with a request that never mentions
   the tool, the QA agent ran `bin/seed doctor`, `scenario full`, and
   `fender-flags --gate smart_dashboard_enabled` — all verbatim from the
   injected recipe card. Known gap found: a parked `feature_e2e` cold-re-prompts
   and rewrites its spec each resume (no reviewer-feedback channel for that
   stage), so env-caused QA failures don't converge — fix knowledge belongs in
   the recipe cards (host/auth/routing/testid quirks now documented there).
2. **Phase 1.5** — `allowedCommands` → per-stage Bash prefix policy; enable
   `discovery` read-only queries. Seed-repo side: `--json` output + recipe docs.
3. **Phase 2** — daemon-run preflight + baseline seeding with env-var injection
   (Tier A: doctor + scenario full + `SEED_*` env), which is what makes the
   integration model-agnostic; teardown at closeout once seeded-id capture
   exists. Live-test Tier A on the pi profile with a small local model.
