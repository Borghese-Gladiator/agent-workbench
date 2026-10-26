import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { DrizzleDb } from '@awb/database';
import type { RepositoryFact, RepositoryFactKind } from '@awb/domain';
import { queryMemory } from './query.js';

/**
 * Projects a repository's project-memory facts to a small set of human/skill-readable markdown PAGES,
 * one per implementer-relevant theme (what will bite you / how to build / how it's built). This is a
 * one-way projection: SQLite (`repository_facts`) is the source of truth, the files are regenerated
 * wholesale each call. It exists so the next implementation can be informed by prior runs — a memory
 * skill points an agent at these pages, and a human can eyeball/diff them. See ADR-009 (md, not graph)
 * and docs/token-cost-measurement.md.
 */

/** Page = a titled group of fact kinds, ordered by what an implementer needs first. */
const PAGES: { file: string; title: string; kinds: RepositoryFactKind[] }[] = [
  { file: 'pitfalls.md', title: 'Pitfalls & risks', kinds: ['pitfall', 'risk'] },
  { file: 'rules.md', title: 'Invariants & conventions', kinds: ['invariant', 'convention'] },
  { file: 'commands.md', title: 'Build, test & run commands', kinds: ['command', 'testing'] },
  { file: 'architecture.md', title: 'Architecture & services', kinds: ['architecture', 'service', 'concept'] },
];

function renderFactLine(fact: RepositoryFact): string {
  const provenance = fact.sourcePaths.length > 0 ? ` _(${fact.sourcePaths.join(', ')})_` : '';
  return `- ${fact.statement} — \`${fact.confidence}\`${provenance}`;
}

function renderPage(title: string, live: RepositoryFact[], superseded: RepositoryFact[]): string {
  const lines = [`# ${title}`, ''];
  if (live.length === 0 && superseded.length === 0) {
    lines.push('_No facts recorded yet._', '');
  }
  for (const fact of live) lines.push(renderFactLine(fact));
  if (superseded.length > 0) {
    // Invariant #4 (ADR-009): superseded facts stay addressable rather than vanishing.
    lines.push('', '## Superseded', '');
    for (const fact of superseded) lines.push(renderFactLine(fact));
  }
  lines.push('');
  return lines.join('\n');
}

export interface ProjectFilesResult {
  dir: string;
  pagesWritten: string[];
}

/**
 * Regenerates the markdown projection for one repository under `dir` (default:
 * `repositoryMemoryDir(...)`, chosen by the caller). Includes superseded facts (marked) so nothing
 * silently disappears. Returns the directory and the page filenames written.
 */
export async function projectMemoryToFiles(
  db: DrizzleDb,
  sqlite: Database.Database,
  repositoryId: string,
  dir: string,
): Promise<ProjectFilesResult> {
  const all = await queryMemory(db, sqlite, repositoryId, { includeInvalidated: true });
  const live = all.filter((f) => f.supersededBy === undefined);
  const superseded = all.filter((f) => f.supersededBy !== undefined);

  mkdirSync(dir, { recursive: true });
  // Clear prior generated pages so a page that lost all its facts doesn't linger stale.
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.md')) rmSync(join(dir, name));
    }
  }

  const pagesWritten: string[] = [];
  const indexLines = ['# Project memory', '', `Repository \`${repositoryId}\`. Generated from repository_facts — do not edit (regenerated each run).`, ''];

  for (const page of PAGES) {
    const inPage = (f: RepositoryFact) => page.kinds.includes(f.kind);
    const pageLive = live.filter(inPage);
    const pageSuperseded = superseded.filter(inPage);
    if (pageLive.length === 0 && pageSuperseded.length === 0) continue;
    writeFileSync(join(dir, page.file), renderPage(page.title, pageLive, pageSuperseded), 'utf8');
    pagesWritten.push(page.file);
    indexLines.push(`- [${page.title}](./${page.file}) — ${pageLive.length} fact(s)`);
  }

  indexLines.push('');
  writeFileSync(join(dir, 'README.md'), indexLines.join('\n'), 'utf8');
  pagesWritten.push('README.md');

  return { dir, pagesWritten };
}
