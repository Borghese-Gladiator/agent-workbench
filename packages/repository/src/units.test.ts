import { rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverUnits } from './units.js';
import { makeTempRepo, writeFileEnsuringDir } from './test-helpers.js';

// Count package.json reads to prove discovery is linear, not O(n^2). The module is mocked so the
// counting readFile is the one `manifests.ts` binds at import time (a runtime spyOn would not be
// seen through its destructured import).
const packageJsonReadCounter = { count: 0 };
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    readFile: (path: Parameters<typeof actual.readFile>[0], ...rest: unknown[]) => {
      if (typeof path === 'string' && path.endsWith('package.json')) packageJsonReadCounter.count++;
      return (actual.readFile as (...a: unknown[]) => unknown)(path, ...rest);
    },
  };
});

describe('discoverUnits scaling', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempRepo();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeSyntheticWorkspace(packageCount: number): Promise<void> {
    await writeFileEnsuringDir(
      dir,
      'package.json',
      JSON.stringify({ name: 'root', packageManager: 'pnpm@9.0.0' }),
    );
    for (let i = 0; i < packageCount; i++) {
      // Each package depends on the next, so the dependency-linking pass has real edges to resolve.
      const dependsOn = i < packageCount - 1 ? { [`pkg-${i + 1}`]: 'workspace:*' } : undefined;
      await writeFileEnsuringDir(
        dir,
        `packages/pkg-${i}/package.json`,
        JSON.stringify({ name: `pkg-${i}`, dependencies: dependsOn }),
      );
    }
  }

  it('reads each package.json once, not O(n^2), on a large workspace', async () => {
    const packageCount = 600;
    await writeSyntheticWorkspace(packageCount);

    packageJsonReadCounter.count = 0;
    const units = await discoverUnits(dir);

    // Root unit + one per package.
    expect(units).toHaveLength(packageCount + 1);
    // Linear in package count: a small constant per package, nowhere near n^2
    // (the old nested re-read did ~packageCount^2 reads).
    expect(packageJsonReadCounter.count).toBeLessThan(packageCount * 3);
  });

  it('still resolves workspace dependency edges correctly', async () => {
    await writeSyntheticWorkspace(3);

    const units = await discoverUnits(dir);
    const byRoot = new Map(units.map((u) => [u.root, u]));

    const pkg0 = byRoot.get('packages/pkg-0');
    const pkg1 = byRoot.get('packages/pkg-1');
    const pkg2 = byRoot.get('packages/pkg-2');

    expect(pkg0?.dependsOn).toEqual([pkg1?.id]);
    expect(pkg1?.dependsOn).toEqual([pkg2?.id]);
    expect(pkg2?.dependsOn).toEqual([]);
  });
});
