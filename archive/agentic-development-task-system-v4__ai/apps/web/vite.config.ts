/// <reference types="vitest" />
import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const DAEMON_PORT = process.env.WORKBENCH_PORT ?? '4417';
// Proxy target host for /api. Defaults to localhost for native dev; in Docker
// the daemon is a separate compose service, so WORKBENCH_DAEMON_HOST=daemon.
const DAEMON_HOST = process.env.WORKBENCH_DAEMON_HOST ?? 'localhost';
// Dev-server port is overridable (e.g. the e2e run uses a dedicated port to
// avoid colliding with a running dev server). Defaults to 5317.
const WEB_PORT = Number(process.env.VITE_PORT ?? 5317);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    // The Playwright walkthrough lives in e2e/ and must not be run by vitest.
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**'],
  },
  server: {
    port: WEB_PORT,
    // Bind all interfaces when asked (Docker needs 0.0.0.0 to be reachable
    // from the host). Native dev leaves this unset → Vite's localhost default.
    host: process.env.VITE_HOST || undefined,
    // The browser only ever talks to /api; Vite proxies it to the local daemon.
    proxy: {
      '/api': { target: `http://${DAEMON_HOST}:${DAEMON_PORT}`, changeOrigin: true },
    },
  },
});
