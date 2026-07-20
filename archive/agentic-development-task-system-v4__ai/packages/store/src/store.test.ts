import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExternalToolConfig } from '@workbench/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from './store.js';

let store: Store;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-store-'));
  store = new Store({ dbPath: ':memory:', artifactsDir: dir });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Store', () => {
  it('creates a task in intake with an open stage run', () => {
    const project = store.createProject({
      name: 'Demo',
      repoPath: '/tmp/repo',
      defaultBranch: 'main',
    });
    const task = store.createTask({
      projectId: project.id,
      title: 'Add a button',
      rawRequest: 'we need a button',
    });
    expect(task.stage).toBe('intake');
    expect(task.status).toBe('active');
    const run = store.currentStageRun(task.id);
    expect(run?.stage).toBe('intake');
    expect(run?.status).toBe('in_progress');
  });

  it('setTaskTitle renames the task', () => {
    const project = store.createProject({
      name: 'Demo',
      repoPath: '/tmp/repo',
      defaultBranch: 'main',
    });
    const task = store.createTask({
      projectId: project.id,
      title: 'Linear Ticket',
      rawRequest: 'r',
    });
    store.setTaskTitle(task.id, 'Add CSV export to campaigns report');
    expect(store.getTask(task.id)?.title).toBe('Add CSV export to campaigns report');
  });

  it('applyTransition closes prior run and opens a new one', () => {
    const project = store.createProject({
      name: 'Demo',
      repoPath: '/tmp/repo',
      defaultBranch: 'main',
    });
    const task = store.createTask({ projectId: project.id, title: 't', rawRequest: 'r' });
    store.applyTransition(task.id, { stage: 'human_brief_approval', status: 'active' });
    const runs = store.listStageRuns(task.id);
    expect(runs).toHaveLength(2);
    expect(runs[0]!.stage).toBe('intake');
    expect(runs[0]!.status).toBe('completed');
    expect(runs[1]!.stage).toBe('human_brief_approval');
    expect(runs[1]!.status).toBe('in_progress');
  });

  it('stageRunForStage resolves the open run for the current stage', () => {
    const project = store.createProject({
      name: 'Demo',
      repoPath: '/tmp/repo',
      defaultBranch: 'main',
    });
    const task = store.createTask({ projectId: project.id, title: 't', rawRequest: 'r' });
    const run = store.stageRunForStage(task.id, 'intake');
    expect(run?.id).toBe(store.currentStageRun(task.id)?.id);
    expect(run?.stage).toBe('intake');
    expect(run?.status).toBe('in_progress');
  });

  it('stageRunForStage resolves a non-current stage after a transition', () => {
    const project = store.createProject({
      name: 'Demo',
      repoPath: '/tmp/repo',
      defaultBranch: 'main',
    });
    const task = store.createTask({ projectId: project.id, title: 't', rawRequest: 'r' });
    // Move past intake; intake's run is now completed and no longer "current".
    store.applyTransition(task.id, { stage: 'human_brief_approval', status: 'active' });

    const intakeRun = store.stageRunForStage(task.id, 'intake');
    expect(intakeRun?.stage).toBe('intake');
    expect(intakeRun?.status).toBe('completed');
    // Proves it does NOT just echo currentStageRun (which is now the new stage).
    expect(intakeRun?.id).not.toBe(store.currentStageRun(task.id)?.id);
  });

  it('stageRunForStage returns null for a stage never entered', () => {
    const project = store.createProject({
      name: 'Demo',
      repoPath: '/tmp/repo',
      defaultBranch: 'main',
    });
    const task = store.createTask({ projectId: project.id, title: 't', rawRequest: 'r' });
    expect(store.stageRunForStage(task.id, 'discovery')).toBeNull();
  });

  it('stores artifact body on disk and reads it back', () => {
    const project = store.createProject({
      name: 'Demo',
      repoPath: '/tmp/repo',
      defaultBranch: 'main',
    });
    const task = store.createTask({ projectId: project.id, title: 't', rawRequest: 'r' });
    const art = store.createArtifact({
      taskId: task.id,
      kind: 'task_brief',
      title: 'Brief',
      body: '# hello',
    });
    expect(art.byteSize).toBe(7);
    expect(store.readArtifactBody(art.id)).toBe('# hello');
    // artifact is attached to the open (intake) stage run
    expect(art.stageRunId).toBe(store.currentStageRun(task.id)?.id);
  });

  it('copies a demo proof asset into durable storage under the task', () => {
    const project = store.createProject({ name: 'D', repoPath: '/tmp/r', defaultBranch: 'main' });
    const task = store.createTask({ projectId: project.id, title: 't', rawRequest: 'r' });
    // A throwaway "video" file standing in for a Playwright artifact.
    const src = join(dir, 'video.webm');
    writeFileSync(src, 'FAKE_VIDEO');

    const rel = store.copyDemoAsset(task.id, src);

    expect(rel).toBe(join(task.id, 'demo-assets', 'video.webm'));
    expect(readFileSync(join(dir, rel), 'utf8')).toBe('FAKE_VIDEO');
  });

  it('de-dupes colliding demo-asset filenames so every scenario video is kept', () => {
    const project = store.createProject({ name: 'D', repoPath: '/tmp/r', defaultBranch: 'main' });
    const task = store.createTask({ projectId: project.id, title: 't', rawRequest: 'r' });
    // Playwright names every scenario's video `video.webm`; copying three must not
    // overwrite — each lands under a distinct stored name.
    const rels: string[] = [];
    for (const tag of ['a', 'b', 'c']) {
      const src = join(dir, `src-${tag}.webm`);
      writeFileSync(src, `VIDEO_${tag}`);
      // Rename so basename collides (simulates three `video.webm` sources).
      const collide = join(dir, 'video.webm');
      writeFileSync(collide, `VIDEO_${tag}`);
      rels.push(store.copyDemoAsset(task.id, collide));
    }
    expect(new Set(rels).size).toBe(3); // three distinct stored paths
    expect(rels[0]).toBe(join(task.id, 'demo-assets', 'video.webm'));
    expect(rels[1]).toBe(join(task.id, 'demo-assets', 'video-1.webm'));
    expect(rels[2]).toBe(join(task.id, 'demo-assets', 'video-2.webm'));
  });

  it('lists copied demo assets and resolves a safe path; rejects traversal', () => {
    const project = store.createProject({ name: 'D', repoPath: '/tmp/r', defaultBranch: 'main' });
    const task = store.createTask({ projectId: project.id, title: 't', rawRequest: 'r' });
    for (const name of ['video.webm', 'shot.png', 'trace.zip']) {
      const src = join(dir, name);
      writeFileSync(src, `DATA_${name}`);
      store.copyDemoAsset(task.id, src);
    }

    expect(store.listDemoAssets(task.id)).toEqual(['shot.png', 'trace.zip', 'video.webm']);

    const abs = store.demoAssetPath(task.id, 'shot.png');
    expect(abs).not.toBeNull();
    expect(readFileSync(abs!, 'utf8')).toBe('DATA_shot.png');

    // Missing file and traversal/absolute names all resolve to null.
    expect(store.demoAssetPath(task.id, 'nope.png')).toBeNull();
    expect(store.demoAssetPath(task.id, '../../etc/passwd')).toBeNull();
    expect(store.demoAssetPath(task.id, 'sub/shot.png')).toBeNull();
  });

  it('lists no demo assets for a task that captured none', () => {
    const project = store.createProject({ name: 'D', repoPath: '/tmp/r', defaultBranch: 'main' });
    const task = store.createTask({ projectId: project.id, title: 't', rawRequest: 'r' });
    expect(store.listDemoAssets(task.id)).toEqual([]);
  });

  it('tracks worktree status and the active worktree', () => {
    const project = store.createProject({
      name: 'Demo',
      repoPath: '/tmp/repo',
      defaultBranch: 'main',
    });
    const task = store.createTask({ projectId: project.id, title: 't', rawRequest: 'r' });

    const wt = store.createWorktree({
      taskId: task.id,
      worktreePath: '/data/worktrees/demo/t',
      branch: 'wb/t-x',
      baseBranch: 'main',
      status: 'created',
    });
    expect(wt.baseBranch).toBe('main');
    expect(store.getActiveWorktree(task.id)?.id).toBe(wt.id);

    // Abandoning it removes it from the active set but keeps the row.
    store.updateWorktreeStatus(wt.id, 'abandoned');
    expect(store.getActiveWorktree(task.id)).toBeNull();
    expect(store.getWorktreeById(wt.id)?.status).toBe('abandoned');
    expect(store.getWorktree(task.id)?.id).toBe(wt.id);
  });

  it('records approvals and delivery packages', () => {
    const project = store.createProject({
      name: 'Demo',
      repoPath: '/tmp/repo',
      defaultBranch: 'main',
    });
    const task = store.createTask({ projectId: project.id, title: 't', rawRequest: 'r' });
    store.recordApproval({ taskId: task.id, gate: 'task_brief', decision: 'approved' });
    expect(store.listApprovals(task.id)).toHaveLength(1);

    const del = store.createDeliveryPackage({
      taskId: task.id,
      artifactId: null,
      target: 'PR to main',
      status: 'prepared',
    });
    expect(store.getDeliveryPackage(task.id)?.id).toBe(del.id);
  });
});

