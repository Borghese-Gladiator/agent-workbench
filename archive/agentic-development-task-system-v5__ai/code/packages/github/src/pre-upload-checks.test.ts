import { describe, expect, it } from 'vitest';
import { runPreUploadChecks } from './pre-upload-checks.js';

const baseInput = {
  actualSha256: 'a'.repeat(64),
  expectedSha256: 'a'.repeat(64),
  byteSize: 1000,
  maxByteSize: 10_000,
  repositoryIsPublic: false,
};

describe('runPreUploadChecks', () => {
  it('is safe to upload when hash matches, size is within limit, and no secrets found', () => {
    const result = runPreUploadChecks(baseInput);
    expect(result.hashVerified).toBe(true);
    expect(result.withinSizeLimit).toBe(true);
    expect(result.likelySecretsFound).toEqual([]);
    expect(result.safeToUpload).toBe(true);
  });

  it('fails hash verification when the actual hash does not match expected', () => {
    const result = runPreUploadChecks({ ...baseInput, actualSha256: 'b'.repeat(64) });
    expect(result.hashVerified).toBe(false);
    expect(result.safeToUpload).toBe(false);
  });

  it('fails the size check when the file exceeds the max byte size', () => {
    const result = runPreUploadChecks({ ...baseInput, byteSize: 20_000 });
    expect(result.withinSizeLimit).toBe(false);
    expect(result.safeToUpload).toBe(false);
  });

  it('detects a likely AWS access key in scanned text content', () => {
    const result = runPreUploadChecks({
      ...baseInput,
      textContentForSecretScan: 'export AWS_KEY=AKIAABCDEFGHIJKLMNOP',
    });
    expect(result.likelySecretsFound.length).toBeGreaterThan(0);
    expect(result.safeToUpload).toBe(false);
  });

  it('detects a likely private key block in scanned text content', () => {
    const result = runPreUploadChecks({
      ...baseInput,
      textContentForSecretScan: '-----BEGIN RSA PRIVATE KEY-----\nMIIExyz\n-----END RSA PRIVATE KEY-----',
    });
    expect(result.likelySecretsFound.length).toBeGreaterThan(0);
  });

  it('detects a likely database DSN with embedded credentials', () => {
    const result = runPreUploadChecks({
      ...baseInput,
      textContentForSecretScan: 'DATABASE_URL=postgres://user:hunter2@db.internal:5432/app',
    });
    expect(result.likelySecretsFound.length).toBeGreaterThan(0);
  });

  it('does not flag ordinary log text as containing secrets', () => {
    const result = runPreUploadChecks({
      ...baseInput,
      textContentForSecretScan: 'Server started on port 3000\nGET /health 200 OK',
    });
    expect(result.likelySecretsFound).toEqual([]);
  });

  it('warns (but does not block) for a public repository', () => {
    const result = runPreUploadChecks({ ...baseInput, repositoryIsPublic: true });
    expect(result.publicRepoWarning).toBe(true);
    expect(result.safeToUpload).toBe(true);
  });
});
