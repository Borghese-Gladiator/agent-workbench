# 004 — `native-trusted` is the only fully implemented execution profile

## Decision

Implement `native-trusted` (commands run as the developer's own user, scoped
to a Git worktree) fully for the MVP. `repository-defined` and
`container-isolated` exist only as `ExecutionProfile` enum values and
interface stubs — no sandboxing/container enforcement ships in this MVP.

## Why

The MVP only needs full `native-trusted`
support, and building real container isolation (namespace/seccomp policies,
image management, volume mounting for worktrees) is a substantial project on
its own that would delay every other milestone without which this system has
no value at all (planning, verification, QA, review, delivery). Shipping a
correct, well-tested `native-trusted` path plus a clean interface for the
other two profiles keeps the door open without gold-plating a feature no
milestone currently requires.

## Alternatives considered

- **Build `container-isolated` now, defer other milestones.** Rejected —
  this system's core value (deterministic lifecycle, real QA evidence,
  adversarial review) is orthogonal to sandboxing strength, and none of it
  can be demonstrated without the rest of the milestones landing first.
- **Skip the profile enum/interface entirely and hardcode native execution.**
  Rejected — even without implementing container isolation now, having the
  `WorkspaceLease.executionProfile` field and an interface boundary means a
  future container backend is an additive change, not a breaking one.

## Consequences

- `docs/security.md` states plainly that this is not a hardened sandbox
  against hostile code — a real security boundary, not a marketing caveat.
  Repositories that need stronger isolation should not be registered with
  `trusted: true` until `container-isolated` actually exists.
- Every other security control in this MVP (worktree confinement, no GitHub
  credentials to agents, environment variable allowlisting, command
  provenance/validation, capability broker, process supervision, command
  logging) has to carry more of the practical safety weight, since there is
  no OS-level isolation backstop.
