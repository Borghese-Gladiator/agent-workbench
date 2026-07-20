const BASE = '/api';

function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function camelizeKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(camelizeKeys);
  if (obj !== null && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => [
        snakeToCamel(k),
        camelizeKeys(v),
      ])
    );
  }
  return obj;
}

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err.error || err.message || res.statusText);
  }
  const data = await res.json();
  return camelizeKeys(data) as T;
}

// --- Terminal Sessions ---

export function listSessions(filter?: { state?: string; workItemId?: string }) {
  const params = new URLSearchParams();
  if (filter?.state) params.set('state', filter.state);
  if (filter?.workItemId) params.set('workItemId', filter.workItemId);
  const qs = params.toString();
  return apiFetch(`/sessions${qs ? `?${qs}` : ''}`);
}

export function getSession(id: string) {
  return apiFetch(`/sessions/${id}`);
}

export function createSession(workItemId: string) {
  return apiFetch('/sessions', {
    method: 'POST',
    body: JSON.stringify({ workItemId }),
  });
}

export function resumeSession(id: string) {
  return apiFetch(`/sessions/${id}/resume`, { method: 'POST' });
}

export function closeSession(id: string) {
  return apiFetch(`/sessions/${id}`, { method: 'DELETE' });
}
