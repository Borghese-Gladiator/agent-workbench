/**
 * Skill loading + routing for review/QA stages.
 *
 * The gated streaming path passes `--setting-sources ''` (see `claude.ts`), which
 * DISABLES `.claude/skills/` auto-discovery. So skill content can't load itself —
 * it is delivered by PROMPT INJECTION: the daemon reads a `SKILL.md` body here and
 * `claudeStagePrompt` inlines it under a `## Skill` heading.
 *
 * Pure compute over the repo's `skills/` directory. No SQLite, no git, no network.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExternalToolConfig } from '@workbench/core';

/** Repo profiles the router (`skills/_router/detect-repo-type.mjs`) can emit. */
export type RepoProfile = 'ts-shadcn-frontend' | 'py-fastapi-backend' | 'fender' | 'app';

/** profile -> the review skill that applies. Plain map, not dynamic resolution. */
const REVIEW_SKILL_BY_PROFILE: Record<RepoProfile, string> = {
  'ts-shadcn-frontend': 'review-ts-shadcn-frontend',
  'py-fastapi-backend': 'review-py-fastapi-backend',
  // `fender` / `app` are deferred — the router won't emit them for the dogfood
  // repo, and the always-on adversarial pass still runs if it ever does.
  fender: 'review-fender',
  app: 'review-app',
};

/** profile -> the test-first planning skill that applies, at `discovery`. */
const PLAN_SKILL_BY_PROFILE: Partial<Record<RepoProfile, string>> = {
  // Only the heavyweight Klaviyo repos get a repo-specific planning skill today.
  app: 'plan-app',
  fender: 'plan-fender',
};

/** profile -> the code-writing skill that applies, at `implementation`. */
const WRITE_SKILL_BY_PROFILE: Partial<Record<RepoProfile, string>> = {
  // Only the heavyweight Klaviyo repos get a repo-specific writing skill today.
  app: 'write-app',
  fender: 'write-fender',
};

/**
 * The README-writing skill, appended as the LAST instruction of `implementation` when
 * the checkout STARTED EMPTY (gated programmatically on `_router/is-empty-repo.mjs`).
 * It runs after the code is written, so it documents the real manifest/files. An
 * existing repo is never touched — the agent never guesses whether to write a README.
 * Profile-agnostic: a brand-new repo of any kind gets the same README contract.
 */
const WRITE_README_SKILL = 'write-readme';

/** Always run an adversarial pass at `agent_self_review`, regardless of profile. */
const ALWAYS_REVIEW_SKILLS = ['review-adversarial'] as const;

/**
 * The delivery-writing skill, run at `delivery_prep`. Profile-agnostic: every repo
 * gets a good PR description / squash-commit summary. It branches on the project's
 * delivery policy (the daemon names the active policy when injecting the body).
 */
const DELIVERY_SKILL = 'pr-description';

/**
 * The enterprise repos (Klaviyo `app` / `fender`). They get the deepest treatment:
 * a multi-agent self-review fan-out AND a forced draft-PR delivery (never merge to
 * the default branch). One source of truth, reused by the daemon's delivery guard.
 */
const ENTERPRISE_PROFILES = new Set<RepoProfile>(['app', 'fender']);

/**
 * The extra focused reviewers run ONLY for enterprise profiles at `agent_self_review`,
 * on top of the profile "house-conventions" reviewer and the always-on adversarial
 * pass. `composeSkillText` dispatches each `###` skill to its own subagent, so this
 * is the parallel multi-agent review (correctness / security+perf / tests) modeled on
 * the `app` repo's `code-review` orchestration — minus its repo-only mypy step.
 */
const ENTERPRISE_REVIEW_SKILLS = [
  'review-correctness',
  'review-security-perf',
  'review-tests',
] as const;

/** True for the heavyweight Klaviyo repos (`app` / `fender`). */
export function isEnterpriseProfile(profile: string | null): boolean {
  return profile != null && ENTERPRISE_PROFILES.has(profile as RepoProfile);
}

/**
 * Per-profile environment setup the agent MUST do before running the project's
 * shell commands (tests/lint/typecheck) in a worktree. The workbench spawns the
 * CLI in a NON-INTERACTIVE shell inside a fresh `git worktree`, so the canonical
 * dev environment the repo assumes is NOT set up: fender's direnv/nix hook only
 * fires in interactive shells (no tooling on PATH, no `.env`), and app's
 * `bin/pytest` pins the MAIN checkout's `.venv` + `src` on `sys.path`. Injected
 * ahead of the skill body for the shell-running stages (implementation, QA) on
 * enterprise repos only — empty string for everything else.
 *
 * fender's own `.claude/skills/direnv-setup` SKILL.md is the canonical reference
 * for the direnv case; this preamble points the agent at it rather than
 * duplicating its full diagnosis.
 */
