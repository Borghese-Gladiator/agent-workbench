const LIKELY_SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, // GitHub tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, // Slack tokens
  /\bsk-[A-Za-z0-9]{20,}\b/, // OpenAI-style secret keys
  /\bpostgres(?:ql)?:\/\/[^\s'"]+:[^\s'"]+@/i, // DSN with embedded credentials
];

export interface PreUploadCheckInput {
  actualSha256: string;
  expectedSha256: string;
  byteSize: number;
  maxByteSize: number;
  textContentForSecretScan?: string;
  repositoryIsPublic: boolean;
}

export interface PreUploadCheckResult {
  hashVerified: boolean;
  withinSizeLimit: boolean;
  likelySecretsFound: string[];
  publicRepoWarning: boolean;
  safeToUpload: boolean;
}

/** Pre-upload checks from product spec §28: verify hash, check size, scan for likely secrets, warn for public repos. */
export function runPreUploadChecks(input: PreUploadCheckInput): PreUploadCheckResult {
  const hashVerified = input.actualSha256 === input.expectedSha256;
  const withinSizeLimit = input.byteSize <= input.maxByteSize;

  const likelySecretsFound: string[] = [];
  if (input.textContentForSecretScan) {
    for (const pattern of LIKELY_SECRET_PATTERNS) {
      if (pattern.test(input.textContentForSecretScan)) {
        likelySecretsFound.push(pattern.source);
      }
    }
  }

  const publicRepoWarning = input.repositoryIsPublic;
  const safeToUpload = hashVerified && withinSizeLimit && likelySecretsFound.length === 0;

  return { hashVerified, withinSizeLimit, likelySecretsFound, publicRepoWarning, safeToUpload };
}
