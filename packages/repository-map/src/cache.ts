import { createHash } from 'node:crypto';

export const TOOL_VERSION = '0.1.0';

export const GRAMMAR_VERSIONS = {
  typescript: 'tree-sitter-typescript@0.20.5',
  tsx: 'tree-sitter-typescript@0.20.5',
  python: 'tree-sitter-python@0.21.0',
} as const;

export interface CacheKeyInput {
  repositorySha: string;
  fileHashes: Record<string, string>;
  toolVersion?: string;
  grammarVersions?: Record<string, string>;
}

function stableStringify(record: Record<string, string>): string {
  const keys = Object.keys(record).sort();
  return keys.map((key) => `${key}=${record[key]}`).join(',');
}

export function cacheKey(input: CacheKeyInput): string {
  const toolVersion = input.toolVersion ?? TOOL_VERSION;
  const grammarVersions = input.grammarVersions ?? GRAMMAR_VERSIONS;

  const parts = [
    `sha=${input.repositorySha}`,
    `files=${stableStringify(input.fileHashes)}`,
    `tool=${toolVersion}`,
    `grammars=${stableStringify(grammarVersions)}`,
  ].join('|');

  return createHash('sha256').update(parts).digest('hex');
}

export function hashFileContents(contents: Buffer | string): string {
  return createHash('sha256').update(contents).digest('hex');
}

export interface RepositoryMapCache<T = unknown> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
}

export class InMemoryRepositoryMapCache<T = unknown> implements RepositoryMapCache<T> {
  private readonly store = new Map<string, T>();

  get(key: string): T | undefined {
    return this.store.get(key);
  }

  set(key: string, value: T): void {
    this.store.set(key, value);
  }
}
