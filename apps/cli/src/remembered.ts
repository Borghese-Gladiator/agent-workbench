import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveLayout } from '@awb/config';

interface RememberedIds {
  repositoryId?: string;
  taskId?: string;
}

function rememberedFilePath(): string {
  const layout = resolveLayout();
  mkdirSync(layout.runtimeDir, { recursive: true });
  return join(layout.runtimeDir, 'last-ids.json');
}

function read(): RememberedIds {
  const path = rememberedFilePath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RememberedIds;
  } catch {
    return {};
  }
}

function write(next: RememberedIds): void {
  writeFileSync(rememberedFilePath(), JSON.stringify(next, null, 2), 'utf8');
}

export function rememberRepositoryId(repositoryId: string): void {
  write({ ...read(), repositoryId });
}

export function rememberTaskId(taskId: string): void {
  write({ ...read(), taskId });
}

export function resolveRepositoryId(explicit: string | undefined): string {
  const id = explicit ?? read().repositoryId;
  if (!id) {
    throw new Error('No repository id given and none remembered. Pass one explicitly or run `awb repo add` first.');
  }
  return id;
}

export function resolveTaskId(explicit: string | undefined): string {
  const id = explicit ?? read().taskId;
  if (!id) {
    throw new Error('No task id given and none remembered. Pass one explicitly or run `awb task create` first.');
  }
  return id;
}
