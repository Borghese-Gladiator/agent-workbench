import { describe, expect, it, vi } from 'vitest';
import { createClient } from './client.js';

/** A fake fetch that records the call and returns a canned JSON response. */
function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe('createClient', () => {
  it('prefixes the baseUrl onto request paths', async () => {
    const { impl, calls } = fakeFetch(200, []);
    const api = createClient('http://host:4417', impl);
    await api.listProjects();
    expect(calls[0]!.url).toBe('http://host:4417/api/projects');
  });

  it('treats an empty baseUrl as same-origin (relative paths)', async () => {
    const { impl, calls } = fakeFetch(200, []);
    const api = createClient('', impl);
    await api.listTasks();
    expect(calls[0]!.url).toBe('/api/tasks');
  });

  it('strips a trailing slash from the baseUrl', async () => {
    const { impl, calls } = fakeFetch(200, { id: 't1' });
    const api = createClient('http://host:4417/', impl);
    await api.getTask('t1');
    expect(calls[0]!.url).toBe('http://host:4417/api/tasks/t1');
  });

  it('sends method + JSON body + content-type for mutations', async () => {
    const { impl, calls } = fakeFetch(201, { id: 'p1' });
    const api = createClient('', impl);
    await api.createProject({ name: 'P', repoPath: '/r', defaultBranch: 'main' });
    const { init } = calls[0]!;
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init?.body as string)).toEqual({
      name: 'P',
      repoPath: '/r',
      defaultBranch: 'main',
    });
  });

  it('posts a generic lifecycle action to the right path', async () => {
    const { impl, calls } = fakeFetch(200, { id: 't1', stage: 'human_plan_approval' });
    const api = createClient('', impl);
    await api.action('t1', 'approve-brief');
    expect(calls[0]!.url).toBe('/api/tasks/t1/approve-brief');
    expect(calls[0]!.init?.method).toBe('POST');
  });

  it('throws the daemon error message on a non-2xx response', async () => {
    const { impl } = fakeFetch(409, { error: 'isolated worktree required' });
    const api = createClient('', impl);
    await expect(api.action('t1', 'approve-brief', { skipWorktree: true })).rejects.toThrow(
      'isolated worktree required',
    );
  });

  it('falls back to a generic message when the error body has no message', async () => {
    const { impl } = fakeFetch(500, {});
    const api = createClient('', impl);
    await expect(api.listProjects()).rejects.toThrow(/GET \/api\/projects failed \(500\)/);
  });

  it('builds an absolute SSE events URL', () => {
    const { impl } = fakeFetch(200, {});
    const api = createClient('http://host:4417', impl);
    expect(api.runEventsUrl('t1', 'run1')).toBe(
      'http://host:4417/api/tasks/t1/agent/runs/run1/events',
    );
  });

  it('builds an absolute task-events SSE URL', () => {
    const { impl } = fakeFetch(200, {});
    const api = createClient('http://host:4417', impl);
    expect(api.taskEventsUrl('t1')).toBe('http://host:4417/api/tasks/t1/events');
  });

  describe('shared-secret token', () => {
    it('sends the token as a Bearer header on requests', async () => {
      const { impl, calls } = fakeFetch(200, []);
      const api = createClient('', impl, 'secret');
      await api.listTasks();
      expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toBe(
        'Bearer secret',
      );
    });

    it('combines the Bearer header with the JSON content-type on mutations', async () => {
      const { impl, calls } = fakeFetch(201, { id: 'p1' });
      const api = createClient('', impl, 'secret');
      await api.createProject({ name: 'P', repoPath: '/r', defaultBranch: 'main' });
      expect(calls[0]!.init?.headers).toEqual({
        'Content-Type': 'application/json',
        Authorization: 'Bearer secret',
      });
    });

    it('appends ?token= to SSE URLs (EventSource cannot set headers)', () => {
      const { impl } = fakeFetch(200, {});
      const api = createClient('http://host:4417', impl, 'se cret&');
      expect(api.runEventsUrl('t1', 'run1')).toBe(
        'http://host:4417/api/tasks/t1/agent/runs/run1/events?token=se%20cret%26',
      );
      expect(api.taskEventsUrl('t1')).toBe(
        'http://host:4417/api/tasks/t1/events?token=se%20cret%26',
      );
    });

    it('omits auth entirely when no token is configured', async () => {
      const { impl, calls } = fakeFetch(200, []);
      const api = createClient('', impl, undefined);
      await api.listTasks();
      expect(calls[0]!.init?.headers).toBeUndefined();
      expect(api.taskEventsUrl('t1')).toBe('/api/tasks/t1/events');
    });
  });
});
