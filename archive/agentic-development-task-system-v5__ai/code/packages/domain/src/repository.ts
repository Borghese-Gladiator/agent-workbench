import { z } from 'zod';

export const RepositorySchema = z.object({
  id: z.string(),
  canonicalPath: z.string(),
  name: z.string(),
  remoteUrl: z.string().optional(),
  defaultBranch: z.string(),
  trusted: z.boolean(),
  /**
   * True when `canonicalPath` matches a configured enterprise repo root (see
   * `WorkbenchConfig.enterpriseRepoRoots`). Enterprise repos always have an established
   * frontend and internal tooling, so snapshot discovery skips checks that would be pointless
   * for them (e.g. command discovery, the `hasExistingFrontend` heuristic).
   */
  isEnterpriseRepo: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Repository = z.infer<typeof RepositorySchema>;

export const RepositoryUnitLanguageSchema = z.enum(['python', 'typescript', 'mixed', 'go', 'jvm']);
export type RepositoryUnitLanguage = z.infer<typeof RepositoryUnitLanguageSchema>;

export const RepositoryUnitKindSchema = z.enum([
  'application',
  'library',
  'web',
  'api',
  'cli',
  'worker',
  'package',
  'unknown',
]);
export type RepositoryUnitKind = z.infer<typeof RepositoryUnitKindSchema>;

export const RepositoryUnitSchema = z.object({
  id: z.string(),
  root: z.string(),
  language: RepositoryUnitLanguageSchema,
  kind: RepositoryUnitKindSchema,
  framework: z.string().optional(),
  packageManager: z.string().optional(),
  dependsOn: z.array(z.string()),
});
export type RepositoryUnit = z.infer<typeof RepositoryUnitSchema>;

export const CommandPurposeSchema = z.enum([
  'install',
  'format',
  'lint',
  'typecheck',
  'unit-test',
  'integration-test',
  'build',
  'start',
  'healthcheck',
  'custom',
]);
export type CommandPurpose = z.infer<typeof CommandPurposeSchema>;

export const CommandSourceSchema = z.enum([
  'repository-config',
  'ci',
  'package-script',
  'makefile',
  'task-runner',
  'inferred',
  'human',
]);
export type CommandSource = z.infer<typeof CommandSourceSchema>;

export const CommandStatusSchema = z.enum([
  'declared',
  'inferred',
  'validated',
  'failed',
  'obsolete',
  'ambiguous',
]);
export type CommandStatus = z.infer<typeof CommandStatusSchema>;

export const ValidatedCommandSchema = z.object({
  id: z.string(),
  repositoryId: z.string(),
  unitId: z.string().optional(),
  purpose: CommandPurposeSchema,
  command: z.string(),
  cwd: z.string(),
  source: CommandSourceSchema,
  status: CommandStatusSchema,
  validatedAtSha: z.string().optional(),
  lastExitCode: z.number().int().optional(),
});
export type ValidatedCommand = z.infer<typeof ValidatedCommandSchema>;

export const ServiceDefinitionSchema = z.object({
  id: z.string(),
  repositoryId: z.string(),
  unitId: z.string().optional(),
  name: z.string(),
  kind: z.enum(['http-api', 'web', 'worker', 'cli', 'other']),
  startCommandId: z.string().optional(),
  healthcheckCommandId: z.string().optional(),
  defaultPort: z.number().int().optional(),
});
export type ServiceDefinition = z.infer<typeof ServiceDefinitionSchema>;

export const QaSurfaceKindSchema = z.enum([
  'browser',
  'cli',
  'http-api',
  'library',
  'worker',
  'tui',
]);
export type QaSurfaceKind = z.infer<typeof QaSurfaceKindSchema>;

export const QaSurfaceSchema = z.object({
  id: z.string(),
  repositoryId: z.string(),
  unitId: z.string().optional(),
  kind: QaSurfaceKindSchema,
  entrypoint: z.string(),
  description: z.string().optional(),
});
export type QaSurface = z.infer<typeof QaSurfaceSchema>;

export const RepositoryFactKindSchema = z.enum([
  'architecture',
  'command',
  'testing',
  'convention',
  'invariant',
  'service',
  'risk',
  'pitfall',
  // Synthesized by the compile pass: a denser per-concept summary that clusters and
  // backlinks several atomic facts, preserving their union provenance. Not extracted from source.
  'concept',
]);
export type RepositoryFactKind = z.infer<typeof RepositoryFactKindSchema>;

export const RepositoryFactConfidenceSchema = z.enum(['declared', 'validated', 'inferred']);
export type RepositoryFactConfidence = z.infer<typeof RepositoryFactConfidenceSchema>;

export const RepositoryFactSchema = z.object({
  id: z.string(),
  repositoryId: z.string(),
  kind: RepositoryFactKindSchema,
  statement: z.string(),
  confidence: RepositoryFactConfidenceSchema,
  observedAtSha: z.string(),
  sourcePaths: z.array(z.string()),
  sourceHashes: z.array(z.string()),
  invalidatedByPaths: z.array(z.string()),
  supersededBy: z.string().optional(),
});
export type RepositoryFact = z.infer<typeof RepositoryFactSchema>;

export const RepositorySnapshotSchema = z.object({
  id: z.string(),
  repositoryId: z.string(),
  headSha: z.string(),
  createdAt: z.string(),
  units: z.array(RepositoryUnitSchema),
  commands: z.array(ValidatedCommandSchema),
  services: z.array(ServiceDefinitionSchema),
  qaSurfaces: z.array(QaSurfaceSchema),
  facts: z.array(RepositoryFactSchema),
  /**
   * Whether the repository already has an established frontend (a unit with `kind: 'web'`).
   * Computed once at snapshot time so the planner can decide, without re-scanning, whether a
   * from-scratch UI slice should be pointed at the `build-ui` skill.
   */
  hasExistingFrontend: z.boolean(),
  repositoryMapArtifactId: z.string().optional(),
});
export type RepositorySnapshot = z.infer<typeof RepositorySnapshotSchema>;
