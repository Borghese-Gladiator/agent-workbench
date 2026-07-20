import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExternalToolConfig } from '@workbench/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectRepoType } from '../../../skills/_router/detect-repo-type.mjs';
import { isEmptyRepo } from '../../../skills/_router/is-empty-repo.mjs';
import {
  type AgentRunInput,
  allowedToolsForStage,
  claudeStagePrompt,
  composeExternalToolsText,
  composeSkillText,
  envSetupPreamble,
  isAgentStage,
  isEnterpriseProfile,
  loadSkill,
  requiredComplianceFields,
  skillExists,
  skillForDelivery,
  skillForPlan,
  skillForReadme,
  skillForReview,
  skillForWrite,
  skillsForQa,
  skillsForReview,
  stripFrontmatter,
  verifyRepoSkillCompliance,
} from './index.js';

describe('skillForReview', () => {
  it.each([
    ['ts-shadcn-frontend', 'review-ts-shadcn-frontend'],
    ['py-fastapi-backend', 'review-py-fastapi-backend'],
    ['fender', 'review-fender'],
    ['app', 'review-app'],
  ])('maps profile %s -> %s', (profile, skill) => {
    expect(skillForReview(profile)).toBe(skill);
  });

  it.each([null, 'unknown', ''])('returns null (fail closed) for %s', (profile) => {
    expect(skillForReview(profile)).toBeNull();
  });
});

describe('isEnterpriseProfile', () => {
  it.each(['app', 'fender'])('%s is enterprise', (p) => {
    expect(isEnterpriseProfile(p)).toBe(true);
  });

  it.each([
    'ts-shadcn-frontend',
    'py-fastapi-backend',
    'unknown',
    '',
    null,
  ])('%s is NOT enterprise', (p) => {
    expect(isEnterpriseProfile(p)).toBe(false);
  });
});

describe('envSetupPreamble', () => {
  it('fender → points at the direnv-setup skill + the eval direnv export fix', () => {
    const text = envSetupPreamble('fender');
    expect(text).toContain('direnv-setup');
    expect(text).toMatch(/eval "\$\(direnv export bash\)"|direnv exec/);
    expect(text).toMatch(/non-interactive/i);
  });

  it('app → warns the worktree may test the main checkout source, not the edits', () => {
    const text = envSetupPreamble('app');
    expect(text).toMatch(/worktree/i);
    expect(text).toMatch(/sys\.path|PYTHONPATH/);
    expect(text).toMatch(/main checkout/i);
  });

  it.each([
    'ts-shadcn-frontend',
    'py-fastapi-backend',
    'unknown',
    '',
    null,
  ])('non-enterprise %s → empty (no preamble)', (p) => {
    expect(envSetupPreamble(p)).toBe('');
  });
});

describe('skillsForReview (profile + always-on pass)', () => {
  it('non-enterprise frontend → profile skill + adversarial only', () => {
    expect(skillsForReview('ts-shadcn-frontend')).toEqual({
      profile: 'review-ts-shadcn-frontend',
      always: ['review-adversarial'],
    });
  });

  it('non-enterprise python → py skill + adversarial only', () => {
    expect(skillsForReview('py-fastapi-backend')).toEqual({
      profile: 'review-py-fastapi-backend',
      always: ['review-adversarial'],
    });
  });

  it.each([
    'app',
    'fender',
  ])('enterprise %s → profile skill + multi-agent fan-out (correctness/security/tests) + adversarial', (p) => {
    const { profile, always } = skillsForReview(p);
    expect(profile).toBe(`review-${p}`);
    expect(always).toEqual([
      'review-correctness',
      'review-security-perf',
      'review-tests',
      'review-adversarial',
    ]);
  });

  it.each([null, 'unknown'])('unknown profile %s → adversarial only (never blocks)', (p) => {
    expect(skillsForReview(p)).toEqual({ profile: null, always: ['review-adversarial'] });
  });
});

