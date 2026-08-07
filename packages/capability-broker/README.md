# @awb/capability-broker

## Purpose

The single enforcement point for per-role tool access — no agent role gets a
generic unrestricted shell.

## Responsibilities

- `CAPABILITY_TABLE` — the explicit allowlist for every role (`planner`,
  `plan-critic`, `builder`, `verifier`, `qa-executor`,
  `adversarial-reviewer`, `memory-curator`, `delivery-adapter`).
- `CapabilityBroker.can`/`.assert`/`.listGranted` — the only API for checking
  or enforcing a capability. `.assert` throws a typed `CapabilityDeniedError`
  naming both the role and the denied capability.

## Does NOT

- Provide any bypass or "admin" role — there is deliberately no capability
  set that grants everything. If a genuinely new capability is needed, it
  must be added to the specific role(s) that need it in `CAPABILITY_TABLE`,
  not routed around this package.
- Perform the actual tool call — this package only answers "is this
  allowed," the caller (agent-gateway, daemon route handlers, Activities)
  is responsible for actually calling `.assert()` before performing the
  corresponding action.

## Dependencies

`@awb/domain` (imported for context, not currently required by the types
here — kept as a dependency since every package that models agent-facing
concerns is expected to route through domain types as this area grows).