describe('Store — transition atomicity & optimistic locking', () => {
  function newTask() {
    const project = store.createProject({
      name: 'Demo',
      repoPath: '/tmp/repo',
      defaultBranch: 'main',
    });
    return store.createTask({ projectId: project.id, title: 't', rawRequest: 'r' });
  }

  it('a new task starts at rev 0 and each transition bumps rev', () => {
    const task = newTask();
    expect(task.rev).toBe(0);
    const t1 = store.applyTransition(task.id, { stage: 'human_brief_approval', status: 'active' });
    expect(t1.rev).toBe(1);
    const t2 = store.applyTransition(task.id, { stage: 'discovery', status: 'active' });
    expect(t2.rev).toBe(2);
  });

  it('rejects a stale write (one that read an older rev) with StaleWriteError', async () => {
    const { StaleWriteError } = await import('./store.js');
    const task = newTask();
    // Two callers both read rev 0; the first transition wins and bumps to rev 1.
    store.applyTransition(task.id, { stage: 'human_brief_approval', status: 'active' });
    // A second caller still holding the rev-0 snapshot must lose. We simulate it
    // by stubbing getTask to return the stale (rev 0) row for the next call.
    const stale = { ...task, rev: 0 };
    const spy = vi.spyOn(store, 'getTask').mockReturnValueOnce(stale);
    expect(() =>
      store.applyTransition(task.id, { stage: 'discovery', status: 'active' }),
    ).toThrow(StaleWriteError);
    spy.mockRestore();
    // The winner's state is intact — the loser clobbered nothing.
    expect(store.getTask(task.id)?.stage).toBe('human_brief_approval');
  });

  it('rolls back the stage-run writes when the guarded task UPDATE loses', async () => {
    const task = newTask();
    store.applyTransition(task.id, { stage: 'human_brief_approval', status: 'active' });
    const runsBefore = store.listStageRuns(task.id);
    const stale = { ...task, rev: 0 };
    const spy = vi.spyOn(store, 'getTask').mockReturnValueOnce(stale);
    try {
      store.applyTransition(task.id, { stage: 'discovery', status: 'active' });
    } catch {
      /* expected StaleWriteError */
    }
    spy.mockRestore();
    // No half-applied stage run: the failed transition left the timeline untouched.
    const runsAfter = store.listStageRuns(task.id);
    expect(runsAfter).toHaveLength(runsBefore.length);
    expect(store.currentStageRun(task.id)?.stage).toBe('human_brief_approval');
  });

  it('worktree mutations also advance rev (no counter reset)', () => {
    const task = newTask();
    store.setWorktreeOnTask(task.id, 'wt_1');
    expect(store.getTask(task.id)?.rev).toBe(1);
    store.setWorktreeModeOnTask(task.id, 'direct');
    expect(store.getTask(task.id)?.rev).toBe(2);
  });
});