describe('skillsForQa', () => {
  it('returns the E2E driver then the artifact bundler, in order', () => {
    expect(skillsForQa()).toEqual(['qa-e2e-playwright', 'qa-artifacts']);
  });
});

describe('composeSkillText', () => {
  it('inlines each real skill body under its subheading + a subagent preamble', () => {
    const out = composeSkillText(['review-ts-shadcn-frontend', 'review-adversarial']);
    expect(out).toContain('### review-ts-shadcn-frontend');
    expect(out).toContain('getByRole'); // frontend body
    expect(out).toContain('### review-adversarial');
    expect(out).toContain('break the change'); // adversarial body
    expect(out).toMatch(/subagent/i); // dispatch preamble
    expect(out).toMatch(/do NOT Read source files yourself/i); // orchestrate-only
  });

  it('runs a SINGLE skill inline (no subagent dispatch)', () => {
    const out = composeSkillText(['review-adversarial']);
    expect(out).toContain('### review-adversarial');
    expect(out).toContain('break the change'); // body still inlined
    expect(out).toMatch(/INLINE/i); // inline preamble
    expect(out).toMatch(/do NOT dispatch it to a/i);
    // The multi-agent orchestrate language must NOT appear for one reviewer.
    expect(out).not.toMatch(/ORCHESTRATOR/);
    expect(out).not.toMatch(/Task calls/);
  });

  it('throws (fail closed) when any named skill is missing', () => {
    expect(() => composeSkillText(['review-ts-shadcn-frontend', 'nope'])).toThrow(
      /skill not found/,
    );
  });

  it('throws when given no skills', () => {
    expect(() => composeSkillText([])).toThrow(/no skills/);
  });
});

describe('stage policy for skill-bearing stages', () => {
  it('verification is now an agent-runnable stage', () => {
    expect(isAgentStage('feature_e2e')).toBe(true);
  });

  it.each([
    'feature_e2e',
    'agent_self_review',
  ])('%s allows the Task tool (subagent dispatch)', (stage) => {
    expect(allowedToolsForStage(stage)).toContain('Task');
  });

  it('verification can run Bash + Write (the E2E spec) but not Edit the source', () => {
    const tools = allowedToolsForStage('feature_e2e');
    expect(tools).toContain('Bash');
    // Write is allowed so the agent can author the spec into the workbench-side
    // QA_SPEC_DIR; Edit stays denied so it cannot alter the target's source.
    expect(tools).toContain('Write');
    expect(tools).not.toContain('Edit');
  });
});

describe('stripFrontmatter', () => {
  it('removes a leading YAML frontmatter block', () => {
    const md = '---\nname: x\ndescription: y\n---\nBODY here';
    expect(stripFrontmatter(md)).toBe('BODY here');
  });

  it('leaves content without frontmatter unchanged', () => {
    expect(stripFrontmatter('no frontmatter')).toBe('no frontmatter');
  });
});

