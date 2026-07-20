import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRunInput, AgentRuntimeAdapter, StreamHandlers } from '@workbench/agents';
import { Store } from '@workbench/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LifecycleService } from './service.js';

/**
 * End-to-end injection: a streaming run must route the repo profile to the
 * right skills and hand them to the adapter as `skillText`. We capture the
 * AgentRunInput the adapter receives and assert on its skillText.
 */

let store: Store;
let artifactsDir: string;
let repoDir: string;
let captured: AgentRunInput | undefined;

/** Adapter that records the input it was streamed, then succeeds immediately. */
function capturingAdapter(): AgentRuntimeAdapter {
  return {
    async runStageAgent() {
      throw new Error('streaming path expected');
    },
    async streamStageAgent(input: AgentRunInput, _handlers: StreamHandlers) {
      captured = input;
      return {
        status: 'succeeded' as const,
        transcript: { kind: 'log' as const, title: 't', body: 'b' },
        produced: [],
      };
    },
  };
}

/** Wait until the background streaming run has called the adapter. */
async function waitForCapture(): Promise<AgentRunInput> {
  for (let i = 0; i < 50 && !captured; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  if (!captured) throw new Error('adapter was never invoked');
  return captured;
}

beforeEach(() => {
  artifactsDir = mkdtempSync(join(tmpdir(), 'wb-skillinj-'));
  store = new Store({ dbPath: ':memory:', artifactsDir });
  // A repo the router fingerprints as ts-shadcn-frontend.
  repoDir = mkdtempSync(join(tmpdir(), 'wb-skillinj-repo-'));
  writeFileSync(join(repoDir, 'components.json'), '{}');
  captured = undefined;
});
afterEach(() => {
  store.close();
  rmSync(artifactsDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

function service(): LifecycleService {
  return new LifecycleService(store, undefined, undefined, () => capturingAdapter());
}

function seedTask(repoPath: string = repoDir): string {
  const project = store.createProject({
    name: 'P',
    repoPath,
    defaultBranch: 'main',
    agentRuntime: 'claude',
  });
  const task = store.createTask({ projectId: project.id, title: 'T', rawRequest: 'do it' });
  return task.id;
}

describe('agent_self_review injection', () => {
  it('injects the frontend review + always-on adversarial, with subagent dispatch', async () => {
    const svc = service();
    svc.startBackgroundRun(seedTask(), 'agent_self_review');
    const input = await waitForCapture();

    expect(input.skillText).toBeDefined();
    // Profile skill (frontend) + always-on adversarial both present.
    expect(input.skillText).toContain('### review-ts-shadcn-frontend');
    expect(input.skillText).toContain('getByRole');
    expect(input.skillText).toContain('### review-adversarial');
    // Subagent-dispatch instruction (keeps reviewer context isolated).
    expect(input.skillText).toMatch(/subagent/i);
  });
});

describe('implementation README injection', () => {
  it('appends write-readme at implementation when the repo started EMPTY', async () => {
    // An empty checkout (no source content) — `isEmptyRepo` is true, so the README
    // skill is appended as the LAST instruction of the implementation prompt.
    const emptyRepo = mkdtempSync(join(tmpdir(), 'wb-skillinj-empty-'));
    try {
      const svc = service();
      svc.startBackgroundRun(seedTask(emptyRepo), 'implementation');
      const input = await waitForCapture();

      expect(input.skillText).toBeDefined();
      expect(input.skillText).toContain('README Writer');
      // The skill's output-contract proof fields are present in the injected body.
      expect(input.skillText).toContain('buildCommands');
      expect(input.skillText).toContain('devCommands');
      expect(input.skillText).toContain('prodCommands');
    } finally {
      rmSync(emptyRepo, { recursive: true, force: true });
    }
  });

  it('does NOT inject write-readme when the repo already has code (not empty)', async () => {
    // The default repo has `components.json` — real content — so it is NOT empty and
    // the README step never runs, even though it has no README. No guessing.
    const svc = service();
    svc.startBackgroundRun(seedTask(), 'implementation');
    const input = await waitForCapture();

    // No README skill body. (No profile write skill for ts-shadcn-frontend either,
    // so there is no skillText at all for this stage.)
    expect(input.skillText ?? '').not.toContain('README Writer');
  });
});

describe('feature_e2e injection', () => {
  it('no longer rejects the stage and injects the QA skills', async () => {
    const svc = service();
    // Must not throw "agent does not support stage".
    expect(() => svc.startBackgroundRun(seedTask(), 'feature_e2e')).not.toThrow();
    const input = await waitForCapture();

    expect(input.skillText).toContain('### qa-e2e-playwright');
    expect(input.skillText).toContain('### qa-artifacts');
  });
});