describe('Store — agent runs, events, questions', () => {
  function newTask() {
    const project = store.createProject({
      name: 'Demo',
      repoPath: '/tmp/repo',
      defaultBranch: 'main',
    });
    return store.createTask({ projectId: project.id, title: 't', rawRequest: 'r' });
  }

  it('creates a running agent run and updates it to terminal', () => {
    const task = newTask();
    const run = store.createAgentRun({ taskId: task.id, stage: 'discovery' });
    expect(run.status).toBe('running');
    expect(store.listAgentRuns(task.id)).toHaveLength(1);

    store.updateAgentRun(run.id, {
      status: 'succeeded',
      finishedAt: new Date().toISOString(),
      totalCostUsd: 0.02,
      numTurns: 3,
    });
    const got = store.getAgentRun(run.id)!;
    expect(got.status).toBe('succeeded');
    expect(got.totalCostUsd).toBe(0.02);
    expect(got.numTurns).toBe(3);
  });

  it('round-trips the per-run token breakdown (null until set)', () => {
    const task = newTask();
    const run = store.createAgentRun({ taskId: task.id, stage: 'implementation' });
    // Fresh run: token fields default to null.
    const fresh = store.getAgentRun(run.id)!;
    expect(fresh.inputTokens).toBeNull();
    expect(fresh.cacheReadInputTokens).toBeNull();

    store.updateAgentRun(run.id, {
      status: 'succeeded',
      inputTokens: 22000,
      outputTokens: 4000,
      cacheCreationInputTokens: 1500,
      cacheReadInputTokens: 310000,
    });
    const got = store.getAgentRun(run.id)!;
    expect(got.inputTokens).toBe(22000);
    expect(got.outputTokens).toBe(4000);
    expect(got.cacheCreationInputTokens).toBe(1500);
    expect(got.cacheReadInputTokens).toBe(310000);
  });

  it('round-trips the run-level latency fields (null until set)', () => {
    const task = newTask();
    const run = store.createAgentRun({ taskId: task.id, stage: 'implementation' });
    const fresh = store.getAgentRun(run.id)!;
    expect(fresh.durationApiMs).toBeNull();
    expect(fresh.ttftMs).toBeNull();

    store.updateAgentRun(run.id, { status: 'succeeded', durationApiMs: 42_000, ttftMs: 5_500 });
    const got = store.getAgentRun(run.id)!;
    expect(got.durationApiMs).toBe(42_000);
    expect(got.ttftMs).toBe(5_500);
  });

  it('round-trips a session id and surfaces the latest succeeded one for a stage', () => {
    const task = newTask();
    const run = store.createAgentRun({ taskId: task.id, stage: 'task_brief' });
    expect(run.sessionId).toBeNull();

    store.updateAgentRun(run.id, { status: 'succeeded', sessionId: 'sess_1' });
    expect(store.getAgentRun(run.id)!.sessionId).toBe('sess_1');
    expect(store.latestSessionForStage(task.id, 'task_brief')).toBe('sess_1');

    // A newer succeeded run for the same stage wins.
    const run2 = store.createAgentRun({ taskId: task.id, stage: 'task_brief' });
    store.updateAgentRun(run2.id, { status: 'succeeded', sessionId: 'sess_2' });
    expect(store.latestSessionForStage(task.id, 'task_brief')).toBe('sess_2');

    // No session for a different stage.
    expect(store.latestSessionForStage(task.id, 'discovery')).toBeNull();
  });

  it('appends events with monotonic seq and replays after a given seq', () => {
    const task = newTask();
    const run = store.createAgentRun({ taskId: task.id, stage: 'discovery' });
    const e1 = store.appendAgentRunEvent({
      runId: run.id,
      type: 'assistant_text',
      payload: { text: 'hi' },
    });
    const e2 = store.appendAgentRunEvent({
      runId: run.id,
      type: 'tool_call',
      payload: { name: 'Read' },
    });
    expect([e1.seq, e2.seq]).toEqual([1, 2]);

    const all = store.listAgentRunEvents(run.id);
    expect(all.map((e) => e.type)).toEqual(['assistant_text', 'tool_call']);
    expect(all[0]!.payload).toEqual({ text: 'hi' });

    // Last-Event-ID replay: only events after seq 1.
    const tail = store.listAgentRunEvents(run.id, 1);
    expect(tail).toHaveLength(1);
    expect(tail[0]!.seq).toBe(2);
  });

  it('round-trips receivedAt, defaulting it to insert time when omitted', () => {
    const task = newTask();
    const run = store.createAgentRun({ taskId: task.id, stage: 'discovery' });
    // Explicit receivedAt (the daemon stamps parse time).
    const stamped = '2026-06-23T00:00:00.000Z';
    const withStamp = store.appendAgentRunEvent({
      runId: run.id,
      type: 'turn',
      payload: { index: 1, ttftMs: 50_000 },
      receivedAt: stamped,
    });
    expect(withStamp.receivedAt).toBe(stamped);
    // Omitted → defaults to a non-null value (≈ createdAt) so it is never null on
    // a fresh write — divergence from createdAt is the persist-delay signal.
    const defaulted = store.appendAgentRunEvent({
      runId: run.id,
      type: 'assistant_text',
      payload: { text: 'hi' },
    });
    expect(defaulted.receivedAt).not.toBeNull();

    const [a, b] = store.listAgentRunEvents(run.id);
    expect(a!.receivedAt).toBe(stamped);
    expect(b!.receivedAt).not.toBeNull();
  });

  it('spills an oversized event payload to the file store and reads it back', () => {
    const task = newTask();
    const run = store.createAgentRun({ taskId: task.id, stage: 'discovery' });
    const big = 'x'.repeat(20 * 1024);
    store.appendAgentRunEvent({ runId: run.id, type: 'tool_result', payload: { summary: big } });
    const [evt] = store.listAgentRunEvents(run.id);
    expect((evt!.payload as { summary: string }).summary).toHaveLength(20 * 1024);
  });

  it('markInterruptedRuns marks non-terminal runs interrupted and returns them', () => {
    const task = newTask();
    const a = store.createAgentRun({ taskId: task.id, stage: 'discovery' });
    const b = store.createAgentRun({ taskId: task.id, stage: 'implementation' });
    store.updateAgentRun(b.id, { status: 'succeeded' });

    const interrupted = store.markInterruptedRuns();
    expect(interrupted.map((r) => r.id)).toEqual([a.id]);
    expect(store.getAgentRun(a.id)!.status).toBe('interrupted');
    expect(store.getAgentRun(b.id)!.status).toBe('succeeded');
    // A terminal error event is appended so an attached SSE client stops replaying.
    const lastEvent = store.listAgentRunEvents(a.id).at(-1);
    expect(lastEvent!.type).toBe('error');
  });

  it('markInterruptedRuns sweeps awaiting_input runs too', () => {
    const task = newTask();
    const a = store.createAgentRun({ taskId: task.id, stage: 'implementation' });
    store.updateAgentRun(a.id, { status: 'awaiting_input' });
    const interrupted = store.markInterruptedRuns();
    expect(interrupted.map((r) => r.id)).toEqual([a.id]);
    expect(store.getAgentRun(a.id)!.status).toBe('interrupted');
  });

  it('records a question, lists it as unanswered, then records an answer', () => {
    const task = newTask();
    const run = store.createAgentRun({ taskId: task.id, stage: 'discovery' });
    const q = store.createAgentQuestion({
      runId: run.id,
      taskId: task.id,
      header: 'Approach',
      question: 'Which approach?',
      options: [
        { label: 'A', description: 'first' },
        { label: 'B', description: 'second' },
      ],
      multiSelect: false,
    });
    expect(q.answer).toBeNull();
    expect(store.listUnansweredForRun(run.id)).toHaveLength(1);
    expect(store.listUnansweredForTask(task.id)).toHaveLength(1);

    const answered = store.recordAnswer(q.id, { selected: ['B'] });
    expect(answered.answer).toEqual({ selected: ['B'] });
    expect(answered.answeredAt).not.toBeNull();
    expect(store.listUnansweredForRun(run.id)).toHaveLength(0);
    expect(store.listUnansweredForTask(task.id)).toHaveLength(0);
  });

  it('round-trips a permission question', () => {
    const task = newTask();
    const run = store.createAgentRun({ taskId: task.id, stage: 'implementation' });
    const q = store.createAgentQuestion({
      runId: run.id,
      taskId: task.id,
      header: 'Permission',
      question: 'Allow Write to hello.txt?',
      options: [
        { label: 'allow', description: 'permit' },
        { label: 'deny', description: 'block' },
      ],
      multiSelect: false,
      permission: { toolName: 'Write', toolInput: { file_path: 'hello.txt' } },
    });
    expect(q.permission).toEqual({ toolName: 'Write', toolInput: { file_path: 'hello.txt' } });
  });
});