describe('loadSkill', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'wb-skills-'));
    mkdirSync(join(root, 'demo'));
    writeFileSync(join(root, 'demo', 'SKILL.md'), '---\nname: demo\n---\nDo the demo thing.\n');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('reads the body with frontmatter stripped', () => {
    expect(loadSkill('demo', root)).toBe('Do the demo thing.');
  });

  it('throws (fail closed) when the skill is missing', () => {
    expect(() => loadSkill('nope', root)).toThrow(/skill not found/);
  });

  it('loads the real review-ts-shadcn-frontend skill', () => {
    expect(loadSkill('review-ts-shadcn-frontend')).toContain('getByRole');
  });

  it('loads the real review-py-fastapi-backend skill (Poetry conventions)', () => {
    expect(loadSkill('review-py-fastapi-backend').toLowerCase()).toContain('poetry');
  });

  it('loads the real review-app skill (pytest conventions)', () => {
    expect(loadSkill('review-app')).toContain('bin/pytest -m unit');
  });

  it('loads the real review-fender skill (RTL conventions)', () => {
    expect(loadSkill('review-fender')).toContain('getByRole');
  });

  it('loads the real plan-app skill (test-first)', () => {
    expect(loadSkill('plan-app')).toContain('bin/pytest -m unit');
  });

  it('loads the real plan-fender skill (test-first)', () => {
    expect(loadSkill('plan-fender')).toContain('turbo test');
  });

  it.each([
    'plan-app',
    'plan-fender',
  ])('%s binds each test to an Acceptance Criteria ID (criterionId)', (skill) => {
    const body = loadSkill(skill);
    expect(body).toContain('criterionId');
    expect(body).toContain('Validation by criterion');
  });

  it('qa-e2e-playwright gates on "would this have failed before" + maps criteria', () => {
    const body = loadSkill('qa-e2e-playwright');
    expect(body).toMatch(/would this have failed before this change\?/i);
    expect(body).toContain('criterionCoverage');
    expect(body).toMatch(/criterion coverage/i);
  });

  it('loads the real write-app skill (test-first writing)', () => {
    expect(loadSkill('write-app')).toContain('bin/pytest -m unit');
  });

  it('loads the real write-fender skill (test-first writing)', () => {
    expect(loadSkill('write-fender')).toContain('turbo test');
  });

  it('loads the real write-readme skill (build/dev/prod commands + description + hierarchy)', () => {
    const body = loadSkill('write-readme');
    expect(body).toMatch(/build/i);
    expect(body).toMatch(/run \(dev\)/i);
    expect(body).toMatch(/run \(prod\)/i);
    expect(body).toMatch(/description/i);
    expect(body).toMatch(/file hierarchy/i);
    // The required json proof fields the skill's output contract names.
    expect(body).toContain('buildCommands');
    expect(body).toContain('devCommands');
    expect(body).toContain('prodCommands');
    expect(body).toContain('fileHierarchy');
  });

  it('loads the real enterprise fan-out reviewers', () => {
    expect(loadSkill('review-correctness')).toContain('passing-but-wrong');
    expect(loadSkill('review-security-perf').toLowerCase()).toContain('n+1');
    expect(loadSkill('review-tests')).toContain('coverage');
  });
});

describe('skillForPlan', () => {
  it.each<[string, string]>([
    ['app', 'plan-app'],
    ['fender', 'plan-fender'],
  ])('maps profile %s -> %s', (profile, skill) => {
    expect(skillForPlan(profile)).toBe(skill);
  });

  it.each([
    'ts-shadcn-frontend',
    'py-fastapi-backend',
    null,
  ])('returns null for profile %s (no planning skill)', (profile) => {
    expect(skillForPlan(profile)).toBeNull();
  });
});

describe('skillForWrite', () => {
  it.each<[string, string]>([
    ['app', 'write-app'],
    ['fender', 'write-fender'],
  ])('maps profile %s -> %s', (profile, skill) => {
    expect(skillForWrite(profile)).toBe(skill);
  });

  it.each([
    'ts-shadcn-frontend',
    'py-fastapi-backend',
    'unknown',
    null,
  ])('returns null for profile %s (no writing skill)', (profile) => {
    expect(skillForWrite(profile)).toBeNull();
  });
});

describe('skillForReadme', () => {
  it('returns the profile-agnostic write-readme skill', () => {
    expect(skillForReadme()).toBe('write-readme');
  });

  it('points at an authored SKILL.md', () => {
    expect(skillExists(skillForReadme())).toBe(true);
  });
});

describe('skillForDelivery', () => {
  it('returns the profile-agnostic pr-description skill', () => {
    expect(skillForDelivery()).toBe('pr-description');
  });

  it('points at an authored SKILL.md', () => {
    expect(skillExists(skillForDelivery())).toBe(true);
  });

  it('loads with the policy-branch + template + output contract', () => {
    const body = loadSkill(skillForDelivery());
    expect(body).toContain('delivery policy');
    // The fixed template sections the writer fills.
    expect(body).toContain('### Changes Overview');
    expect(body).toContain('# Manual Test Plan');
    // The omission rule that keeps Changes Overview a terse file list, not docs.
    expect(body).toContain('true overview');
    // The Manual Test Plan is assembled from real artifacts, not fabricated.
    expect(body).toContain("reuse, don't invent");
    expect(body).toContain('validation_report');
    expect(body).toContain('demo_evidence');
    // The required json proof fields the daemon enforces.
    expect(body).toContain('"summary"');
    expect(body).toContain('"changes"');
  });
});

