// Standalone renderer config — serves src/renderer in a plain browser, without
// booting Electron. Useful for UI work on components that do not need the sync
// engine, and it is what the shadcn CLI reads to detect the project.
//
// The app itself is built by electron.vite.config.ts; this config is never used
// for a real build. `window.relayed` is absent here, so anything that queries
// the sync engine must degrade rather than throw.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve(import.meta.dirname, 'src/renderer'),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': resolve(import.meta.dirname, 'src/renderer') } },
});
