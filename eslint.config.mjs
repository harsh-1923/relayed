// What the compiler cannot see.
//
// This repository already checks the two expensive things. `tsc` runs over every
// package with `exactOptionalPropertyTypes` and `noUnusedLocals`, and
// `tools/check-boundaries.mjs` enforces nine architectural rules — who may reach
// the sync engine, who may call `workspace.switch`, who may import a telemetry
// SDK. So this config is deliberately NOT a preset. A recommended set bolted
// onto a codebase with those two in place is mostly noise, and noise is how a
// lint step becomes a thing people pass `--no-verify` to.
//
// It turns on the rules that catch the bug classes this codebase has actually
// shipped, and nothing else.
//
// THE FIRST ONE IS THE REASON THIS FILE EXISTS. An unhandled promise rejection
// from a `void`-invoked handler has taken down the sync engine more than once —
// it has a number (invariant 54), a comment in `OfflineSwitch.tsx` warning about
// it, and a hand-written `boundary()` wrapper in `sync/link.ts` built to contain
// it. `no-floating-promises` is that invariant expressed as a check rather than
// as a thing reviewers are asked to remember. It needs type information, which
// is why this is a type-aware config and why it is the slowest step in the gate.
//
// FORMATTING IS NOT HERE, and deliberately nowhere. `.prettierignore` carries
// the measurement behind that: Prettier does not own `.ts`/`.tsx` here.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import { includeIgnoreFile } from '@eslint/compat';
import { fileURLToPath } from 'node:url';

export default tseslint.config(
  // WHAT GIT IGNORES, LINT IGNORES. Not a convenience: `docs/sync-whiteboards/`
  // is a local scratch directory that is gitignored and still on disk, and
  // linting it means failing a build over a file nobody shares. Reading the
  // ignore file keeps the two lists from drifting, which a second hand-written
  // list would do the first time anything was added to either.
  includeIgnoreFile(fileURLToPath(new URL('.gitignore', import.meta.url))),
  {
    ignores: [
      '**/node_modules/**',
      '**/out/**',
      '**/dist/**',
      // Vendored shadcn, in both surfaces that use it. `shadcn add --overwrite`
      // rewrites these files wholesale, so anything we enforce here is undone by
      // the next component update — the same reason each app's renderer tsconfig
      // relaxes two compiler flags for exactly these directories
      // (apps/desktop/tsconfig.web.json, apps/web/tsconfig.json; FRONTEND.md §6.1).
      'apps/desktop/src/renderer/components/ui/**',
      'apps/web/src/components/ui/**',
      // A separate npm project with its own install, run by hand to verify
      // Electron behaviour. Not part of this workspace's graph.
      'spikes/electron-verify/**',
      'spikes/hotkeys/**',
      'spikes/web-panels/**',
      'spikes/text-fragments/**',
      // Declaration files describe types; there is no code in them to lint, and
      // type-aware rules on one report nothing but the cost of loading it.
      '**/*.d.ts',
      '**/*.d.mts',
    ],
  },

  // ── TypeScript, with types ────────────────────────────────────────────────
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts'],
    extends: [js.configs.recommended, tseslint.configs.base],
    languageOptions: {
      parserOptions: {
        // Resolves each file against the nearest tsconfig rather than a list
        // maintained here. `apps/desktop` alone has four of them, and a list
        // would go stale the first time one was added.
        //
        // `allowDefaultProject` covers the files no tsconfig claims. Without it
        // they are a PARSE ERROR rather than a skip — lint fails on a file
        // nobody asked it to type-check. `vite.config.ts` is the standalone
        // renderer config the shadcn CLI reads; it builds nothing, so no
        // tsconfig includes it.
        projectService: {
          allowDefaultProject: ['apps/desktop/vite.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ── invariant 54, mechanically ──
      // A promise nobody awaits and nobody catches. In the sync engine this is
      // not a warning: an unhandled rejection in the utility process takes the
      // process down, and the renderer sees a socket that stopped talking.
      '@typescript-eslint/no-floating-promises': 'error',
      // An async function passed where a void one is expected — an `onClick`,
      // an event listener, a `.forEach`. The rejection has nowhere to go.
      '@typescript-eslint/no-misused-promises': 'error',
      // `await` on something that is not a promise. Usually a refactor that left
      // the await behind, and it silently costs a tick.
      '@typescript-eslint/await-thenable': 'error',
      // Stringifying an object that has no `toString` — which yields the literal
      // text `[object Object]`. It bites exactly where it hurts: every hit found
      // when this was switched on was an ERROR MESSAGE built out of somebody
      // else's JSON, so the failure path produced `[object Object]` as the thing
      // the user reads and the thing that reaches Loki.
      '@typescript-eslint/no-base-to-string': 'error',

      // ── things tsc does not check ──
      // `tsc` has `noUnusedLocals`, but not unused CAUGHT bindings or args.
      // Off for arguments, because a deliberately-ignored parameter is ordinary
      // in an interface implementation.
      '@typescript-eslint/no-unused-vars': ['error', {
        args: 'none',
        caughtErrors: 'none',
        varsIgnorePattern: '^_',
      }],
      // `js.configs.recommended` bans these, and `tsc` already does it better.
      'no-unused-vars': 'off',
      'no-undef': 'off',
      // Overload signatures and declaration merging are legitimate here.
      'no-redeclare': 'off',
    },
  },

  // ── plain JavaScript: launchers, spikes, tools ────────────────────────────
  //
  // No tsconfig covers them, so type-aware rules cannot run and would error
  // rather than skip. They keep the syntactic ones.
  {
    files: ['**/*.mjs', '**/*.js', '**/*.cjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      // Listed rather than pulled from the `globals` package: this is every
      // global the four scripts in this repository actually use, and a name that
      // is not here is a name worth noticing.
      globals: { process: 'readonly', console: 'readonly', setTimeout: 'readonly',
                 clearTimeout: 'readonly', setInterval: 'readonly',
                 clearInterval: 'readonly', fetch: 'readonly', URL: 'readonly',
                 Buffer: 'readonly', crypto: 'readonly', __dirname: 'readonly' },
    },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // ── React, where React runs ───────────────────────────────────────────────
  //
  // The renderer and the marketing site. The other half of this codebase is a
  // main process, a utility process and a server, none of which have hooks.
  // Scoping keeps the rules' failures meaningful instead of a plugin loaded
  // everywhere for four directories.
  {
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}', 'apps/web/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      // The one that catches a real bug rather than a style: a stale closure in
      // an effect reads state from a render that is already gone. `useQuery` and
      // `useSession` both hand out values that change underneath a component.
      'react-hooks/exhaustive-deps': 'error',
    },
  },

  // ── tests ─────────────────────────────────────────────────────────────────
  //
  // A test asserts that something rejects, and the floating promise IS the
  // assertion. `assert.rejects` covers it; a bare call that is expected to throw
  // does not need to be written around the rule.
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.test.mjs'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
    },
  },
);
