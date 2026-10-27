/**
 * Best-effort detection of a project's build commands from its `package.json`.
 *
 * Most users registering a project won't remember the exact test/lint/etc.
 * incantations, so the create-project form offers an "auto-detect" that reads
 * `package.json` scripts and maps them onto our five command fields. This is the
 * pure mapping half (no filesystem) so it's trivially unit-testable; the daemon
 * supplies the parsed scripts + detected package manager.
 */

/** The five build-command fields we surface on a project. */
export interface DetectedCommands {
  testCommand: string;
  lintCommand: string;
  typecheckCommand: string;
  e2eCommand: string;
  devCommand: string;
}

/** Node package managers we recognise, in lockfile-detection terms. */
export type PackageManager = 'npm' | 'pnpm' | 'yarn';

/**
 * Candidate script names for each command field, in preference order. The first
 * script that exists wins. Kept conservative on purpose: we'd rather leave a
 * field blank than guess wrong (the user can always fill it in).
 */
const SCRIPT_CANDIDATES: Record<keyof DetectedCommands, string[]> = {
  // `test:e2e` is intentionally excluded here so it maps to e2eCommand instead.
  testCommand: ['test:unit', 'test'],
  lintCommand: ['lint'],
  typecheckCommand: ['typecheck', 'type-check', 'check-types', 'tsc'],
  e2eCommand: ['e2e', 'test:e2e'],
  devCommand: ['dev', 'start'],
};

/** `yarn <script>`; npm/pnpm use the `run` form. */
function invocation(pm: PackageManager, script: string): string {
  return pm === 'yarn' ? `yarn ${script}` : `${pm} run ${script}`;
}

/**
 * Map a `package.json` `scripts` object onto our command fields, using the
 * given package manager for the invocation prefix. Unknown scripts are ignored;
 * fields with no matching script are left as empty strings.
 */
export function detectCommandsFromPackageJson(
  scripts: Record<string, unknown> | undefined,
  pm: PackageManager = 'npm',
): DetectedCommands {
  const has = (name: string) =>
    !!scripts && typeof scripts[name] === 'string' && (scripts[name] as string).trim() !== '';

  const pick = (field: keyof DetectedCommands): string => {
    const match = SCRIPT_CANDIDATES[field].find(has);
    return match ? invocation(pm, match) : '';
  };

  return {
    testCommand: pick('testCommand'),
    lintCommand: pick('lintCommand'),
    typecheckCommand: pick('typecheckCommand'),
    e2eCommand: pick('e2eCommand'),
    devCommand: pick('devCommand'),
  };
}
