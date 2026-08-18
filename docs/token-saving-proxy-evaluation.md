# TASK-95 — Token-saving proxy evaluation: RTK / Caveman / Headroom

Decision writeup for whether to adopt a personal token-saving **CLI proxy** as the
lever against the workbench's token cost. The measurement that motivates it is in
[`token-cost-measurement.md`](./token-cost-measurement.md); this doc is the
keep/decline call on the three proxy tools, plus the caveat that decides all three.

## TL;DR

| Tool | Verdict | Why |
| --- | --- | --- |
| **RTK** (Rust Token Killer) | **Decline** as a runtime dependency; **keep the technique.** | Shell-hook proxy — cannot intercept SDK-driven or CLI-spawned agent tool calls. Its *output-compression technique* is what we adopted, in-process, as `compressCommandOutput`. |
| **Caveman** | **Decline.** | Same shell-interception model; same blind spot. Nothing it does reaches the agent's in-session context. |
| **Headroom** | **Decline.** | Context/window-management framing that does not map to where our cost actually is (in-session cached prefix the SDK already caches). No code seam it could attach to. |

The single caveat that forces all three declines: **agent tool calls never traverse
the user's shell**, so a shell-level proxy is structurally blind to them.

## The SDK-interception caveat (the decisive fact)

The workbench runs agents by two mechanisms, and **neither** goes through the human
shell a proxy hooks:

1. **Claude runtime — SDK-driven, no shell hook.** `packages/agent-gateway/src/claude-adapter.ts`
   drives agents via `@anthropic-ai/claude-agent-sdk`'s `query()` streaming API. Tool
   calls (`Read`/`Write`/`Edit`/`Bash`/`Grep`/`Glob`) are **SDK-internal tools**: they
   surface as structured `tool_use` / `tool_result` blocks in the SDK message stream and
   execute inside the SDK's own subprocess. The workbench never spawns a shell for them,
   and the user's shell never sees them. So a shell-`PATH`-hook proxy (RTK/Caveman) has
   nothing to intercept — even the agent's own `Bash` tool runs inside the SDK, not via
   the user's interactive shell where the hook lives.
2. **CLI runtimes (codex / opencode / pi) — spawn a CLI binary.** These extend
   `CliStreamAdapter` and shell out to `opencode run` / `pi --mode json` / `codex`,
   parsing NDJSON. Their *internal* tool calls run inside that CLI process. The proxy
   would have to wrap the CLI binary itself, not sit on the user's shell — and even then
   it sees only the CLI's own stdio, not the model's tool transcript.

A personal proxy like RTK is designed to rewrite **human-typed** commands (`git status`
→ `rtk git status`) via a Claude-Code shell hook. That hook fires for the operator's
own commands, never for a model-driven tool call. This is already stated in
`token-cost-measurement.md`: *"the RTK/Caveman technique, applied inside
`packages/execution` — NOT the personal CLI, whose shell hook never intercepts
SDK-driven agents."* This doc is the formal decision that follows from it.

## Where the cost actually is (so a proxy would miss it)

The measurement is unambiguous: cost is **in-session accumulated context**, not the
cross-run preamble. Cached-read input is ~99.9% of input tokens (~8,000–23,000× fresh
input). Each session runs dozens of turns, and every turn re-reads the entire
accumulated prefix from cache — system prompt + tool definitions + the growing
transcript + **all prior tool outputs and file reads**.

A shell proxy cannot touch any layer of that:

- It does not sit between the model and its tool results, so it cannot shrink the tool
  output that gets appended to the transcript and re-cached every subsequent turn.
- The preamble it *could* theoretically shrink is already negligible (~206–1,306
  estimated tokens) and already prompt-cached by the SDK.

So even setting aside interception, the proxy attacks the wrong layer.

## What we kept instead: the technique, in-process

The RTK/Caveman *idea* — clip chatty command output before it is handed back — is
correct; the delivery vehicle (a shell proxy) is wrong for an SDK/CLI agent. So TASK-95
adopted the technique **inside `packages/execution`**, where the workbench's own scoped
commands run, as `compressCommandOutput` (`packages/execution/src/command-runner.ts`):
repeated-line elision → head/tail line cap → hard UTF-8 byte cap (defaults 256 KiB /
2000 lines / elide on), applied by `runCommand` before a `CommandResult` returns into
context.

Scope boundary worth stating: this compresses the **workbench's** deterministic command
runs. The Claude SDK's *own* internal `Bash` tool results are held in the SDK transcript
and are not routed through `compressCommandOutput` — shrinking those would require an SDK
tool-result hook, which is a separate, larger effort tracked with the token-cost work,
not a proxy.

## Provider base URL: the only real proxy seam (and its limits)

If a proxy were ever adopted, the only place it could attach without new code is a
**provider base URL**, and it is deliberately narrow:

- **Claude SDK: env-only.** There is no adapter code path for a Claude base URL; it is
  injected solely via the `ANTHROPIC_BASE_URL` environment variable. `RuntimeConfig.providerBaseUrl`
  is intentionally **not** threaded to the Claude profile (see
  `packages/agent-gateway/src/runtime-profile.ts`). A proxy for Claude would be an
  env-level reverse proxy in front of the API, not a shell hook — a different tool class
  entirely, and out of scope here.
- **CLI runtimes:** `providerBaseUrl` (env `AWB_AGENT_PROVIDER_BASE_URL`) is threaded to
  codex + opencode; Pi does not honor it. Even there it points the CLI at a provider
  endpoint — it does not give a proxy visibility into the tool transcript.

Neither seam helps token cost: an API-level reverse proxy still cannot shrink the
in-session cached prefix, which is the cost.

## Decision

- **Decline** RTK, Caveman, and Headroom as workbench dependencies. Their interception
  model (human shell hook) is structurally blind to SDK/CLI agent tool calls, and the
  cost they would target (preamble) is already negligible and cached.
- **Keep** the output-compression *technique* — already shipped in-process as
  `compressCommandOutput`, which is where it can actually reach the cost.
- Revisit only if we build an **SDK tool-result hook** or an **API-level reverse proxy**;
  both are distinct from a personal CLI proxy and neither is justified by the current
  numbers.
