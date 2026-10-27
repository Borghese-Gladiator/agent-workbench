import { rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverUnits } from './units.js';
import { makeTempRepo, writeFileEnsuringDir } from './test-helpers.js';

// Count manifest reads to prove discovery is linear, not O(n^2). The module is mocked so the
// counting readFile is the one `manifests.ts` binds at import time (a runtime spyOn would not be
// seen through its destructured import).
const manifestReadCounts = new Map<string, number>();
function countManifestRead(path: string): void {
  for (const name of ['package.json', 'pyproject.toml', 'requirements.txt', 'go.mod', 'pom.xml']) {
    if (path.endsWith(name)) manifestReadCounts.set(name, (manifestReadCounts.get(name) ?? 0) + 1);
  }
}
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    readFile: (path: Parameters<typeof actual.readFile>[0], ...rest: unknown[]) => {
      if (typeof path === 'string') countManifestRead(path);
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

  it('reads each manifest once, not O(n^2), on a large workspace', async () => {
    const packageCount = 600;
    await writeSyntheticWorkspace(packageCount);

    manifestReadCounts.clear();
    const units = await discoverUnits(dir);

    // Root unit + one per package.
    expect(units).toHaveLength(packageCount + 1);
    // Linear in package count for every manifest kind: a small constant per package, nowhere near
    // n^2 (the old nested re-read did ~packageCount^2 reads of package.json alone).
    expect(manifestReadCounts.get('package.json') ?? 0).toBeLessThan(packageCount * 3);
    expect(manifestReadCounts.get('pyproject.toml') ?? 0).toBeLessThan(packageCount * 3);
    expect(manifestReadCounts.get('go.mod') ?? 0).toBeLessThan(packageCount * 3);
    expect(manifestReadCounts.get('pom.xml') ?? 0).toBeLessThan(packageCount * 3);
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

describe('discoverUnits cross-ecosystem dependency linking', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempRepo();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('links Python workspace packages via pyproject dependencies', async () => {
    await writeFileEnsuringDir(dir, 'package.json', JSON.stringify({ name: 'root' }));
    await writeFileEnsuringDir(
      dir,
      'packages/svc/pyproject.toml',
      '[project]\nname = "svc"\ndependencies = ["lib-core>=1.0", "requests"]\n',
    );
    await writeFileEnsuringDir(
      dir,
      'packages/lib-core/pyproject.toml',
      '[project]\nname = "lib-core"\n',
    );

    const units = await discoverUnits(dir);
    const byRoot = new Map(units.map((u) => [u.root, u]));
    const svc = byRoot.get('packages/svc');
    const libCore = byRoot.get('packages/lib-core');

    expect(svc?.language).toBe('python');
    // Edge to the in-workspace lib-core; the external `requests` dep resolves to nothing.
    expect(svc?.dependsOn).toEqual([libCore?.id]);
  });

  it('links a poetry package via [tool.poetry.dependencies]', async () => {
    await writeFileEnsuringDir(dir, 'package.json', JSON.stringify({ name: 'root' }));
    await writeFileEnsuringDir(
      dir,
      'packages/app/pyproject.toml',
      '[tool.poetry]\nname = "app"\n[tool.poetry.dependencies]\npython = "^3.11"\nshared = "^0.1"\n',
    );
    await writeFileEnsuringDir(
      dir,
      'packages/shared/pyproject.toml',
      '[tool.poetry]\nname = "shared"\n',
    );

    const units = await discoverUnits(dir);
    const byRoot = new Map(units.map((u) => [u.root, u]));
    const app = byRoot.get('packages/app');
    const shared = byRoot.get('packages/shared');

    // `python` is filtered; only the in-workspace `shared` becomes an edge.
    expect(app?.dependsOn).toEqual([shared?.id]);
  });

  it('links requirements.txt dependencies to workspace packages', async () => {
    await writeFileEnsuringDir(dir, 'package.json', JSON.stringify({ name: 'root' }));
    await writeFileEnsuringDir(
      dir,
      'services/worker/requirements.txt',
      '# deps\ncommon==2.1.0\nboto3\n',
    );
    await writeFileEnsuringDir(
      dir,
      'packages/common/pyproject.toml',
      '[project]\nname = "common"\n',
    );

    const units = await discoverUnits(dir);
    const byRoot = new Map(units.map((u) => [u.root, u]));
    const worker = byRoot.get('services/worker');
    const common = byRoot.get('packages/common');

    expect(worker?.dependsOn).toEqual([common?.id]);
  });

  it('links across ecosystems within a mixed (TS + Python) monorepo', async () => {
    await writeFileEnsuringDir(dir, 'package.json', JSON.stringify({ name: 'root' }));
    await writeFileEnsuringDir(
      dir,
      'packages/web/package.json',
      JSON.stringify({ name: 'web', dependencies: { 'ui-kit': 'workspace:*' } }),
    );
    await writeFileEnsuringDir(dir, 'packages/ui-kit/package.json', JSON.stringify({ name: 'ui-kit' }));
    await writeFileEnsuringDir(
      dir,
      'services/api/pyproject.toml',
      '[project]\nname = "api"\ndependencies = ["models"]\n',
    );
    await writeFileEnsuringDir(dir, 'packages/models/pyproject.toml', '[project]\nname = "models"\n');

    const units = await discoverUnits(dir);
    const byRoot = new Map(units.map((u) => [u.root, u]));

    expect(byRoot.get('packages/web')?.dependsOn).toEqual([byRoot.get('packages/ui-kit')?.id]);
    expect(byRoot.get('services/api')?.dependsOn).toEqual([byRoot.get('packages/models')?.id]);
  });

  it('links Go modules via go.mod require', async () => {
    await writeFileEnsuringDir(dir, 'package.json', JSON.stringify({ name: 'root' }));
    await writeFileEnsuringDir(
      dir,
      'services/gateway/go.mod',
      'module github.com/acme/gateway\n\ngo 1.22\n\nrequire (\n\tgithub.com/acme/core v0.0.0\n\tgithub.com/gorilla/mux v1.8.0\n)\n',
    );
    await writeFileEnsuringDir(dir, 'packages/core/go.mod', 'module github.com/acme/core\n\ngo 1.22\n');

    const units = await discoverUnits(dir);
    const byRoot = new Map(units.map((u) => [u.root, u]));
    const gateway = byRoot.get('services/gateway');
    const core = byRoot.get('packages/core');

    expect(gateway?.language).toBe('go');
    // Edge to the in-repo core module; the external gorilla/mux require resolves to nothing.
    expect(gateway?.dependsOn).toEqual([core?.id]);
  });

  it('links JVM modules via Maven pom.xml coordinates', async () => {
    await writeFileEnsuringDir(dir, 'package.json', JSON.stringify({ name: 'root' }));
    await writeFileEnsuringDir(
      dir,
      'services/orders/pom.xml',
      '<project><groupId>com.acme</groupId><artifactId>orders</artifactId>' +
        '<dependencies><dependency><groupId>com.acme</groupId><artifactId>shared</artifactId></dependency>' +
        '<dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter</artifactId></dependency>' +
        '</dependencies></project>',
    );
    await writeFileEnsuringDir(
      dir,
      'packages/shared/pom.xml',
      '<project><groupId>com.acme</groupId><artifactId>shared</artifactId></project>',
    );

    const units = await discoverUnits(dir);
    const byRoot = new Map(units.map((u) => [u.root, u]));
    const orders = byRoot.get('services/orders');
    const shared = byRoot.get('packages/shared');

    expect(orders?.language).toBe('jvm');
    // Edge to in-repo shared; the external spring-boot-starter coordinate resolves to nothing.
    expect(orders?.dependsOn).toEqual([shared?.id]);
  });

  it('links JVM modules via Gradle implementation coordinates', async () => {
    await writeFileEnsuringDir(dir, 'package.json', JSON.stringify({ name: 'root' }));
    await writeFileEnsuringDir(
      dir,
      'services/app/build.gradle',
      "group = 'com.acme'\ndependencies {\n  implementation 'com.acme:lib:1.0'\n  implementation 'com.google.guava:guava:33.0'\n}\n",
    );
    await writeFileEnsuringDir(
      dir,
      'packages/lib/build.gradle',
      "group = 'com.acme'\nrootProject.name = 'lib'\n",
    );

    const units = await discoverUnits(dir);
    const byRoot = new Map(units.map((u) => [u.root, u]));
    const app = byRoot.get('services/app');
    const lib = byRoot.get('packages/lib');

    // com.acme:lib matches the in-repo lib module; the external guava coordinate resolves to nothing.
    expect(app?.dependsOn).toEqual([lib?.id]);
  });
});
