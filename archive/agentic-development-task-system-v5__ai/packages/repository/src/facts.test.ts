import { describe, expect, it } from 'vitest';
import type { RepositoryUnit, ValidatedCommand } from '@awb/domain';
import { extractFacts } from './facts.js';

const REPO = 'repo-1';
const SHA = 'a'.repeat(40);

function cmd(partial: Partial<ValidatedCommand> & Pick<ValidatedCommand, 'purpose' | 'command'>): ValidatedCommand {
  return {
    id: `c-${partial.purpose}`,
    repositoryId: REPO,
    cwd: '.',
    source: 'package-script',
    status: 'declared',
    ...partial,
  };
}

// extractFacts probes the filesystem for docs/units; with a nonexistent rootDir those yield nothing,
// leaving only the command-derived facts under test.
async function factsFor(commands: ValidatedCommand[], units: RepositoryUnit[] = []) {
  return extractFacts('/nonexistent-root-for-test', REPO, SHA, units, commands);
}

describe('extractFacts — command/testing facts', () => {
  it('emits a testing fact for test commands and a command fact for build/start', async () => {
    const facts = await factsFor([
      cmd({ purpose: 'unit-test', command: 'vitest run' }),
      cmd({ purpose: 'build', command: 'tsc -b' }),
      cmd({ purpose: 'start', command: 'yarn dev' }),
    ]);

    const testing = facts.find((f) => f.kind === 'testing');
    expect(testing?.statement).toContain('vitest run');

    const commandStatements = facts.filter((f) => f.kind === 'command').map((f) => f.statement);
    expect(commandStatements.some((s) => s.includes('tsc -b'))).toBe(true);
    expect(commandStatements.some((s) => s.includes('yarn dev'))).toBe(true);
  });

  it('marks a validated command as a validated fact, others inferred', async () => {
    const facts = await factsFor([
      cmd({ purpose: 'start', command: 'make run-server', status: 'validated' }),
      cmd({ purpose: 'build', command: 'tsc -b', status: 'declared' }),
    ]);
    expect(facts.find((f) => f.statement.includes('make run-server'))?.confidence).toBe('validated');
    expect(facts.find((f) => f.statement.includes('tsc -b'))?.confidence).toBe('inferred');
  });

  it('includes the cwd when a command runs outside the repo root', async () => {
    const facts = await factsFor([cmd({ purpose: 'unit-test', command: 'pytest', cwd: 'services/api' })]);
    expect(facts[0]?.statement).toContain('cwd services/api');
    expect(facts[0]?.sourcePaths).toEqual(['services/api']);
  });

  it('skips noisy/unreliable rows (custom purpose, ambiguous/obsolete/failed status)', async () => {
    const facts = await factsFor([
      cmd({ purpose: 'custom', command: 'do-a-thing' }),
      cmd({ purpose: 'build', command: 'ambiguous-build', status: 'ambiguous' }),
      cmd({ purpose: 'lint', command: 'obsolete-lint', status: 'obsolete' }),
      cmd({ purpose: 'unit-test', command: 'failed-test', status: 'failed' }),
    ]);
    const statements = facts.map((f) => f.statement).join('\n');
    expect(statements).not.toContain('do-a-thing');
    expect(statements).not.toContain('ambiguous-build');
    expect(statements).not.toContain('obsolete-lint');
    expect(statements).not.toContain('failed-test');
  });

  it('emits nothing command-related when no commands are given', async () => {
    const facts = await factsFor([]);
    expect(facts.filter((f) => f.kind === 'command' || f.kind === 'testing')).toEqual([]);
  });
});
