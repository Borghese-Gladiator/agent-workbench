/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // Ports/daemon-URL come from env (set by `awb up`, mirroring @awb/config's resolveRuntimeConfig)
  // with today's values as defaults, so an isolated stack's UI binds its own port and proxies to its
  // own daemon. Kept as bare env reads because this browser app must not import the Node config pkg.
  server: {
    port: Number(process.env.AWB_UI_PORT ?? 5317),
    proxy: {
      '/api': process.env.AWB_DAEMON_URL ?? 'http://127.0.0.1:4417',
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
});
