import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export async function makeTmpRepo(prefix = 'awb-repo-map-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function writeFixtureFile(root: string, relativePath: string, contents: string): Promise<string> {
  const fullPath = join(root, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, contents, 'utf8');
  return fullPath;
}
