# Security boundaries

**This is not a hardened sandbox against hostile code.** The `native-trusted`
execution profile runs commands as the local developer's own user, with the
same filesystem and process permissions that user already has. It defends
against *accidental* scope creep and *unintentional* destructive actions by a
well-behaved agent, not against a deliberately adversarial or compromised
model/tool chain escaping its intended scope. If that threat model matters
for a given repository, do not register it with `trusted: true`, and treat
`container-isolated` (interface-only in this MVP — see product spec §37) as
the prerequisite for stronger isolation, not yet implemented here.

## What is enforced in the MVP

- **Worktree confinement.** Every task gets one Git worktree
  (`~/.agentic-workbench/worktrees/<repositoryId>/<taskId>/`). The builder
  role's capability broker grants `worktree.write`/`worktree.patch` scoped to
  that path — not the developer's primary checkout, not other tasks'
  worktrees.
- **No GitHub credentials to agents.** `packages/github` (the delivery
  adapter) is deterministic code, not an agent session. Agent sessions never
  receive a GitHub token, `gh` auth state, or SSH keys. Push/PR creation only
  happens from the daemon's delivery activities.
- **Environment variable allowlisting.** Each repository has an allowlist of
  environment variables passed into spawned processes; arbitrary host
  environment (e.g. cloud credentials sitting in a developer's shell) is not
  forwarded by default.
- **Command allowlisting by provenance.** A command discovered by inference
  is not `validated` (and therefore not eligible to gate a phase) until it
  has either run successfully once or been explicitly human-approved. See
  `ValidatedCommand.status` in the domain model.
- **Per-role capability broker.** No agent role gets an unrestricted shell.
  Planner and plan-critic are read-only; the builder gets scoped write access
  to its own worktree plus targeted test/command execution; the verifier can
  run configured checks but not edit code; QA executors get browser/terminal/
  HTTP interaction but no source writes; the reviewer is read-only plus
  finding writes. See product spec §18 for the full per-role table and
  `packages/capability-broker` for the enforcement code.
- **Process supervision.** Every spawned process is tracked by PID/process
  group; cleanup kills the full tree rather than leaving orphans running
  after a task is cancelled or completes.
- **Command execution logging.** Every executed command (path, args, cwd,
  exit code, timestamps) is designed to be recorded as a `command_executions`
  row — the schema exists (Milestone 1) and `@awb/execution`'s `runCommand`
  already returns every field that row needs (Milestone 4), but the actual
  Activity-level write path isn't wired until the daemon (Milestone 10)
  exists to own that write. Until then, this audit trail is a property of
  the design, not yet a running guarantee — don't cite this as an existing
  control before Milestone 10 lands.
- **Network default-deny beyond a narrow allowlist.** Configured Git remotes,
  the GitHub API/web UI, package registries required by the repository's own
  lockfiles, localhost, and repository-approved development services.
  General web search and arbitrary external websites are not available to
  any agent role in this MVP (product spec §30).

## Human gates as a security control, not just a UX nicety

Several of the "conditional" human gates in product spec §14 exist
specifically because the action they gate is security-relevant even under a
well-behaved agent: a new dependency (supply-chain surface), an
authentication/authorization change, anything touching payments/secrets/
destructive migrations, a request for host access outside the worktree, or a
request for arbitrary external network access. These are not modeled as
"the agent asks nicely" — the capability broker structurally cannot grant
them without a corresponding `HumanGate` having been approved via the
matching Temporal Update.

## Known gaps, stated plainly

- No seccomp/namespace/VM-level isolation in the MVP; a sufficiently
  motivated malicious tool invocation inside `native-trusted` could still
  affect the developer's machine beyond the worktree (e.g. via a symlink
  escape, or a command that itself execs something outside the allowlist
  path but within the user's own permissions).
- `container-isolated` is an interface only; there is no enforcement backing
  it yet.
- The uploader for GitHub PR video attachments (`packages/github`) drives a
  real browser profile via Playwright and assumes the developer is already
  logged into GitHub in that profile — this is a deliberate MVP simplification
  (product spec §37), not a security boundary.
