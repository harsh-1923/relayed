// Where this build points: the server it talks to, and the WorkOS client it
// authenticates against (docs/RELEASE.md §1, "Now").
//
// BAKED AT BUILD TIME, NOT READ FROM DISK. A packaged app has no `.env` — main
// loads one only when `!app.isPackaged`, because a file of configuration
// sitting beside a binary is a credential the user can edit and an attacker can
// replace. So the values are substituted into the bundle by electron-vite's
// `define` (electron.vite.config.ts) and travel inside the build.
//
// Neither value is a secret. The WorkOS client id is a public identifier — it
// is in ci.yml in the clear — and the server URL is a hostname anyone can read
// off a packet. What matters is not that they are hidden but that they are
// FIXED: a build points at exactly one deployment, and which one is decided
// when it is built rather than by whatever environment it is launched from.
//
// THE DEV OVERRIDE IS DELIBERATELY ASYMMETRIC. Unpackaged, the environment wins,
// because that is how `pnpm dev` points a client at localhost and how a client
// is pointed at production to test it (DEPLOY.md §7). Packaged, the environment
// is ignored entirely: a shipped app that could be re-pointed at another server
// by setting a variable before launching it is a phishing primitive, not a
// feature.

/** Substituted by electron-vite. Declared, never imported. */
declare const __RELAYED_SERVER_URL__: string;
declare const __WORKOS_CLIENT_ID__: string;

/**
 * The baked value, or `undefined` when nothing baked it.
 *
 * NOTHING BAKES IT UNDER `node --test`: the suites run the TypeScript directly,
 * with no bundler and so no substitution. That absence is a reliable signal
 * rather than a hazard — a build that was never bundled cannot be a shipped
 * one — so it is treated as the most permissive case and the environment
 * decides. It is what lets a test stand up a mock server and point the auth
 * client at it.
 */
const baked = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const bakedServer = baked(typeof __RELAYED_SERVER_URL__ === 'undefined' ? undefined : __RELAYED_SERVER_URL__);
const bakedClient = baked(typeof __WORKOS_CLIENT_ID__ === 'undefined' ? undefined : __WORKOS_CLIENT_ID__);

/**
 * May the environment override what this build points at?
 *
 * Yes when unbundled (above), and yes when `RELAYED_DEV` is set — which main
 * sets for unpackaged builds only, and which already gates the simulated-offline
 * switch. Reused rather than re-derived: the sync engine is a utilityProcess
 * with no `app` to ask whether it is packaged.
 *
 * No otherwise, which is the case that matters: in a shipped app the
 * environment is ignored, so setting a variable before launching it cannot
 * re-point somebody's client at another server.
 */
const envMayOverride = (): boolean =>
  bakedServer === undefined || Boolean(process.env['RELAYED_DEV']);

const fromEnvIfDev = (name: string): string | undefined =>
  envMayOverride() ? process.env[name] || undefined : undefined;

/** The server this build talks to, with no trailing slash. */
export const serverUrl = (): string =>
  (fromEnvIfDev('RELAYED_SERVER_URL') ?? bakedServer ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');

/** `ws(s)://…/sync`, derived so the two can never disagree. */
export const syncUrl = (): string => serverUrl().replace(/^http/, 'ws') + '/sync';

/** The WorkOS client this build authenticates against. Public, never secret. */
export const workosClientId = (): string =>
  fromEnvIfDev('WORKOS_CLIENT_ID') ?? bakedClient ?? '';
