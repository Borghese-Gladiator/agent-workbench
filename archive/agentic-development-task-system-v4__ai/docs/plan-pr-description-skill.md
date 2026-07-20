# Plan: PR Description skill (Agent Workbench, delivery-policy aware)

## Brief
The `delivery_prep` stage currently produces the `delivery_package` artifact from a
**static mock** (`service.ts:1258` → `addMockArtifactReturning`, body from
`mock-content.ts:96`). That artifact is threaded straight into `gh pr create --body`
(`service.ts:1299-1305` → `delivery/src/index.ts:205`). So real tasks open PRs with a
mock body.

Build a `pr-description` skill (modeled on the spirit of `/pr-draft`, but specific to
the workbench delivery step) that makes a real agent write the delivery artifact from
the actual branch diff + the task's prior artifacts. The skill is **delivery-policy
aware**:
- `create_pr` → write a high-quality **PR description** (succinct bullets, exemplar PRs
  embedded, "how validated" section).
- `merge_to_master` → write a tight **squash-commit summary** (the PR-body framing is
  pointless when there's no PR).

This is the same prompt-injection pattern already used for write/plan/review/QA skills:
the gated CLI disables `.claude/skills` discovery, so the daemon loads the SKILL.md body
and inlines it. `delivery_prep` joins the `NON_MOCK_STAGE_INSTRUCTIONS` family (like
`implementation`/`delivery_conflict`): a real coding-agent stage that is NOT in the
mock-runnable `AGENT_STAGES` set.

## Changes

### 1. New skill: `skills/pr-description/SKILL.md`
- Frontmatter (`name`, `description`) consistent with the other skills.
- Body: locate the diff (`git diff <base>...HEAD`), read the task's prior artifacts
  (plan/validation/self-review) for "how validated", then write a description with:
  - One-line summary of WHAT changed and WHY (obvious at a glance).
  - **Succinct** bullets — one change per bullet, no fluff.
  - A "How validated" section listing the commands/evidence (from verification).
  - 2–3 embedded **exemplar PR descriptions** showing the bar (succinct bullets,
    obvious overall change + validation), per the TODO.
- Branch on delivery policy via a `{{deliveryPolicy}}`-style instruction the daemon
  already threads — actually simpler to make the skill cover both and have the stage
  instruction name which mode applies.
- `## Output` contract: end with a ```json block carrying `summary`, `changes[]`,
  `validation[]` so we can enforce compliance like the other skills.

### 2. Wire `delivery_prep` as a real (non-mock) agent stage
`packages/agents/src/index.ts`:
- Add `delivery_prep` to `NON_MOCK_STAGE_INSTRUCTIONS` with a `delivery_package` kind
  and an instruction that names the active delivery policy.
- Add a read-only-plus-git tool policy entry for `delivery_prep` in `STAGE_TOOL_POLICY`
  (Read/Grep/Glob/Bash — needs `git diff/log`; NO Edit/Write — it only writes an
  artifact, not source).

`apps/daemon/src/service.ts`:
- `prepareDelivery` (`:1256`): if the project runtime is `claude`, run the real agent
  via `produceStageArtifact(task, 'delivery_package', 'delivery_prep', ...)` instead of
  the mock; keep the mock path for non-claude runtimes. Still call
  `createDeliveryPackage` to register the artifact id + target + status.
- `skillTextForStage` (`:549`): inject the `pr-description` skill for `delivery_prep`,
  passing the delivery policy so the skill text can include the right framing.

### 3. Skill routing
`packages/agents/src/skills.ts`:
- Add a `skillForDelivery()` (policy-agnostic — the same skill covers both modes; the
  policy is named in the stage instruction). Add `delivery_prep` compliance fields
  (`summary`, `changes`) to `REQUIRED_COMPLIANCE_FIELDS` for enterprise profiles? — NO:
  the PR-description skill is profile-agnostic (every repo gets a good PR body), so
  enforce compliance for ALL profiles via a separate small map. Keep it simple: a
  dedicated `DELIVERY_COMPLIANCE_FIELDS` checked when stage === 'delivery_prep'.

### 4. mock-content.ts
- Leave the mock body (used for non-claude runtime + tests) but make it clearly a
  placeholder; no behavior change.

## Tests

### Unit
`packages/agents/src/skills.test.ts`
- `pr-description` SKILL.md exists and loads (skillExists / loadSkill).
- `skillForDelivery()` returns `'pr-description'`.
- compliance: `verifyRepoSkillCompliance`/equivalent flags a `delivery_prep` output
  missing `summary`/`changes`; passes when present.

`packages/agents/src/index.test.ts`
- `claudeStagePrompt` for `delivery_prep` renders the delivery-policy instruction and
  inlines the injected skill text.
- `allowedToolsForStage('delivery_prep')` includes Bash, excludes Edit/Write.

`apps/daemon` (existing lifecycle tests)
- a claude-runtime task at `delivery_prep` routes to the real adapter (mock adapter in
  test still produces an artifact); a non-claude task still gets the mock. Assert the
  `delivery_package` artifact exists and is registered as the delivery package.

### Manual
Python? No — this repo is TS. Manual = a daemon smoke:
1. `pnpm --filter @workbench/agents test` (skills + index green).
2. `pnpm --filter @workbench/daemon test` (lifecycle green, no flake regressions).
3. Build: `pnpm -r build` clean.
4. (Deferred, same caveat as write-app/fender): a live claude run against a real
   checkout to validate the *quality* of the generated PR body — not doable from here.
