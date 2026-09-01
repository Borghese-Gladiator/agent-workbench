# TASK-97 — Subagent (Task tool) policy per runtime

Decision writeup for whether the workbench should let an agent spawn **subagents**
(the `Task` / subagent tool) under the OpenCode and Pi runtimes, with the containment
analysis that backs the call. The contrast case is the Claude SDK path, which is where
the only real containment gap lives.

## TL;DR

| Runtime | Decision | Mechanism | Containment |
| --- | --- | --- | --- |
| **OpenCode** | **Keep denied** (per-role explicit `task: deny`). | Materialized agent file with a full allow/deny `permission:` block; `task` is always in the deny list. | Strong — a persona layers only a role prompt over the **same** permission block, so it cannot widen the tool boundary. |
| **Pi** | **Keep denied** (by absence + closed allowlist). | `--tools` names the only permitted built-ins; Pi's surface has no Task/subagent tool at all. | Strong — closed allowlist, nothing to escape into. |
| **Claude (contrast)** | Denied **by omission**, not explicitly. | `disallowedSdkTools()` computes the deny list only over `ALL_SDK_TOOLS`, which does **not** enumerate `Task`. | **Gap** — under `bypassPermissions`, a Task tool the SDK surfaces would run un-denied. |

Decision: **keep-denied for all three real runtimes.** For OpenCode and Pi this is the
current, sound default — no change needed. For Claude, the equivalent guarantee is
weaker (deny-by-omission), which is why the recommendation is to make the Claude deny
**explicit** if/when the SDK exposes a reachable Task tool.

## Why deny subagents at all

The workbench grants each phase a **scoped, mostly read-only capability set** (e.g. a
review or QA phase gets read tools, not write). A subagent is a *new* agent session; if
it does not inherit the parent's tool restrictions, it becomes an escape hatch: an agent
denied `Write`/`Bash` could spawn a subagent that has them, defeating the per-phase
sandbox. So the containment question is not "is Task useful" but "does a spawned
subagent stay inside the parent's tool boundary." Where we cannot guarantee that, the
tool stays denied.

## OpenCode — keep denied, per-role explicit

OpenCode's tool universe includes `task` (subagents). The workbench's mapping
(`packages/agent-gateway/src/opencode-tools.ts`) grants **no** capability that maps to
`task`, and `capabilitiesToOpenCodePermission()` emits an explicit `deny` for every tool
not granted — so `task: deny` is written for every role. The comment is explicit:
*"`task` (subagents) and `websearch`/`webfetch` are always denied — the workbench grants
no subagent or external-research capability."*

- **Enforcement:** a materialized ephemeral agent file carries a `permission:` frontmatter
  block listing every tool with allow/deny; the run selects it via `opencode run --agent <name>`.
- **Containment under personas:** a persona (`persona` / `rolePrompt`) layers a role
  prompt over the **same** capability permission block, so a persona cannot widen the
  tool set — the `task: deny` line survives. This is asserted in the adapter tests (a
  persona file still denies the tools the capability set denies).

**Verdict:** keep denied. If a future phase genuinely needs subagents, the correct move
is a scoped capability that grants `task` for that role only (enable-scoped), inheriting
the same explicit permission block — not a global default flip.

## Pi — keep denied, by closed allowlist

Pi's built-in surface (`packages/agent-gateway/src/pi-tools.ts`) is only
`read/grep/find/ls/edit/write/bash` — there is **no** Task/subagent tool to deny.
Enforcement is a **closed allowlist**: `--tools` names the only permitted built-ins and
`--exclude-tools` is the explicit complement. The `research`/`ask`/`subagent`
capabilities map to nothing.

Because the allowlist is closed and the tool does not exist, the escape-tool boundary is
satisfied *for free* — there is nothing extra to deny and nothing for a subagent to
escape into.

**Verdict:** keep denied (nothing to enable). If Pi ever ships a subagent tool, it must
be added to the allowlist model and left out of `--tools` to preserve the guarantee.

## Claude SDK — the containment gap (contrast)

`packages/agent-gateway/src/capability-tools.ts` enumerates `ALL_SDK_TOOLS` as
`Read/Write/Edit/Grep/Glob/Bash/WebFetch/WebSearch` — **`Task` is not in the set.**
`disallowedSdkTools()` computes the deny list *only over that set*, so it never lists
`Task`. Combined with the Claude adapter running under `bypassPermissions`, this means:

- If the SDK surfaces a `Task`/`Agent` tool the model can reach, it falls through the
  deny computation and runs **un-denied**.
- A Claude subagent spawned via Task is a *new* SDK session whose tool scope is not
  governed by the parent's `disallowedTools`, so it could escape the read-only
  capability sandbox.

For OpenCode/Pi this cannot happen (explicit deny / no such tool); for Claude the safety
rests on the SDK simply not exposing a reachable Task tool today. That is an implicit
assumption, not an enforced boundary.

**Recommendation for Claude:** make the deny **explicit** — add `Task` (and any
sibling subagent/agent tool name) to the deny computation in `capability-tools.ts` so
`disallowedSdkTools()` always lists it, closing the gap regardless of what the SDK
surfaces. This is a small, safe change and is the Claude-side equivalent of OpenCode's
per-role `task: deny`. (Tracked as the follow-up to this decision; not required for the
OpenCode/Pi decision, which is already sound.)

## Decision summary

- **OpenCode:** keep-denied, explicit per-role `task: deny`. Enable only via a scoped
  capability if a phase ever needs it.
- **Pi:** keep-denied by closed allowlist / tool absence. No action.
- **Claude (contrast):** keep-denied, but by omission; harden to an **explicit** deny of
  `Task` to match the containment guarantee the other two runtimes already have.
