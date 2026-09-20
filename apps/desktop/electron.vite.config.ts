import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Plugin } from 'vite';

/**
 * Tell the multi-client launcher that a build has FINISHED.
 *
 * Only when `RELAYED_BUILD_SIGNAL` names a file, which only the launcher sets —
 * so an ordinary `pnpm dev` builds exactly as before.
 *
 * WHY A HOOK AND NOT A WATCH ON `out/`. The launcher needs to restart clients
 * 2..N on the same event that makes electron-vite restart client 1, and that
 * event is a rollup `closeBundle` — it fires once a bundle is completely
 * written. A filesystem watcher is a different, weaker signal: it fires on the
 * first chunk to land, while shared chunks may still be being written. Restarting
 * from it would hand the extra clients a half-written build, and the symptom
 * would read as "the extra clients are flaky" rather than as a race.
 *
 * Main and preload are separate builds with separate hooks, so the file is
 * touched twice per edit; the launcher debounces rather than restarting twice.
 */
/**
 * EVERY workspace package, not just the one that broke first.
 *
 * These are source, and `exclude` here means "exclude from externalizing" —
 * bundle them. The list was `['@relayed/telemetry']` because that is the one
 * that failed in development, where `node_modules/@relayed/*` are pnpm
 * SYMLINKS: the realpath lands in `packages/`, outside node_modules, and Node
 * strips types happily. The others looked fine for exactly that reason.
 *
 * Packaging removes the symlink. electron-builder copies the real files into
 * `node_modules` inside the asar, and Node then refuses to strip types from a
 * path under node_modules — ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING. The
 * sync engine crash-looped, the renderer never got its MessagePort, and the
 * window was simply blank. Nothing in the build said a word.
 *
 * The same trap, from the same rule, is why the server's Dockerfile installs
 * with plain `pnpm install` rather than `pnpm deploy` (docs/DEPLOY.md §4a).
 */
const WORKSPACE_PACKAGES = [
  '@relayed/authz',
  '@relayed/genui',
  '@relayed/icons',
  '@relayed/protocol',
  '@relayed/telemetry',
];

function signalBuild(): Plugin {
  const target = process.env['RELAYED_BUILD_SIGNAL'];
  return {
    name: 'relayed:build-signal',
    apply: 'build',
    closeBundle() {
      if (!target) return;
      mkdirSync(resolve(target, '..'), { recursive: true });
      writeFileSync(target, String(Date.now()));
    },
  };
}

/**
 * What this build points at, substituted into the bundle (src/sync/config.ts).
 *
 * READ FROM THE BUILD ENVIRONMENT, which is the developer's shell for a local
 * build and CI's secrets for a release. A packaged app has no `.env` to read at
 * runtime, so this is the only moment the values can be chosen.
 *
 * The localhost default is what makes `pnpm dev` work with no setup. It is also
 * why a release build MUST set these: shipping the default produces an app that
 * points at a server on the user's own machine and fails at sign-in with
 * nothing to suggest why. `pnpm build` warns when they are unset.
 */
function buildConfig(): Record<string, string> {
  const server = process.env['RELAYED_SERVER_URL'] ?? 'http://127.0.0.1:8787';
  const client = process.env['WORKOS_CLIENT_ID'] ?? '';
  if (process.env['RELAYED_RELEASE'] === '1') {
    // A release that would ship the dev defaults is a broken download, and the
    // break only shows up on someone else's machine. Fail the build instead.
    if (server.includes('127.0.0.1') || server.includes('localhost')) {
      throw new Error(`RELAYED_RELEASE=1 but RELAYED_SERVER_URL is ${server}`);
    }
    if (!client) throw new Error('RELAYED_RELEASE=1 but WORKOS_CLIENT_ID is unset');
  }
  return {
    __RELAYED_SERVER_URL__: JSON.stringify(server),
    __WORKOS_CLIENT_ID__: JSON.stringify(client),
  };
}

export default defineConfig({
  main: {
    // Workspace packages are SOURCE and must be bundled; only real node_modules
    // dependencies get externalized. Without the exclude, Electron tries to
    // load their raw .ts at runtime and cannot.
    plugins: [externalizeDepsPlugin({ exclude: WORKSPACE_PACKAGES }), signalBuild()],
    // The sync engine is one of this build's entries, so its `config.ts` is
    // substituted here rather than in the renderer — the renderer never learns
    // the server URL and has no business holding it.
    define: buildConfig(),
    build: {
      rollupOptions: {
        // Three main-process entries: the app itself, the sync engine, and the
        // agent runner — both of the latter utilityProcesses (DESIGN.md §5,
        // LOCAL-ROOMS.md §5).
        input: {
          index: resolve('src/main/index.ts'),
          sync: resolve('src/sync/index.ts'),
          'agent-runner': resolve('src/agent-runner/index.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: WORKSPACE_PACKAGES }), signalBuild()],
    build: { rollupOptions: { input: resolve('src/preload/index.ts') } },
  },
  renderer: {
    root: resolve('src/renderer'),
    // PINNED, because clients 2..N are told this URL rather than discovering it
    // (scripts/dev-clients.mjs). `strictPort` so a busy port fails loudly
    // instead of silently moving — a sibling pointed at the wrong port renders
    // nothing and looks like a broken build.
    server: {
      port: Number(process.env['RELAYED_DEV_PORT'] ?? 5273),
      strictPort: true,
    },
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': resolve('src/renderer') } },
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } },
  },
});