describe('Store — project description, artifact edits, task delete', () => {
  function newTask() {
    const project = store.createProject({
      name: 'Demo',
      description: 'a demo repo',
      repoPath: '/tmp/repo',
      defaultBranch: 'main',
    });
    return {
      project,
      task: store.createTask({ projectId: project.id, title: 't', rawRequest: 'r' }),
    };
  }

  it('persists a project description (defaulting to empty)', () => {
    const { project } = newTask();
    expect(project.description).toBe('a demo repo');
    const bare = store.createProject({ name: 'Bare', repoPath: '/tmp/b', defaultBranch: 'main' });
    expect(bare.description).toBe('');
  });

  it('updateArtifactBody rewrites the body on disk and updates byteSize', () => {
    const { task } = newTask();
    const art = store.createArtifact({
      taskId: task.id,
      kind: 'task_brief',
      title: 'B',
      body: 'old',
    });
    const updated = store.updateArtifactBody(art.id, 'a much longer new body');
    expect(updated?.byteSize).toBe(Buffer.byteLength('a much longer new body'));
    expect(store.readArtifactBody(art.id)).toBe('a much longer new body');
  });

  it('updateArtifactBody returns null for a missing artifact', () => {
    expect(store.updateArtifactBody('art_missing', 'x')).toBeNull();
  });

  it('deleteTask removes the task and all child rows', () => {
    const { task } = newTask();
    store.createArtifact({ taskId: task.id, kind: 'task_brief', title: 'B', body: 'b' });
    const run = store.createAgentRun({ taskId: task.id, stage: 'task_brief' });
    store.appendAgentRunEvent({ runId: run.id, type: 'assistant_text', payload: { text: 'hi' } });
    store.createAgentQuestion({
      runId: run.id,
      taskId: task.id,
      header: 'h',
      question: 'q',
      options: null,
      multiSelect: false,
    });

    expect(store.deleteTask(task.id)).toBe(true);
    expect(store.getTask(task.id)).toBeNull();
    expect(store.listArtifacts(task.id)).toHaveLength(0);
    expect(store.listStageRuns(task.id)).toHaveLength(0);
    expect(store.listAgentRuns(task.id)).toHaveLength(0);
    expect(store.listAgentRunEvents(run.id)).toHaveLength(0);
    expect(store.listUnansweredForTask(task.id)).toHaveLength(0);
  });

  it('deleteTask returns false for a missing task', () => {
    expect(store.deleteTask('task_missing')).toBe(false);
  });
});

