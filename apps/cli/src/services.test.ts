import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serviceDefinitions } from './services.js';

describe('serviceDefinitions runtime mode', () => {
  it('dev mode runs worker + daemon from live source via pnpm tsx watch', () => {
    const defs = serviceDefinitions('dev');
    expect(defs.worker.command).toBe('pnpm');
    expect(defs.worker.args).toEqual(['--filter', '@awb/temporal-worker', 'dev']);
    expect(defs.daemon.command).toBe('pnpm');
    expect(defs.daemon.args).toEqual(['--filter', '@awb/daemon', 'dev']);
  });

  it('pinned mode runs worker + daemon from the live repo dist with the active node binary', () => {
    const defs = serviceDefinitions('pinned');
    // Absolute path to the node running this process, not a bare 'node' (ENOENT under pnpm/fnm).
    expect(defs.worker.command).toBe(process.execPath);
    expect(defs.worker.args).toEqual(['dist/index.js']);
    expect(defs.worker.cwd.endsWith(join('workers', 'temporal-worker'))).toBe(true);
    expect(defs.daemon.command).toBe(process.execPath);
    expect(defs.daemon.args).toEqual(['dist/index.js']);
    expect(defs.daemon.cwd.endsWith(join('apps', 'daemon'))).toBe(true);
  });
});

describe('serviceDefinitions runtime config resolution', () => {
  const KEYS = ['AWB_DAEMON_PORT', 'AWB_TEMPORAL_PORT', 'AWB_UI_PORT', 'AWB_OTEL_OTLP_PORT', 'AWB_OTEL_CONTAINER', 'AWB_TASK_QUEUE', 'AWB_DAEMON_URL'] as const;
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('defaults to today\'s ports/container when no env is set', () => {
    const defs = serviceDefinitions('pinned');
    expect(defs.daemon.port).toBe(4417);
    expect(defs.temporal.port).toBe(7233);
    expect(defs.ui.port).toBe(5317);
    expect(defs.otel.port).toBe(4318);
    expect(defs.otel.args).toContain('awb-otel-lgtm');
  });

  it('flows env overrides into the service defs (ports, temporal --port, OTel container/publish)', () => {
    process.env.AWB_DAEMON_PORT = '5500';
    process.env.AWB_TEMPORAL_PORT = '8200';
    process.env.AWB_OTEL_OTLP_PORT = '4400';
    process.env.AWB_OTEL_CONTAINER = 'awb-otel-abc';
    const defs = serviceDefinitions('pinned');
    expect(defs.daemon.port).toBe(5500);
    expect(defs.temporal.port).toBe(8200);
    expect(defs.temporal.args).toContain('8200'); // --port <resolved>
    expect(defs.otel.port).toBe(4400);
    expect(defs.otel.args).toContain('awb-otel-abc'); // --name <resolved>
    expect(defs.otel.args).toContain('4400:4318'); // publish resolved OTLP host port
  });

  it('passes the resolved daemon URL to the UI (vite proxy target)', () => {
    process.env.AWB_DAEMON_PORT = '5500';
    const defs = serviceDefinitions('pinned');
    expect(defs.ui.env?.AWB_DAEMON_URL).toBe('http://127.0.0.1:5500');
  });
});