export function envSetupPreamble(profile: string | null): string {
  if (profile === 'fender') {
    return [
      '## Environment setup (do this FIRST, before any test/lint/build command)',
      'This is a non-interactive shell, so fender’s direnv/nix environment is NOT loaded —',
      '`yarn`, `turbo`, `node` etc. are not on PATH and `.env` is unset. Before running any',
      'command, load it: prefix with `eval "$(direnv export bash)"` or wrap with',
      '`direnv exec . <cmd>`. This is exactly fender’s `.claude/skills/direnv-setup` skill —',
      'follow it if a command fails with a missing tool or unset `IS_DIRENV_INITIALIZED`.',
    ].join(' ');
  }
  if (profile === 'app') {
    return [
      '## Environment note (app tests in a worktree)',
      'You are in a `git worktree`, not the main `app` checkout. `bin/pytest` pins the MAIN',
      'checkout’s `.venv` and puts the MAIN checkout’s `src` on `sys.path` — so it reuses the',
      'existing venv (no setup needed) BUT may import the package-under-test from the main',
      'checkout, not your edited worktree source. Run tests so they exercise THIS worktree’s',
      'code: prefer a worktree-relative invocation (e.g. `PYTHONPATH=$PWD/src bin/pytest -m unit <path>`)',
      'and confirm a new test actually fails against unmodified source before relying on a green run.',
    ].join(' ');
  }
  return '';
}

/** The QA skills injected at `verification`, in dispatch order. */
const QA_SKILLS = ['qa-e2e-playwright', 'qa-artifacts'] as const;

/**
 * The review skill name for a detected profile, or `null` when the profile is
 * unknown. Kept for back-compat; prefer `skillsForReview` which also returns the
 * always-on adversarial pass.
 */
export function skillForReview(profile: string | null): string | null {
  if (profile && profile in REVIEW_SKILL_BY_PROFILE) {
    return REVIEW_SKILL_BY_PROFILE[profile as RepoProfile];
  }
  return null;
}

/**
 * Skills to run at `agent_self_review`: the profile-specific review (or `null`
 * when the profile is unknown — we DON'T fail closed, adversarial still runs) plus
 * the always-on pass set. For enterprise profiles (`app`/`fender`) the always-on set
 * is the deeper multi-agent fan-out (correctness + security/perf + tests) ahead of
 * adversarial; every other profile keeps the adversarial-only pass.
 */
export function skillsForReview(profile: string | null): {
  profile: string | null;
  always: readonly string[];
} {
  const always = isEnterpriseProfile(profile)
    ? [...ENTERPRISE_REVIEW_SKILLS, ...ALWAYS_REVIEW_SKILLS]
    : ALWAYS_REVIEW_SKILLS;
  return { profile: skillForReview(profile), always };
}

/** Skills to run at `verification`: the E2E driver + the artifact bundler. */
export function skillsForQa(): readonly string[] {
  return QA_SKILLS;
}

/**
 * The test-first planning skill for a detected profile at `discovery`, or
 * `null` when the profile has no planning skill. Like review, we DON'T fail closed:
 * an unknown profile just plans without an injected skill.
 */
export function skillForPlan(profile: string | null): string | null {
  if (profile && profile in PLAN_SKILL_BY_PROFILE) {
    return PLAN_SKILL_BY_PROFILE[profile as RepoProfile] ?? null;
  }
  return null;
}

/**
 * The code-writing skill for a detected profile at `implementation`, or `null` when
 * the profile has no writing skill. Like plan/review, we DON'T fail closed: an unknown
 * profile just implements without an injected skill.
 */
export function skillForWrite(profile: string | null): string | null {
  if (profile && profile in WRITE_SKILL_BY_PROFILE) {
    return WRITE_SKILL_BY_PROFILE[profile as RepoProfile] ?? null;
  }
  return null;
}

/**
 * The README-writing skill appended at the end of `implementation` on a repo that
 * started empty. Profile-agnostic: every repo gets the same README contract, so it
 * takes no profile. The daemon decides WHETHER to append it (via
 * `_router/is-empty-repo.mjs`); this just names the skill, returned unconditionally.
 */
export function skillForReadme(): string {
  return WRITE_README_SKILL;
}

/**
 * The delivery-writing skill for `delivery_prep`. Profile-agnostic — every repo gets
 * a good PR description / squash-commit summary — so it takes no profile. The active
 * delivery policy is named by the daemon when it injects the body, not selected here.
 */
export function skillForDelivery(): string {
  return DELIVERY_SKILL;
}

