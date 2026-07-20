import { describe, expect, it } from 'vitest';
import { detectCommandsFromPackageJson, type PackageManager } from './project-commands.js';

describe('detectCommandsFromPackageJson', () => {
  it('maps the common script names onto command fields', () => {
    expect(
      detectCommandsFromPackageJson({
        test: 'vitest run',
        lint: 'eslint .',
        typecheck: 'tsc --noEmit',
        e2e: 'playwright test',
        dev: 'vite',
      }),
    ).toEqual({
      testCommand: 'npm run test',
      lintCommand: 'npm run lint',
      typecheckCommand: 'npm run typecheck',
      e2eCommand: 'npm run e2e',
      devCommand: 'npm run dev',
    });
  });

  it.each<[PackageManager, string]>([
    ['npm', 'npm run lint'],
    ['pnpm', 'pnpm run lint'],
    ['yarn', 'yarn lint'],
  ])('uses the %s invocation prefix', (pm, expected) => {
    expect(detectCommandsFromPackageJson({ lint: 'eslint .' }, pm).lintCommand).toBe(expected);
  });

  it.each<[string, keyof ReturnType<typeof detectCommandsFromPackageJson>, string]>([
    ['type-check', 'typecheckCommand', 'npm run type-check'],
    ['check-types', 'typecheckCommand', 'npm run check-types'],
    ['test:e2e', 'e2eCommand', 'npm run test:e2e'],
    ['start', 'devCommand', 'npm run start'],
  ])('recognises the alias %s', (script, field, expected) => {
    expect(detectCommandsFromPackageJson({ [script]: 'x' })[field]).toBe(expected);
  });

  it('prefers the higher-priority candidate when several exist', () => {
    const got = detectCommandsFromPackageJson({ dev: 'vite', start: 'node server.js' });
    expect(got.devCommand).toBe('npm run dev');
  });

  it('ignores unknown scripts and leaves unmatched fields empty', () => {
    expect(detectCommandsFromPackageJson({ build: 'tsc', release: 'np' })).toEqual({
      testCommand: '',
      lintCommand: '',
      typecheckCommand: '',
      e2eCommand: '',
      devCommand: '',
    });
  });

  it('returns all-empty for missing or empty scripts', () => {
    const empty = {
      testCommand: '',
      lintCommand: '',
      typecheckCommand: '',
      e2eCommand: '',
      devCommand: '',
    };
    expect(detectCommandsFromPackageJson(undefined)).toEqual(empty);
    expect(detectCommandsFromPackageJson({})).toEqual(empty);
    expect(detectCommandsFromPackageJson({ test: '   ' })).toEqual(empty);
  });
});