describe('requiredComplianceFields', () => {
  it.each<[string | null, string, string[]]>([
    ['app', 'discovery', ['testPlan', 'precedentTests']],
    ['app', 'implementation', ['precedentCitations', 'testsWritten']],
    ['fender', 'implementation', ['precedentCitations', 'testsWritten']],
    ['fender', 'agent_self_review', ['precedentCitations', 'checks']],
    ['app', 'task_brief', []],
    ['ts-shadcn-frontend', 'discovery', []],
    [null, 'discovery', []],
    // delivery_prep is profile-agnostic: enforced for EVERY profile, incl. null.
    ['app', 'delivery_prep', ['summary', 'changes']],
    ['ts-shadcn-frontend', 'delivery_prep', ['summary', 'changes']],
    [null, 'delivery_prep', ['summary', 'changes']],
  ])('(%s, %s) requires %j', (profile, stage, expected) => {
    expect(requiredComplianceFields(profile, stage)).toEqual(expected);
  });
});

describe('verifyRepoSkillCompliance', () => {
  it('warns when a required field is missing for a profiled stage', () => {
    const warning = verifyRepoSkillCompliance('app', 'discovery', {
      testPlan: [{ target: 'foo', cases: ['a'] }],
      // precedentTests missing
    });
    expect(warning).toContain('precedentTests');
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['app', { precedentCitations: ['src/learning/app/x.py:12'] }, 'testsWritten'],
    [
      'fender',
      { precedentCitations: [], testsWritten: [{ file: 'X.test.tsx' }] },
      'precedentCitations',
    ],
  ])('warns at implementation for %s when %j is incomplete', (profile, structured, missing) => {
    expect(verifyRepoSkillCompliance(profile, 'implementation', structured)).toContain(missing);
  });

  it('returns null at implementation when precedent + tests proof is present', () => {
    expect(
      verifyRepoSkillCompliance('app', 'implementation', {
        precedentCitations: ['src/learning/app/x.py:12'],
        testsWritten: [{ file: 'tests/test_x.py', cases: ['happy'] }],
      }),
    ).toBeNull();
  });

  it('treats an empty array as missing proof', () => {
    expect(
      verifyRepoSkillCompliance('app', 'discovery', {
        testPlan: [],
        precedentTests: ['tests/x_test.py'],
      }),
    ).toContain('testPlan');
  });

  it('returns null when all required fields are present and non-empty', () => {
    expect(
      verifyRepoSkillCompliance('fender', 'agent_self_review', {
        precedentCitations: ['src/Button.tsx:12'],
        checks: [{ item: 'roles', result: 'pass' }],
      }),
    ).toBeNull();
  });

  it('never warns for an unknown / null profile', () => {
    expect(verifyRepoSkillCompliance(null, 'discovery', null)).toBeNull();
    expect(verifyRepoSkillCompliance('ts-shadcn-frontend', 'agent_self_review', {})).toBeNull();
  });

  it('warns when the structured block is missing entirely (null)', () => {
    expect(verifyRepoSkillCompliance('app', 'agent_self_review', null)).toContain('missing/empty');
  });

  it('enforces delivery_prep proof even with no profile', () => {
    // summary present, changes missing -> warns regardless of (null) profile.
    expect(verifyRepoSkillCompliance(null, 'delivery_prep', { summary: 'does X' })).toContain(
      'changes',
    );
  });

  it('returns null at delivery_prep when summary + changes are present', () => {
    expect(
      verifyRepoSkillCompliance(null, 'delivery_prep', {
        summary: 'Add group_by to the segment report',
        changes: ['add param', 'push grouping to DB'],
      }),
    ).toBeNull();
  });
});

