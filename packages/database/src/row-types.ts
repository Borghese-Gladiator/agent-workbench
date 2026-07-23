import type * as schema from './schema/index.js';

export type Repository = typeof schema.repositories.$inferSelect;
export type NewRepository = typeof schema.repositories.$inferInsert;

export type RepositorySnapshotRow = typeof schema.repositorySnapshots.$inferSelect;
export type NewRepositorySnapshotRow = typeof schema.repositorySnapshots.$inferInsert;

export type RepositoryUnitRow = typeof schema.repositoryUnits.$inferSelect;
export type NewRepositoryUnitRow = typeof schema.repositoryUnits.$inferInsert;

export type RepositoryCommandRow = typeof schema.repositoryCommands.$inferSelect;
export type NewRepositoryCommandRow = typeof schema.repositoryCommands.$inferInsert;

export type RepositoryServiceRow = typeof schema.repositoryServices.$inferSelect;
export type NewRepositoryServiceRow = typeof schema.repositoryServices.$inferInsert;

export type RepositoryQaSurfaceRow = typeof schema.repositoryQaSurfaces.$inferSelect;
export type NewRepositoryQaSurfaceRow = typeof schema.repositoryQaSurfaces.$inferInsert;

export type RepositoryFactRow = typeof schema.repositoryFacts.$inferSelect;
export type NewRepositoryFactRow = typeof schema.repositoryFacts.$inferInsert;

export type RepositoryFactSourceRow = typeof schema.repositoryFactSources.$inferSelect;
export type NewRepositoryFactSourceRow = typeof schema.repositoryFactSources.$inferInsert;

export type RepositorySymbolRow = typeof schema.repositorySymbols.$inferSelect;
export type NewRepositorySymbolRow = typeof schema.repositorySymbols.$inferInsert;

export type RepositoryDependencyRow = typeof schema.repositoryDependencies.$inferSelect;
export type NewRepositoryDependencyRow = typeof schema.repositoryDependencies.$inferInsert;

export type TaskRow = typeof schema.tasks.$inferSelect;
export type NewTaskRow = typeof schema.tasks.$inferInsert;

export type TaskContractRow = typeof schema.taskContracts.$inferSelect;
export type NewTaskContractRow = typeof schema.taskContracts.$inferInsert;

export type AcceptanceClaimRow = typeof schema.acceptanceClaims.$inferSelect;
export type NewAcceptanceClaimRow = typeof schema.acceptanceClaims.$inferInsert;

export type PlanRow = typeof schema.plans.$inferSelect;
export type NewPlanRow = typeof schema.plans.$inferInsert;

export type PlanSliceRow = typeof schema.planSlices.$inferSelect;
export type NewPlanSliceRow = typeof schema.planSlices.$inferInsert;

export type PlanClaimCoverageRow = typeof schema.planClaimCoverage.$inferSelect;
export type NewPlanClaimCoverageRow = typeof schema.planClaimCoverage.$inferInsert;

export type RunRow = typeof schema.runs.$inferSelect;
export type NewRunRow = typeof schema.runs.$inferInsert;

export type PhaseAttemptRow = typeof schema.phaseAttempts.$inferSelect;
export type NewPhaseAttemptRow = typeof schema.phaseAttempts.$inferInsert;

export type WorkspaceLeaseRow = typeof schema.workspaceLeases.$inferSelect;
export type NewWorkspaceLeaseRow = typeof schema.workspaceLeases.$inferInsert;

export type AgentSessionRow = typeof schema.agentSessions.$inferSelect;
export type NewAgentSessionRow = typeof schema.agentSessions.$inferInsert;

export type ModelInvocationRow = typeof schema.modelInvocations.$inferSelect;
export type NewModelInvocationRow = typeof schema.modelInvocations.$inferInsert;

export type ToolInvocationRow = typeof schema.toolInvocations.$inferSelect;
export type NewToolInvocationRow = typeof schema.toolInvocations.$inferInsert;

export type CommandExecutionRow = typeof schema.commandExecutions.$inferSelect;
export type NewCommandExecutionRow = typeof schema.commandExecutions.$inferInsert;

export type SemanticEventRow = typeof schema.semanticEvents.$inferSelect;
export type NewSemanticEventRow = typeof schema.semanticEvents.$inferInsert;

export type FindingRow = typeof schema.findings.$inferSelect;
export type NewFindingRow = typeof schema.findings.$inferInsert;

export type EvidenceRow = typeof schema.evidence.$inferSelect;
export type NewEvidenceRow = typeof schema.evidence.$inferInsert;

export type EvidenceClaimRow = typeof schema.evidenceClaims.$inferSelect;
export type NewEvidenceClaimRow = typeof schema.evidenceClaims.$inferInsert;

export type EvidenceDependencyRow = typeof schema.evidenceDependencies.$inferSelect;
export type NewEvidenceDependencyRow = typeof schema.evidenceDependencies.$inferInsert;

export type ArtifactRow = typeof schema.artifacts.$inferSelect;
export type NewArtifactRow = typeof schema.artifacts.$inferInsert;

export type HumanDecisionRow = typeof schema.humanDecisions.$inferSelect;
export type NewHumanDecisionRow = typeof schema.humanDecisions.$inferInsert;

export type WaiverRow = typeof schema.waivers.$inferSelect;
export type NewWaiverRow = typeof schema.waivers.$inferInsert;

export type PullRequestRow = typeof schema.pullRequests.$inferSelect;
export type NewPullRequestRow = typeof schema.pullRequests.$inferInsert;

export type PullRequestFeedbackRow = typeof schema.pullRequestFeedback.$inferSelect;
export type NewPullRequestFeedbackRow = typeof schema.pullRequestFeedback.$inferInsert;

export type MemoryEntryRow = typeof schema.memoryEntries.$inferSelect;
export type NewMemoryEntryRow = typeof schema.memoryEntries.$inferInsert;

export type MemorySourceRow = typeof schema.memorySources.$inferSelect;
export type NewMemorySourceRow = typeof schema.memorySources.$inferInsert;

export type FailureSignatureRow = typeof schema.failureSignatures.$inferSelect;
export type NewFailureSignatureRow = typeof schema.failureSignatures.$inferInsert;
