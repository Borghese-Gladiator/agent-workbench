import { createHash } from 'node:crypto';

export interface EnvironmentDigestInput {
  platform: string;
  nodeVersion: string;
  toolVersions?: Record<string, string>;
  env?: Record<string, string>;
}

function stableStringify(record: Record<string, string>): string {
  const keys = Object.keys(record).sort();
  return keys.map((key) => `${key}=${record[key]}`).join(',');
}

export function computeEnvironmentDigest(input: EnvironmentDigestInput): string {
  const toolVersions = input.toolVersions ?? {};
  const env = input.env ?? {};

  const parts = [
    `platform=${input.platform}`,
    `node=${input.nodeVersion}`,
    `tools=${stableStringify(toolVersions)}`,
    `env=${stableStringify(env)}`,
  ].join('|');

  return createHash('sha256').update(parts).digest('hex');
}
