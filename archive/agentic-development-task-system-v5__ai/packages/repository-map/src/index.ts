import { readFileSync, readdirSync, type Dirent } from 'node:fs';
import { join, relative } from 'node:path';
import { discoverUnits } from './units.js';
import { detectLanguage, extractSymbolsFromSource } from './symbols.js';
import { extractImportEdges } from './imports.js';
import { cacheKey, hashFileContents, type CacheKeyInput, type RepositoryMapCache } from './cache.js';
import type { Edge, RepositoryMap, SymbolRecord } from './types.js';

export * from './types.js';
export * from './cache.js';
export { discoverUnits } from './units.js';
export { extractSymbolsFromSource, detectLanguage } from './symbols.js';
export { extractImportEdges } from './imports.js';
export { createParser, loadLanguage, languageForFile, type ParserLanguage } from './parser.js';

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', '.venv', 'venv']);

function listSourceFiles(unitRoot: string): string[] {
  const results: string[] = [];
  function walk(dir: string): void {
    let entries: Dirent[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx|py)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        results.push(full);
      }
    }
  }
  walk(unitRoot);
  return results;
}

export interface BuildRepositoryMapResult extends RepositoryMap {
  cacheKey: string;
}

export async function buildRepositoryMap(
  rootDir: string,
  headSha: string,
  cache?: RepositoryMapCache<BuildRepositoryMapResult>,
): Promise<BuildRepositoryMapResult> {
  const units = discoverUnits(rootDir);

  const allFiles: string[] = [];
  for (const unit of units) {
    allFiles.push(...listSourceFiles(unit.root));
  }

  const fileHashes: Record<string, string> = {};
  for (const file of allFiles) {
    const rel = relative(rootDir, file);
    fileHashes[rel] = hashFileContents(readFileSync(file));
  }

  const key = cacheKey({ repositorySha: headSha, fileHashes } satisfies CacheKeyInput);

  const cached = cache?.get(key);
  if (cached) {
    return cached;
  }

  const symbols: SymbolRecord[] = [];
  const importGraph: Edge[] = [];

  for (const file of allFiles) {
    const language = detectLanguage(file);
    if (!language) continue;
    const source = readFileSync(file, 'utf8');
    const fileSymbols = await extractSymbolsFromSource(file, source, language);
    symbols.push(...fileSymbols);
    const edges = await extractImportEdges(file, source, language);
    importGraph.push(...edges);
  }

  const unitDependencies: Edge[] = units.flatMap((unit) =>
    unit.dependsOn.map((to) => ({ from: unit.id, to })),
  );

  const result: BuildRepositoryMapResult = {
    units,
    symbols,
    unitDependencies,
    importGraph,
    cacheKey: key,
  };

  cache?.set(key, result);

  return result;
}
