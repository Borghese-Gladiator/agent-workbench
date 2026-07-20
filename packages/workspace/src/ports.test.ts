import { describe, expect, it } from 'vitest';
import { PortAllocator } from './ports.js';

describe('PortAllocator', () => {
  it('allocates distinct ports across multiple concurrent calls', async () => {
    const allocator = new PortAllocator();
    const ports = await Promise.all(Array.from({ length: 8 }, () => allocator.allocatePort()));
    expect(new Set(ports).size).toBe(ports.length);
    for (const port of ports) {
      expect(port).toBeGreaterThan(0);
    }
  });

  it('marks an allocated port as allocated until released', async () => {
    const allocator = new PortAllocator();
    const port = await allocator.allocatePort();
    expect(allocator.isAllocated(port)).toBe(true);
    allocator.releasePort(port);
    expect(allocator.isAllocated(port)).toBe(false);
  });

  it('allows a released port to be reused', async () => {
    const allocator = new PortAllocator();
    const port = await allocator.allocatePort();
    allocator.releasePort(port);
    const again = await allocator.allocatePort();
    expect(typeof again).toBe('number');
  });

  it('releasing a port that was never allocated is a no-op', () => {
    const allocator = new PortAllocator();
    expect(() => allocator.releasePort(65000)).not.toThrow();
  });
});
