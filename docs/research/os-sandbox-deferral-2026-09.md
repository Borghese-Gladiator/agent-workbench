# OS-level sandboxing for untrusted repos — deferred, with the trigger written down (TASK-122)

**Verdict: build nothing. This is a deferral, and the point of writing it down is so the deferral
has a stated trigger instead of being a silence somebody later mistakes for an oversight.**

## The gap, stated plainly

Execution is confined by the capability broker plus worktree isolation, and that combination is
explicitly `native-trusted` — **not** a hostile-code sandbox. `docs/security.md` opens by saying so,
and `AGENTS.md:172` repeats it in the "things NOT to assume" list:

> The `native-trusted` execution profile runs commands as the local developer's own user, with the
> same filesystem and process permissions that user already has. It defends against *accidental*
> scope creep [...] not against a deliberately adversarial or compromised model/tool chain.

The known gaps section names the specific holes: no seccomp, no namespaces, no VM-level isolation,
and a symlink escape or an exec outside the allowlist path (but within the user's own permissions)
would reach the developer's machine. `container-isolated` exists as an interface with nothing
behind it (ADR-004).

## Why nothing is built now

The gap is real and it is **not currently reachable**, because the workbench does not run untrusted
repositories. Trust is a one-time, explicit, operator-set flag on a repository the operator already
owns and already has checked out. The threat model an OS sandbox addresses — running code you do
not trust — is not the model we are in.

Building isolation ahead of that need would be complexity ahead of need, and would cut against
ADR-004 (`native-trusted` only, deliberately) the same way a graph plane cut against ADR-002 in
ADR-009. The discipline is the same: name the gap, name the trigger, build on the trigger.

## The trigger

Build OS-level isolation when **any** of these becomes true:

1. The workbench registers a repository the operator does not control — a third-party clone, a
   fork from an untrusted source, anything arriving over the network.
2. The workbench runs somewhere multi-tenant, where one user's task could reach another's data.
3. `container-isolated` stops being interface-only and acquires a real consumer.

Until then `native-trusted` is honest and documented, which is the actual requirement: the failure
mode to avoid is not "no sandbox", it is "no sandbox and nobody said so".

## The design reference, when it is time

**Sandcastle** — its isolation-boundary model is the reference for what a real boundary looks like
here. Recorded now so the trigger arrives with a starting point rather than a blank page.

Note what would have to change alongside it, because the sandbox is not the whole job: the
capability broker's path grants, the worktree materialization path, and the `executionProfile`
column all assume the agent runs as the local user. An OS boundary is the enforcement layer under
those, not a replacement for them.

## Re-triage condition

Re-open when a trigger above fires. Do not re-open on general unease about the trust model —
`docs/security.md` already states it accurately, and restating it is not progress.
