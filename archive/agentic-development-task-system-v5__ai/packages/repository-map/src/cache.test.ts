import { describe, expect, it } from 'vitest';
import { cacheKey, InMemoryRepositoryMapCache } from './cache.js';

describe('cacheKey', () => {
  const baseInput = {
    repositorySha: 'abc123',
    fileHashes: { 'src/index.ts': 'hash1', 'src/other.ts': 'hash2' },
    toolVersion: '1.0.0',
    grammarVersions: { typescript: 'ts@1', python: 'py@1' },
  };

  it('produces the same key for identical inputs', () => {
    expect(cacheKey(baseInput)).toBe(cacheKey({ ...baseInput }));
  });

  it('produces the same key regardless of file hash map key order', () => {
    const reordered = {
      ...baseInput,
      fileHashes: { 'src/other.ts': 'hash2', 'src/index.ts': 'hash1' },
    };
    expect(cacheKey(baseInput)).toBe(cacheKey(reordered));
  });

  it('changes when repository sha changes', () => {
    expect(cacheKey(baseInput)).not.toBe(cacheKey({ ...baseInput, repositorySha: 'def456' }));
  });

  it('changes when a file hash changes', () => {
    const changed = { ...baseInput, fileHashes: { ...baseInput.fileHashes, 'src/index.ts': 'hash-changed' } };
    expect(cacheKey(baseInput)).not.toBe(cacheKey(changed));
  });

  it('changes when tool version changes', () => {
    expect(cacheKey(baseInput)).not.toBe(cacheKey({ ...baseInput, toolVersion: '2.0.0' }));
  });

  it('changes when grammar version changes', () => {
    const changed = { ...baseInput, grammarVersions: { ...baseInput.grammarVersions, typescript: 'ts@2' } };
    expect(cacheKey(baseInput)).not.toBe(cacheKey(changed));
  });
});

describe('InMemoryRepositoryMapCache', () => {
  it('returns undefined for a missing key', () => {
    const cache = new InMemoryRepositoryMapCache<string>();
    expect(cache.get('missing')).toBeUndefined();
  });

  it('round-trips a set value', () => {
    const cache = new InMemoryRepositoryMapCache<{ value: number }>();
    cache.set('key', { value: 42 });
    expect(cache.get('key')).toEqual({ value: 42 });
  });
});
