# CLAUDE.md

Claude-Code-specific pointers for this repo. The cross-runtime contract (LOG/TODO, context library, related conventions) lives in `AGENTS.md` — read that first.

## Slash commands

Project slash commands live under `agent-workbench-live/.claude/commands/`. They wrap the `agent-workbench` CLI for the LLM-bearing lifecycle stages (`/shape`, `/plan`, `/validate`, `/followups`) and the thin transitions (`/new-run`, `/start`, `/bounce`, `/complete`, `/abandon`). LLM-bearing stages auto-chain through `/new-run → /shape → /plan`; only `/start` and `/complete | /bounce | /abandon` are human gates. Pull `@context/...` leaves on demand — see `@context/README.md`.
