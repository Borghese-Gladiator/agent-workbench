import { killProcessTree } from './command-runner.js';

export interface SupervisedProcessHandle {
  pid: number;
  kill: (signal?: NodeJS.Signals) => void;
}

export interface SupervisedProcessEntry {
  id: string;
  taskId: string;
  pid: number;
}

interface RegisteredProcess {
  id: string;
  taskId: string;
  handle: SupervisedProcessHandle;
}

export class ProcessRegistry {
  private readonly processes = new Map<string, RegisteredProcess>();

  register(id: string, taskId: string, handle: SupervisedProcessHandle): void {
    this.processes.set(id, { id, taskId, handle });
  }

  unregister(id: string): void {
    this.processes.delete(id);
  }

  list(taskId?: string): SupervisedProcessEntry[] {
    const entries = Array.from(this.processes.values());
    const filtered = taskId === undefined ? entries : entries.filter((entry) => entry.taskId === taskId);
    return filtered.map((entry) => ({ id: entry.id, taskId: entry.taskId, pid: entry.handle.pid }));
  }

  killAllForTask(taskId: string, signal: NodeJS.Signals = 'SIGKILL'): string[] {
    const killedIds: string[] = [];
    for (const entry of this.processes.values()) {
      if (entry.taskId === taskId) {
        entry.handle.kill(signal);
        killedIds.push(entry.id);
      }
    }
    for (const id of killedIds) {
      this.processes.delete(id);
    }
    return killedIds;
  }
}

export function createSupervisedProcessHandle(pid: number): SupervisedProcessHandle {
  return {
    pid,
    kill: (signal: NodeJS.Signals = 'SIGKILL') => killProcessTree(pid, signal),
  };
}