/**
 * The structured json fields a (profile, stage) run must emit as proof it applied the
 * repo skill. Empty for combinations with no enforced skill. Mirrors the `## Output`
 * contract in the SKILL.md bodies; used to verify the agent's closing json block.
 */
const REQUIRED_COMPLIANCE_FIELDS: Record<string, Partial<Record<string, string[]>>> = {
  app: {
    discovery: ['testPlan', 'precedentTests'],
    implementation: ['precedentCitations', 'testsWritten'],
    agent_self_review: ['precedentCitations', 'checks'],
  },
  fender: {
    discovery: ['testPlan', 'precedentTests'],
    implementation: ['precedentCitations', 'testsWritten'],
    agent_self_review: ['precedentCitations', 'checks'],
  },
};

/**
 * Compliance fields enforced for a stage REGARDLESS of profile. `delivery_prep` runs
 * the profile-agnostic `pr-description` skill on every repo, so its proof (a real
 * summary + change list) is required even when no repo profile is detected. Mirrors the
 * `## Output` contract in `pr-description/SKILL.md`.
 */
const PROFILE_AGNOSTIC_COMPLIANCE_FIELDS: Record<string, string[]> = {
  delivery_prep: ['summary', 'changes'],
};

/** Required compliance fields for a (profile, stage), or [] if none. */
export function requiredComplianceFields(profile: string | null, stage: string): string[] {
  const agnostic = PROFILE_AGNOSTIC_COMPLIANCE_FIELDS[stage];
  if (agnostic) return agnostic;
  if (!profile) return [];
  return REQUIRED_COMPLIANCE_FIELDS[profile]?.[stage] ?? [];
}

/**
 * Verify the agent's structured output carries the required skill-compliance proof for
 * its (profile, stage). Returns a human-readable warning when a profile enforces fields
 * and one or more are missing or empty; null when compliant (or when no profile / no
 * enforced fields). An empty array (`testPlan: []`) counts as missing proof.
 */
export function verifyRepoSkillCompliance(
  profile: string | null,
  stage: string,
  structured: unknown,
): string | null {
  const required = requiredComplianceFields(profile, stage);
  if (required.length === 0) return null;

  const obj =
    typeof structured === 'object' && structured !== null
      ? (structured as Record<string, unknown>)
      : {};
  const missing = required.filter((key) => !isPresent(obj[key]));
  if (missing.length === 0) return null;

  const subject = profile ? `\`${profile}\` ${stage}` : stage;
  return (
    `This ${subject} run did not provide required skill-compliance proof: ` +
    `missing/empty ${missing.map((m) => `\`${m}\``).join(', ')}. The skill requires ` +
    `these fields as evidence it was applied. Treat the output as unverified.`
  );
}

/** A value counts as present if it is a non-empty array, object, or scalar. */
function isPresent(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return true;
}

/** Does a named skill's `SKILL.md` exist? (Used to skip deferred/unauthored skills.) */
export function skillExists(name: string, root: string = skillsRoot()): boolean {
  return existsSync(join(root, name, 'SKILL.md'));
}

/** Absolute path to the repo's top-level `skills/` directory. */
function skillsRoot(): string {
  // src/skills.ts -> packages/agents/src -> packages/agents -> packages -> <repo>
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', '..', 'skills');
}

/**
 * Read a skill's instruction body by name (the `SKILL.md` content with its YAML
 * frontmatter stripped). Throws if the skill is missing — fail closed, never inject
 * an empty/partial skill silently.
 */
export function loadSkill(name: string, root: string = skillsRoot()): string {
  const path = join(root, name, 'SKILL.md');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`skill not found: ${name} (looked in ${path})`);
  }
  return stripFrontmatter(raw).trim();
}

/**
 * Compose one injectable `## Skill` body from one or more skills.
 *
 * The preamble scales with the count:
 * - MULTIPLE skills (the enterprise self-review fan-out): dispatch EACH to its own
 *   subagent so the reviewers run in parallel with isolated, single-concern context,
 *   then merge their verdicts. Worth the dispatch tax when there are several.
 * - A SINGLE skill (the common case, e.g. the always-on adversarial pass): run it
 *   INLINE in this same agent. The stage is already a fresh, isolated session, so a
 *   lone reviewer has nothing to isolate FROM — a subagent would just add a dispatch
 *   round-trip and a duplicate read of the diff for zero parallelism benefit.
 *
 * Throws (fail closed) if any named skill is missing — never inject a partial set.
 */
