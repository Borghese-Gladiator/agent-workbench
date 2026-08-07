import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
