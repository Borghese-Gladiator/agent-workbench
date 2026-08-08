import type { Command } from 'commander';
import { compileConcepts, lintMemory, projectMemoryToFiles } from '@awb/repository-memory';
import { completeOnce } from '@awb/agent-gateway';
import { initDataDir, repositoryMemoryDir } from '@awb/config';
import { openWorkbenchDatabase } from '../db.js';
import { resolveRepoRef } from './repo.js';
import { emitJson, outputOptions, printInfo, printResult } from '../output.js';

/**
 * `awb memory` — on-demand knowledge-base maintenance over a repository's accumulated facts
 * (TASK-50, Karpathy KB workflow). `compile` densifies atomic facts into linked concept summaries;
 * `lint` reports contradictions/staleness; `sync` regenerates the markdown file projection. All
 * operate directly on the workbench DB, mirroring `awb repo`'s data-access shape.
 */
export function registerMemoryCommands(program: Command): void {
  const memory = program.command('memory').description('Maintain a repository knowledge base (compile / lint / sync)');

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
      // Keep the file projection in step with the store after compiling.
      const files = await syncMemoryFiles(repositoryId);
      const skippedNote = result.skipped > 0 ? ` (${result.skipped} cluster(s) skipped on failure)` : '';
      printResult(
        `Compiled ${result.concepts.length} concept(s) from ${result.compactedFrom} fact(s)${skippedNote}.`,
      );
      for (const c of result.concepts) {
        printInfo(`• ${c.statement}`);
      }
      printInfo(`Projected ${files.pagesWritten.length} page(s) to ${files.dir}`);
    });

  memory
    .command('sync [repo]')
    .description('Regenerate the markdown file projection of project memory from the store')
    .action(async (repo: string | undefined) => {
      const repositoryId = await resolveRepoRef(repo);
      const files = await syncMemoryFiles(repositoryId);
      if (outputOptions().json) {
        emitJson(files);
        return;
      }
      printResult(`Wrote ${files.pagesWritten.length} page(s) to ${files.dir}`);
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

/** Regenerates the per-repo markdown projection under the data dir; shared by `compile` and `sync`. */
async function syncMemoryFiles(repositoryId: string) {
  const { db, sqlite } = openWorkbenchDatabase();
  const { layout } = initDataDir();
  return projectMemoryToFiles(db, sqlite, repositoryId, repositoryMemoryDir(layout, repositoryId));
}
