import type { Command } from 'commander';
import { compileConcepts, lintMemory } from '@awb/repository-memory';
import { completeOnce } from '@awb/agent-gateway';
import { openWorkbenchDatabase } from '../db.js';
import { resolveRepoRef } from './repo.js';
import { emitJson, outputOptions, printInfo, printResult } from '../output.js';

/**
 * `awb memory` — on-demand knowledge-base maintenance over a repository's accumulated facts
 * (TASK-50, Karpathy KB workflow). `compile` densifies atomic facts into linked concept summaries;
 * `lint` reports contradictions/staleness. Both run a real single-turn model completion
 * (`completeOnce`) and operate directly on the workbench DB, mirroring `awb repo`'s data-access shape.
 */
export function registerMemoryCommands(program: Command): void {
  const memory = program.command('memory').description('Maintain a repository knowledge base (compile / lint)');

  memory
    .command('compile [repo]')
    .description('Synthesize atomic facts into denser, linked concept summaries (provenance preserved)')
    .action(async (repo: string | undefined) => {
      const repositoryId = await resolveRepoRef(repo);
      const { db, sqlite } = openWorkbenchDatabase();
      const result = await compileConcepts(db, sqlite, repositoryId, completeOnce);
      if (outputOptions().json) {
        emitJson(result);
        return;
      }
      printResult(`Compiled ${result.concepts.length} concept(s) from ${result.compactedFrom} fact(s).`);
      for (const c of result.concepts) {
        printInfo(`• ${c.statement}`);
      }
    });

  memory
    .command('lint [repo]')
    .description('Report contradictions, stale facts, and connection candidates (advisory, not applied)')
    .action(async (repo: string | undefined) => {
      const repositoryId = await resolveRepoRef(repo);
      const { db, sqlite } = openWorkbenchDatabase();
      const report = await lintMemory(db, sqlite, repositoryId, completeOnce);
      if (outputOptions().json) {
        emitJson(report);
        return;
      }
      printResult(
        `Lint: ${report.contradictions.length} contradiction(s), ${report.staleFactIds.length} stale, ` +
          `${report.connectionCandidates.length} connection candidate(s).`,
      );
      for (const c of report.contradictions) {
        printInfo(`⚠ contradiction ${c.factIds[0]} ↔ ${c.factIds[1]}: ${c.reason}`);
      }
    });
}