describe('claudeStagePrompt skill injection', () => {
  const base: AgentRunInput = {
    taskId: 't1',
    stage: 'agent_self_review',
    worktreePath: '/tmp/wt',
    contextArtifactIds: [],
    allowedTools: ['Read'],
    taskTitle: 'Review it',
    rawRequest: 'review the change',
  };

  it('injects a ## Skill section when skillText is present', () => {
    const out = claudeStagePrompt({ ...base, skillText: 'REVIEW RULES HERE' });
    expect(out).toContain('## Skill');
    expect(out).toContain('REVIEW RULES HERE');
  });

  it('omits the ## Skill section when skillText is absent (back-compat)', () => {
    expect(claudeStagePrompt(base)).not.toContain('## Skill');
  });
});

describe('detectRepoType', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'wb-detect-'));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const mk = (name: string, files: Record<string, string>): string => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    for (const [f, content] of Object.entries(files)) {
      writeFileSync(join(dir, f), content);
    }
    return dir;
  };

  it('detects ts-shadcn-frontend via components.json', () => {
    expect(detectRepoType(mk('fe-shadcn', { 'components.json': '{}' }))).toBe('ts-shadcn-frontend');
  });

  it('detects ts-shadcn-frontend via tailwind dep', () => {
    const dir = mk('fe-tw', {
      'package.json': JSON.stringify({ devDependencies: { tailwindcss: '^3' } }),
    });
    expect(detectRepoType(dir)).toBe('ts-shadcn-frontend');
  });

  it('detects py-fastapi-backend via pyproject', () => {
    const dir = mk('be', { 'pyproject.toml': '[project]\ndependencies = ["fastapi"]' });
    expect(detectRepoType(dir)).toBe('py-fastapi-backend');
  });

  it('detects fender via turbo.json + @klaviyo dep', () => {
    const dir = mk('fender-like', {
      'turbo.json': '{}',
      'package.json': JSON.stringify({ dependencies: { '@klaviyo/foo': '1' } }),
    });
    expect(detectRepoType(dir)).toBe('fender');
  });

  it('detects app by CONTENT (manage.py + src/learning) — including task worktrees', () => {
    // Regression: the match was path-based (Klaviyo/Repos + an `app` segment),
    // so a per-task git worktree under data/worktrees/<project>/<task> silently
    // lost skill injection + compliance. Content must be the signal.
    const dir = mk('task_X-some-app-worktree', { 'manage.py': '' });
    mkdirSync(join(dir, 'src', 'learning'), { recursive: true });
    expect(detectRepoType(dir)).toBe('app');
  });

  it('does NOT detect app for a generic Django repo without src/learning', () => {
    expect(detectRepoType(mk('django-generic', { 'manage.py': '' }))).toBeNull();
  });

  it('returns null when no signal matches', () => {
    expect(detectRepoType(mk('empty', { 'README.md': 'hi' }))).toBeNull();
  });
});

describe('isEmptyRepo', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'wb-empty-'));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const mk = (name: string, files: Record<string, string>): string => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    for (const [f, content] of Object.entries(files)) {
      const full = join(dir, f);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content);
    }
    return dir;
  };

  it('treats a truly empty directory as empty', () => {
    expect(isEmptyRepo(mk('bare', {}))).toBe(true);
  });

  it('treats README / LICENSE / .gitignore-only scaffolding as empty', () => {
    const dir = mk('scaffold', {
      'README.md': '# project',
      LICENSE: 'MIT',
      '.gitignore': 'node_modules',
    });
    expect(isEmptyRepo(dir)).toBe(true);
  });

  it('treats bare root dotfiles as boilerplate, not content', () => {
    expect(isEmptyRepo(mk('dots', { '.env.example': 'X=1', '.npmrc': '' }))).toBe(true);
  });

  it('is NOT empty when a top-level source file exists', () => {
    expect(isEmptyRepo(mk('with-src', { 'index.ts': 'export {}' }))).toBe(false);
  });

  it('is NOT empty when package.json exists alongside boilerplate', () => {
    expect(isEmptyRepo(mk('with-pkg', { 'README.md': 'hi', 'package.json': '{}' }))).toBe(false);
  });

  it('is NOT empty when source is nested under a subdirectory', () => {
    expect(isEmptyRepo(mk('nested', { 'README.md': 'hi', 'src/app.py': 'print(1)' }))).toBe(false);
  });

  it('ignores .git and friends but still finds real content', () => {
    expect(isEmptyRepo(mk('vcs-only', { '.git/HEAD': 'ref: x' }))).toBe(true);
  });

  it('returns false for a non-existent directory (cannot claim empty)', () => {
    expect(isEmptyRepo(join(root, 'does-not-exist'))).toBe(false);
  });
});

