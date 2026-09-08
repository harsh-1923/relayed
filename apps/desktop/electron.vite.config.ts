import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    // Workspace packages are SOURCE and must be bundled; only real node_modules
    // dependencies get externalized. Without the exclude, Electron tries to
    // load @relayed/telemetry's raw .ts at runtime and fails to resolve it.
    plugins: [externalizeDepsPlugin({ exclude: ['@relayed/telemetry'] })],
    build: {
      rollupOptions: {
        // Two main-process entries: the app itself and the sync engine that
        // runs as a utilityProcess (DESIGN.md §5).
        input: {
          index: resolve('src/main/index.ts'),
          sync: resolve('src/sync/index.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@relayed/telemetry'] })],
    build: { rollupOptions: { input: resolve('src/preload/index.ts') } },
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': resolve('src/renderer') } },
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } },
  },
});
