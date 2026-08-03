import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});

// jsdom ships a read-only navigator.clipboard whose getter returns a fresh object, so
// `navigator.clipboard.writeText = mock` does not stick. Define a stable, writable stub once so
// tests can spy on / reassign writeText and have components see the same object.
Object.defineProperty(navigator, 'clipboard', {
  value: { writeText: async () => undefined },
  configurable: true,
  writable: true,
});

if (typeof globalThis.matchMedia !== 'function') {
  globalThis.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}
