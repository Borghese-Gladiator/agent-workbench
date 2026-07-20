const DAEMON_BASE_URL = 'http://127.0.0.1:4417';

export class DaemonRequestError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DaemonRequestError';
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${DAEMON_BASE_URL}${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new DaemonRequestError(0, 'Could not reach the daemon — is it running? Try `awb daemon start`.');
  }

  const json = (await response.json().catch(() => ({}))) as Record<string, unknown> & { error?: string };
  if (!response.ok) {
    throw new DaemonRequestError(response.status, json.error ?? `Request failed with status ${response.status}`);
  }
  return json as T;
}

export const daemonClient = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
};
