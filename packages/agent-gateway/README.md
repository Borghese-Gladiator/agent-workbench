# @awb/agent-gateway

## Purpose

The provider-neutral interface every coding-agent backend implements
(product spec §19), plus a fully deterministic mock adapter and supporting
event/usage normalization.

## Responsibilities

- `adapter.ts` — the `CodingAgentAdapter` interface
  (`createSession`/`execute`/`interrupt`/`dispose`) and its supporting types
  (`CreateAgentSessionInput`, `AgentAssignment`, `AgentEventSink`,
  `AgentExecutionResult`). Callers never depend on a specific provider's
  SDK/CLI shape — only on this interface.
- `mock-adapter.ts` — `MockAgentAdapter`: scriptable per (taskId, role),
  used for every deterministic Temporal/lifecycle test in this repo. Can
  simulate successful turns, findings, file changes, command results, token
  usage, timeouts (via abort signal), provider crashes (via `throws`), and
  repeated identical failure signatures.
- `claude-adapter.ts` — the real adapter, backed by
  `@anthropic-ai/claude-agent-sdk`'s structured event stream (never parses
  decorative terminal output). The underlying SDK call is behind an
  injectable seam so its event-mapping logic is unit-testable without live
  API credentials.
- `event-normalization.ts` — `normalizeAgentEvent()`: converts a raw
  `AgentEvent` into a compact `SemanticEvent` row. Raw provider streams are
  never persisted per-token — only these summaries go to SQLite; full
  streams belong in the artifact store as compressed files.
- `usage-aggregator.ts` — `UsageAggregator`: accumulates `ModelUsage`
  records into totals and a per-model breakdown.

## Does NOT

- Enforce capabilities itself — `CreateAgentSessionInput.allowedTools` is
  expected to already be the output of `@awb/capability-broker` for the
  session's role; this package trusts what it's given.
- Persist anything — `SemanticEvent`s and `ModelUsage` totals are handed
  back to the caller (the daemon/Activities) to write to SQLite.

## Dependencies

`@awb/domain`, `@anthropic-ai/claude-agent-sdk`.

## Known issue

`@anthropic-ai/claude-agent-sdk` declares a peer dependency on `zod@^4.0.0`;
this workspace is on zod v3 (see `packages/domain`). `pnpm install` reports
an unmet-peer warning but nothing in this package's code path exercises the
SDK's zod-based schema validation, so tests pass cleanly. Revisit if a
future SDK version hard-requires v4, or if this package starts using the
SDK's schema-validated inputs directly.