export function composeSkillText(names: readonly string[], root: string = skillsRoot()): string {
  if (names.length === 0) throw new Error('composeSkillText: no skills to compose');
  const preamble =
    names.length === 1
      ? [
          'Run the single skill below INLINE in this session — do NOT dispatch it to a',
          'subagent (a lone reviewer in an already-isolated stage gains nothing from one).',
          'Read the diff/scope and the source it touches, perform the review per the skill',
          'body, and end with its `json` verdict block.',
        ].join('\n')
      : [
          'Run the skills below. To keep context clean, you **MUST dispatch each skill to its',
          'own subagent** using the Task tool — one Task call per `###` skill — BEFORE writing',
          'any findings yourself. Do NOT perform the reviews inline in this conversation, even',
          'if the diff looks small: inline review is not acceptable here. Give each subagent the',
          'skill body verbatim, the diff/scope, and the worktree path, and have it return ONLY',
          'its findings + its `json` verdict block.',
          '',
          'You are the ORCHESTRATOR: do NOT Read source files yourself — the subagents do the',
          'code reading. You capture the diff/scope once, dispatch, and merge. Reading the source',
          'yourself (before or after dispatching) duplicates the subagents’ work and is not your job.',
          '',
          'After all subagents return, merge their results into a single combined report and one',
          'final `json` verdict (request_changes if ANY subagent requested changes / failed).',
          `There are ${names.length} skills below, so you will make ${names.length} Task calls.`,
        ].join('\n');
  const sections = names.map((name) => `### ${name}\n\n${loadSkill(name, root)}`);
  return [preamble, ...sections].join('\n\n');
}

/**
 * How much external-tool documentation a runtime's models can handle:
 * - `recipes`: ONLY the short per-stage recipe card (literal copy-paste commands).
 *   Small local models are reliable at copying a command and substituting a flag
 *   value, unreliable at synthesizing invocations from prose — so they get the
 *   card and nothing else.
 * - `full`: the recipe card PLUS the tool's complete agent doc.
 */
export type ToolDocTier = 'full' | 'recipes';

/**
 * Cap on the injected doc body per tool. Recipe cards are far below this; the cap
 * exists so a future tool with a huge doc can't blow the stage prompt (the
 * plan-stage prompt-quality regression came from unbounded prompt sections).
 */
const EXTERNAL_TOOL_DOC_CAP = 12_000;

/** Read a doc file for injection, or undefined when absent/empty. Capped. */
function readToolDoc(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const body = stripFrontmatter(readFileSync(path, 'utf8')).trim();
  if (!body) return undefined;
  if (body.length <= EXTERNAL_TOOL_DOC_CAP) return body;
  return `${body.slice(0, EXTERNAL_TOOL_DOC_CAP)}\n\n[... truncated — read the full file at ${path} if you need more]`;
}

/**
 * Compose the `## External tool: …` prompt sections for a stage, or undefined
 * when no configured tool applies. Fail OPEN per tool: a tool whose stages don't
 * include this one, or whose docs are missing on this machine (checkout absent),
 * is silently skipped — external tools are helpers, never a reason to sink a stage.
 *
 * Every applicable tool contributes its per-stage recipe card
 * (`<root>/<recipesDir>/<stage>.md`); `full`-tier runtimes also get the complete
 * doc (`<root>/<docPath>`) appended after the card.
 */
export function composeExternalToolsText(
  tools: readonly ExternalToolConfig[],
  stage: string,
  tier: ToolDocTier,
): string | undefined {
  const sections: string[] = [];
  for (const tool of tools) {
    if (!(tool.stages as readonly string[]).includes(stage)) continue;
    const recipe = tool.recipesDir
      ? readToolDoc(join(tool.root, tool.recipesDir, `${stage}.md`))
      : undefined;
    const fullDoc =
      tier === 'full' && tool.docPath ? readToolDoc(join(tool.root, tool.docPath)) : undefined;
    if (!recipe && !fullDoc) continue;
    sections.push(
      [
        `## External tool: ${tool.name}`,
        '',
        `A helper CLI at \`${tool.root}\` — a separate checkout OUTSIDE this worktree.`,
        'Never edit or commit anything under it; invoke its commands from your shell exactly as documented below.',
        ...(recipe ? ['', recipe] : []),
        ...(fullDoc ? ['', fullDoc] : []),
      ].join('\n'),
    );
  }
  return sections.length ? sections.join('\n\n') : undefined;
}

/** Remove a leading `--- ... ---` YAML frontmatter block, if present. */
export function stripFrontmatter(md: string): string {
  if (!md.startsWith('---')) return md;
  const end = md.indexOf('\n---', 3);
  if (end === -1) return md;
  // Skip past the closing `---` line.
  const after = md.indexOf('\n', end + 1);
  return after === -1 ? '' : md.slice(after + 1);
}
