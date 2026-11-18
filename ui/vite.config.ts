import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The panel is served by the Neo Commander server at /panel (loopback only).
// Build output goes straight into the repo's panel/ directory.
export default defineConfig({
  base: '/panel/',
  plugins: [react()],
  build: {
    outDir: '../panel',
    emptyOutDir: true,
    assetsDir: 'assets',
    assetsInlineLimit: 0, // strict CSP: no data: fonts/images
    modulePreload: { polyfill: false }, // no inline polyfill script
    cssCodeSplit: false,
    sourcemap: false,
  },
  server: {
    // `npm run dev` proxies the API to a running Neo Commander; the CSRF token is not
    // available in dev mode, so use the built panel for write actions.
    proxy: { '/panel/api': 'http://127.0.0.1:8790' },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});