describe('Store — onTaskChange notifications', () => {
  function newTask() {
    const project = store.createProject({ name: 'D', repoPath: '/tmp/r', defaultBranch: 'main' });
    return store.createTask({ projectId: project.id, title: 't', rawRequest: 'r' });
  }

  it('fires the listener with the taskId on a transition', () => {
    const task = newTask();
    const seen: string[] = [];
    store.onTaskChange((id) => seen.push(id));
    store.applyTransition(task.id, { stage: 'human_brief_approval', status: 'active' });
    expect(seen).toEqual([task.id]);
  });

  it('fires on a new artifact', () => {
    const task = newTask();
    const seen: string[] = [];
    store.onTaskChange((id) => seen.push(id));
    store.createArtifact({ taskId: task.id, kind: 'task_brief', title: 'B', body: 'b' });
    expect(seen).toEqual([task.id]);
  });

  it('unsubscribe stops further notifications', () => {
    const task = newTask();
    const seen: string[] = [];
    const off = store.onTaskChange((id) => seen.push(id));
    store.applyTransition(task.id, { stage: 'human_brief_approval', status: 'active' });
    off();
    store.applyTransition(task.id, { stage: 'discovery', status: 'active' });
    expect(seen).toEqual([task.id]); // only the first transition was observed
  });

  it('a throwing listener does not break the write or other listeners', () => {
    const task = newTask();
    const seen: string[] = [];
    store.onTaskChange(() => {
      throw new Error('boom');
    });
    store.onTaskChange((id) => seen.push(id));
    expect(() =>
      store.applyTransition(task.id, { stage: 'human_brief_approval', status: 'active' }),
    ).not.toThrow();
    expect(store.getTask(task.id)?.stage).toBe('human_brief_approval'); // write committed
    expect(seen).toEqual([task.id]); // sibling listener still ran
  });
});

