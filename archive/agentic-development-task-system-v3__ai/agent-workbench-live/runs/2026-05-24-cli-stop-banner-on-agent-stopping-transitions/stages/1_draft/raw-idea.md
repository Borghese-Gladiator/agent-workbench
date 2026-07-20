# CLI stop banner on agent-stopping transitions

Discovered 2026-05-24 during the auto-merge-on-complete run's retro. The workbench's lifecycle has two stages where the agent does no work — `human_review` (human inspects + decides) and `ready` (human approves the plan) — plus the terminal states `done` and `abandoned`. Today there is no per-state directive file telling the agent "stop here." On the auto-merge dogfood run, the agent drove straight through `human_review` into `complete` without pausing, exactly because nothing in the agent's immediate tool output said "stop."

## Chosen direction

Land a stop banner in the CLI's stdout for any transition that lands in a state the agent does not drive. The banner is printed by the command that performs the transition, immediately after the existing transition line. Implemented in a small new helper (`lib/cli/_stop_banner.py`) so the format stays consistent across commands.

The states this fires for:

| Landing state | Reason | Banner action |
|---|---|---|
| `ready` | Human approves the plan via `/start`. | STOP. Wait for human to `/start`. |
| `human_review` | Human inspects + decides via `/complete`, `/bounce`, `/abandon`. | STOP. Wait for human. |
| `done` | Terminal. | STOP. Run accepted. |
| `abandoned` | Terminal. | STOP. Run abandoned. |

## Design principles

- The signal lands in the agent's most recent tool output. That is where the agent's attention is.
- Convention over enforcement. This is a nudge, not a hard block.
- One source of truth for the banner format. Every command calls the same helper.
- Bordered + visually distinct. Block of `=` characters and the literal word `STOP`.

## Tasks

- Add `lib/cli/_stop_banner.py` with `print_stop_banner(landing_state, run_id, *, next_commands=None)`. Internal table mapping each of the four landing states to a (reason, next-step text) pair. Width capped at 60 columns.
- Wire the banner into the commands that perform agent-stopping transitions:
  - `lib/cli/cmd_plan.py` — landing state `ready`
  - `lib/cli/cmd_validate.py` — landing state `human_review` (flat-layout path)
  - `lib/cli/cmd_followups.py` — landing state `human_review` (staged path)
  - `lib/cli/cmd_complete.py` — landing state `done`
  - `lib/cli/cmd_abandon.py` — landing state `abandoned`
- `agent-workbench-live/AGENTS.md` cross-reference: one sentence under "How to drive the workbench" pointing at the banner.
- Tests: unit test for `_stop_banner.print_stop_banner` (four states × asserts on banner text); E2E extension asserting `STOP.` appears in stdout after `followups` and `complete`; snapshot test for the banner's exact format per landing state.

## Acceptance

- Running `/plan <id>` (landing at `ready`), `/validate <id>` (flat-layout), `/followups <id>`, `/complete <id>`, and `/abandon <id>` each prints a STOP banner as the last thing in stdout.
- The banner names the landing state, says who owns it, and lists the exact next commands the human would invoke.
- The banner is consistent across all four call sites (driven by `_stop_banner.print_stop_banner`).
- `AGENTS.md` cross-references the banner once.
- Tests pin both the trigger points and the exact format.

## Non-goals

Hard enforcement (the agent can still run past the banner — by design). Hooks-based call interception (out of scope; workbench is runtime-agnostic). Banners for transitions that the agent itself drives. Per-state contract files in `docs/states/<state>.md`.

## Origin

Discovered 2026-05-24 during the retro of run `2026-05-24-auto-merge-on-complete`. See `docs/TODO.md` §2.