describe('composeExternalToolsText', () => {
  let toolRoot: string;
  const seedTool = (overrides: Partial<ExternalToolConfig> = {}): ExternalToolConfig => ({
    name: 'local-seed',
    root: toolRoot,
    docPath: 'CLAUDE.md',
    recipesDir: 'docs/recipes',
    stages: ['implementation', 'feature_e2e'],
    ...overrides,
  });

  beforeAll(() => {
    toolRoot = mkdtempSync(join(tmpdir(), 'wb-exttool-'));
    mkdirSync(join(toolRoot, 'docs', 'recipes'), { recursive: true });
    writeFileSync(join(toolRoot, 'CLAUDE.md'), '---\ntitle: x\n---\nfull-doc-body');
    writeFileSync(join(toolRoot, 'docs', 'recipes', 'implementation.md'), 'recipe-impl-body');
  });
  afterAll(() => rmSync(toolRoot, { recursive: true, force: true }));

  it('returns undefined for a stage the tool is not configured for', () => {
    expect(composeExternalToolsText([seedTool()], 'discovery', 'full')).toBeUndefined();
  });

  it('recipes tier: injects the per-stage card + guardrails, NOT the full doc', () => {
    const text = composeExternalToolsText([seedTool()], 'implementation', 'recipes');
    expect(text).toContain('## External tool: local-seed');
    expect(text).toContain(toolRoot);
    expect(text).toContain('recipe-impl-body');
    expect(text).toMatch(/never edit or commit/i);
    expect(text).not.toContain('full-doc-body');
  });

  it('full tier: injects the card AND the full doc (frontmatter stripped)', () => {
    const text = composeExternalToolsText([seedTool()], 'implementation', 'full');
    expect(text).toContain('recipe-impl-body');
    expect(text).toContain('full-doc-body');
    expect(text).not.toContain('title: x');
  });

  it('recipes tier with no card for the stage: fail open (undefined)', () => {
    // feature_e2e is a configured stage but has no recipe card authored.
    expect(composeExternalToolsText([seedTool()], 'feature_e2e', 'recipes')).toBeUndefined();
  });

  it('full tier with no card falls back to the full doc alone', () => {
    const text = composeExternalToolsText([seedTool()], 'feature_e2e', 'full');
    expect(text).toContain('full-doc-body');
  });

  it('missing checkout on this machine: fail open (undefined), never throws', () => {
    const gone = seedTool({ root: join(toolRoot, 'does-not-exist') });
    expect(composeExternalToolsText([gone], 'implementation', 'full')).toBeUndefined();
  });

  it('caps an oversized doc and points at the file for the rest', () => {
    writeFileSync(join(toolRoot, 'BIG.md'), 'x'.repeat(20_000));
    const text = composeExternalToolsText(
      [seedTool({ docPath: 'BIG.md', recipesDir: undefined })],
      'implementation',
      'full',
    );
    expect(text).toContain('[... truncated');
    expect(text!.length).toBeLessThan(15_000);
  });

  it('no tools -> undefined', () => {
    expect(composeExternalToolsText([], 'implementation', 'full')).toBeUndefined();
  });
});