describe('Store — project external tools', () => {
  const tools: ExternalToolConfig[] = [
    {
      name: 'klaviyo-local-seed',
      root: '/home/tester/GitHub/klaviyo-local-seed',
      docPath: 'CLAUDE.md',
      recipesDir: 'docs/recipes',
      stages: ['implementation', 'feature_e2e'],
    },
  ];

  it('round-trips externalTools through the JSON column', () => {
    const project = store.createProject({
      name: 'Demo',
      repoPath: '/tmp/repo',
      defaultBranch: 'main',
      externalTools: tools,
    });
    expect(store.getProject(project.id)?.externalTools).toEqual(tools);
  });

  it('defaults to [] when unset (and for pre-existing rows)', () => {
    const project = store.createProject({
      name: 'Demo',
      repoPath: '/tmp/repo',
      defaultBranch: 'main',
    });
    expect(store.getProject(project.id)?.externalTools).toEqual([]);
  });

  it('setProjectExternalTools replaces the set and clears with []', () => {
    const project = store.createProject({
      name: 'Demo',
      repoPath: '/tmp/repo',
      defaultBranch: 'main',
    });
    store.setProjectExternalTools(project.id, tools);
    expect(store.getProject(project.id)?.externalTools).toEqual(tools);
    store.setProjectExternalTools(project.id, []);
    expect(store.getProject(project.id)?.externalTools).toEqual([]);
  });
});
