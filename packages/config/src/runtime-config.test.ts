import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resolveRuntimeConfig,
  deriveIsolationTag,
  isolatedOverrides,
  DEFAULT_DAEMON_PORT,
  DEFAULT_TEMPORAL_PORT,
  DEFAULT_UI_PORT,
  DEFAULT_OTEL_OTLP_PORT,
  DEFAULT_OTEL_UI_PORT,
  DEFAULT_OTEL_CONTAINER,
  DEFAULT_TASK_QUEUE,
} from './runtime-config.js';

const ENV_KEYS = [
  'AWB_DAEMON_PORT',
  'AWB_TEMPORAL_PORT',
  'AWB_UI_PORT',
  'AWB_OTEL_OTLP_PORT',
  'AWB_OTEL_UI_PORT',
  'AWB_OTEL_CONTAINER',
  'AWB_TASK_QUEUE',
  'AWB_TEMPORAL_ADDRESS',
  'AWB_DAEMON_URL',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'AWB_DATA_DIR',
] as const;

describe('resolveRuntimeConfig', () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('with no env set, every field equals the historical single-instance default', () => {
    const cfg = resolveRuntimeConfig();
    expect(cfg).toEqual({
      daemonPort: DEFAULT_DAEMON_PORT,
      temporalPort: DEFAULT_TEMPORAL_PORT,
      uiPort: DEFAULT_UI_PORT,
      otelOtlpPort: DEFAULT_OTEL_OTLP_PORT,
      otelUiPort: DEFAULT_OTEL_UI_PORT,
      otelContainerName: DEFAULT_OTEL_CONTAINER,
      taskQueue: DEFAULT_TASK_QUEUE,
      temporalAddress: `127.0.0.1:${DEFAULT_TEMPORAL_PORT}`,
      daemonUrl: `http://127.0.0.1:${DEFAULT_DAEMON_PORT}`,
      otelEndpoint: `http://127.0.0.1:${DEFAULT_OTEL_OTLP_PORT}`,
    });
  });

  it.each([
    ['AWB_DAEMON_PORT', '5500', 'daemonPort', 5500],
    ['AWB_TEMPORAL_PORT', '8200', 'temporalPort', 8200],
    ['AWB_UI_PORT', '6000', 'uiPort', 6000],
    ['AWB_OTEL_OTLP_PORT', '4400', 'otelOtlpPort', 4400],
    ['AWB_OTEL_UI_PORT', '3100', 'otelUiPort', 3100],
    ['AWB_OTEL_CONTAINER', 'awb-otel-abc', 'otelContainerName', 'awb-otel-abc'],
    ['AWB_TASK_QUEUE', 'awb-task-queue-abc', 'taskQueue', 'awb-task-queue-abc'],
  ] as const)('env %s overrides %s', (envKey, envVal, field, expected) => {
    process.env[envKey] = envVal;
    expect(resolveRuntimeConfig()[field]).toBe(expected);
  });

  it('daemonUrl and otelEndpoint derive from their ports unless explicitly overridden', () => {
    process.env.AWB_DAEMON_PORT = '5500';
    process.env.AWB_OTEL_OTLP_PORT = '4400';
    const derived = resolveRuntimeConfig();
    expect(derived.daemonUrl).toBe('http://127.0.0.1:5500');
    expect(derived.otelEndpoint).toBe('http://127.0.0.1:4400');

    process.env.AWB_DAEMON_URL = 'http://127.0.0.1:9999';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector:4318';
    const explicit = resolveRuntimeConfig();
    expect(explicit.daemonUrl).toBe('http://127.0.0.1:9999');
    expect(explicit.otelEndpoint).toBe('http://collector:4318');
  });

  it('temporalAddress derives from the temporal port unless overridden', () => {
    process.env.AWB_TEMPORAL_PORT = '8200';
    expect(resolveRuntimeConfig().temporalAddress).toBe('127.0.0.1:8200');
    process.env.AWB_TEMPORAL_ADDRESS = 'remote-temporal:7233';
    expect(resolveRuntimeConfig().temporalAddress).toBe('remote-temporal:7233');
  });

  it.each(['0', '70000', 'abc', '-1'])('rejects an out-of-range / non-integer port %s', (bad) => {
    process.env.AWB_DAEMON_PORT = bad;
    expect(() => resolveRuntimeConfig()).toThrow(/AWB_DAEMON_PORT/);
  });
});

describe('deriveIsolationTag', () => {
  it('is deterministic per seed and distinct across seeds', () => {
    const a1 = deriveIsolationTag('/Users/x/GitHub/LOCAL_worktrees/agent-workbench/branch-a');
    const a2 = deriveIsolationTag('/Users/x/GitHub/LOCAL_worktrees/agent-workbench/branch-a');
    const b = deriveIsolationTag('/Users/x/GitHub/LOCAL_worktrees/agent-workbench/branch-b');
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('isolatedOverrides', () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('derives a full, self-consistent, non-default set of overrides', () => {
    const o = isolatedOverrides('/repos/branch-a', '/data/awb');
    const tag = deriveIsolationTag('/repos/branch-a');
    // Every isolatable var is present.
    expect(Object.keys(o).sort()).toEqual(
      [
        'AWB_DAEMON_PORT',
        'AWB_TEMPORAL_PORT',
        'AWB_UI_PORT',
        'AWB_OTEL_OTLP_PORT',
        'AWB_OTEL_UI_PORT',
        'AWB_OTEL_CONTAINER',
        'AWB_TASK_QUEUE',
        'AWB_DATA_DIR',
      ].sort(),
    );
    expect(o.AWB_OTEL_CONTAINER).toBe(`${DEFAULT_OTEL_CONTAINER}-${tag}`);
    expect(o.AWB_TASK_QUEUE).toBe(`${DEFAULT_TASK_QUEUE}-${tag}`);
    expect(o.AWB_DATA_DIR).toBe(`/data/awb-${tag}`);
    // Ports move off the defaults, stay in range.
    expect(Number(o.AWB_DAEMON_PORT)).toBeGreaterThan(DEFAULT_DAEMON_PORT);
    for (const key of ['AWB_DAEMON_PORT', 'AWB_TEMPORAL_PORT', 'AWB_UI_PORT'] as const) {
      const p = Number(o[key]);
      expect(p).toBeGreaterThan(1024);
      expect(p).toBeLessThan(65535);
    }
  });

  it('two distinct checkouts derive non-overlapping ports and distinct queues', () => {
    const a = isolatedOverrides('/repos/branch-a', '/data/awb');
    const b = isolatedOverrides('/repos/branch-b', '/data/awb');
    expect(a.AWB_DAEMON_PORT).not.toBe(b.AWB_DAEMON_PORT);
    expect(a.AWB_TASK_QUEUE).not.toBe(b.AWB_TASK_QUEUE);
    expect(a.AWB_DATA_DIR).not.toBe(b.AWB_DATA_DIR);
  });

  it('does NOT clobber a var the user already set explicitly', () => {
    process.env.AWB_DATA_DIR = '/my/explicit/dir';
    process.env.AWB_DAEMON_PORT = '5500';
    const o = isolatedOverrides('/repos/branch-a', '/data/awb');
    expect(o).not.toHaveProperty('AWB_DATA_DIR');
    expect(o).not.toHaveProperty('AWB_DAEMON_PORT');
    // The others are still derived.
    expect(o).toHaveProperty('AWB_TASK_QUEUE');
  });
});
