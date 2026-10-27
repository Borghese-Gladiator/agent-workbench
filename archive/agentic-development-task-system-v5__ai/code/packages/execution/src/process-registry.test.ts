import { describe, expect, it, vi } from 'vitest';
import { ProcessRegistry, type SupervisedProcessHandle } from './process-registry.js';

function fakeHandle(pid: number): { handle: SupervisedProcessHandle; kill: ReturnType<typeof vi.fn> } {
  const kill = vi.fn();
  return { handle: { pid, kill }, kill };
}

describe('ProcessRegistry', () => {
  it('lists no processes initially', () => {
    const registry = new ProcessRegistry();
    expect(registry.list()).toEqual([]);
  });

  it('registers and lists processes, optionally filtered by taskId', () => {
    const registry = new ProcessRegistry();
    const a = fakeHandle(100);
    const b = fakeHandle(200);
    registry.register('cmd-1', 'task-a', a.handle);
    registry.register('cmd-2', 'task-b', b.handle);

    expect(registry.list()).toHaveLength(2);
    expect(registry.list('task-a')).toEqual([{ id: 'cmd-1', taskId: 'task-a', pid: 100 }]);
    expect(registry.list('task-b')).toEqual([{ id: 'cmd-2', taskId: 'task-b', pid: 200 }]);
  });

  it('unregisters a process by id', () => {
    const registry = new ProcessRegistry();
    const a = fakeHandle(100);
    registry.register('cmd-1', 'task-a', a.handle);
    registry.unregister('cmd-1');

    expect(registry.list()).toEqual([]);
  });

  it('kills and removes all processes for a task, leaving other tasks untouched', () => {
    const registry = new ProcessRegistry();
    const a = fakeHandle(100);
    const b = fakeHandle(200);
    const c = fakeHandle(300);
    registry.register('cmd-1', 'task-a', a.handle);
    registry.register('cmd-2', 'task-a', b.handle);
    registry.register('cmd-3', 'task-b', c.handle);

    const killedIds = registry.killAllForTask('task-a');

    expect(new Set(killedIds)).toEqual(new Set(['cmd-1', 'cmd-2']));
    expect(a.kill).toHaveBeenCalledTimes(1);
    expect(b.kill).toHaveBeenCalledTimes(1);
    expect(c.kill).not.toHaveBeenCalled();
    expect(registry.list('task-a')).toEqual([]);
    expect(registry.list('task-b')).toHaveLength(1);
  });

  it('passes the signal through to each handle kill', () => {
    const registry = new ProcessRegistry();
    const a = fakeHandle(100);
    registry.register('cmd-1', 'task-a', a.handle);

    registry.killAllForTask('task-a', 'SIGTERM');

    expect(a.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
