/**
 * Project memory loop:
 * - closeout distills a completed task's durable artifacts into the project's
 *   memory log (mock runtime → deterministic stub; no agent call).
 * - a NEW task's discovery prompt for that project carries the memory section.
 * - a summarizer failure must NOT fail closeout.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRunInput, AgentRuntimeAdapter } from '@workbench/agents';
import { Store } from '@workbench/store';
import { StubWorktreeProvider } from '@workbench/worktree';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LifecycleService } from './service.js';

let store: Store;
let dir: string;
let memDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-pm-art-'));
  memDir = mkdtempSync(join(tmpdir(), 'wb-pm-mem-'));
  store = new Store({ dbPath: ':memory:', artifactsDir: dir, projectMemoryDir: memDir });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(memDir, { recursive: true, force: true });
});

/** Let the detached, best-effort memory append (a microtask) settle. */
const tick = () => new Promise<void>((r) => setImmediate(r));

const wtDir = () => join(tmpdir(), 'wb-pm-wt');

/** A mock-runtime project + a task parked at `publish` with durable artifacts. */
function readyToCloseout(opts?: { withArtifacts?: boolean }) {
  const project = store.createProject({
    name: 'P',
    repoPath: '/tmp/repo',
    defaultBranch: 'main',
    agentRuntime: 'mock',
  });
  const task = store.createTask({
    projectId: project.id,
    title: 'Add audience export',
    rawRequest: 'x',
  });
  if (opts?.withArtifacts ?? true) {
    store.createArtifact({
      taskId: task.id,
      kind: 'execution_plan',
      title: 'Plan',
      body: '## Plan\n- add ExportJob to jobs/ — because it mirrors the existing ImportJob pattern',
    });
    store.createArtifact({
      taskId: task.id,
      kind: 'delivery_package',
      title: 'PR',
      body: '## Summary\n- ships the export endpoint',
    });
  }
  store.applyTransition(task.id, { stage: 'publish', status: 'active' });
  return { project, task };
}

describe('project memory — write at closeout', () => {
  it('appends an entry to the project memory log on closeout (mock runtime)', async () => {
    const { project, task } = readyToCloseout();
    const svc = new LifecycleService(store, new StubWorktreeProvider(), wtDir());

    expect(store.readProjectMemory(project.id)).toBe('');
    svc.closeout(task.id);
    await tick();

    const mem = store.readProjectMemory(project.id);
    expect(mem).toContain('# Project memory');
    expect(mem).toContain('Add audience export');
    // The mock stub records which durable sources existed.
    expect(mem).toContain('Execution Plan');
    expect(mem).toContain('Delivery Package');
  });

  it('writes nothing when the task has no durable artifacts', async () => {
    const { project, task } = readyToCloseout({ withArtifacts: false });
    new LifecycleService(store, new StubWorktreeProvider(), wtDir()).closeout(task.id);
    await tick();
    expect(store.readProjectMemory(project.id)).toBe('');
  });

  it('closeout still completes (task done) even if the memory append throws', async () => {
    const { task } = readyToCloseout();
    const svc = new LifecycleService(store, new StubWorktreeProvider(), wtDir());
    store.appendProjectMemory = () => {
      throw new Error('disk full');
    };
    const done = svc.closeout(task.id);
    expect(done.status).toBe('done');
    expect(done.stage).toBe('closeout');
    await tick(); // the rejection is swallowed by the .catch — nothing escapes
  });
});

describe('project memory — read at discovery', () => {
  it("a new task's discovery prompt for the project includes the memory entry", async () => {
    // Seed the project's memory directly (the write path is covered above).
    const project = store.createProject({
      name: 'P',
      repoPath: '/tmp/repo',
      defaultBranch: 'main',
      agentRuntime: 'claude', // discovery runs a real adapter only on claude
    });
    store.appendProjectMemory(
      project.id,
      '## 2026-06-01 — Add audience export\n- add ExportJob to jobs/ — because it mirrors ImportJob',
    );

    const task = store.createTask({ projectId: project.id, title: 'Second task', rawRequest: 'y' });
    store.applyTransition(task.id, { stage: 'discovery', status: 'active' });

    let captured: AgentRunInput | undefined;
    const capturing: AgentRuntimeAdapter = {
      async runStageAgent(input) {
        captured = input;
        return {
          status: 'succeeded',
          transcript: { kind: 'log', title: 'log', body: 'ran' },
          produced: [{ kind: 'discovery', title: 'Discovery', body: 'found things' }],
        };
      },
    };
    const svc = new LifecycleService(store, new StubWorktreeProvider(), wtDir(), () => capturing);
    await svc.createDiscovery(task.id);

    expect(captured?.projectMemory).toBeDefined();
    expect(captured?.projectMemory).toContain('add ExportJob to jobs/');
  });
});
