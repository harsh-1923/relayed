// Whether this build is still the one to be running (docs/RELEASE.md §1).
//
// Two levels, because they are different questions. `update_available` is an
// offer: there is something newer, take it when you like. `update_required` is
// a refusal: this build is below the floor the server publishes, and the app
// says so instead of pretending to work.
//
// THE FORCED LEVEL NEEDS AN ANSWER, NEVER A TIMEOUT. R3 says local data is
// fully readable without a network, so a check that could not reach the server
// must leave the app alone — a blocked screen on a plane would be the exact
// failure the whole local-first design exists to prevent. The block is entered
// only on a successful response that says so, which is why `unknown` is a state
// rather than a silent `ok`.
import { emit, count } from '@relayed/telemetry';
import { serverUrl } from './config.ts';

/** Substituted by electron-vite from package.json. */
declare const __RELAYED_VERSION__: string;

export const appVersion = (): string =>
  typeof __RELAYED_VERSION__ === 'string' ? __RELAYED_VERSION__ : '0.0.0';

export type VersionState =
  /** Nothing to say: either current, or we have not been told otherwise. */
  | { status: 'ok' }
  /** Something newer exists. Dismissible; the app works. */
  | { status: 'update_available'; latest: string; url: string }
  /** Below the published floor. The app refuses to be used until replaced. */
  | { status: 'update_required'; latest: string; minimum: string; url: string };

/**
 * Compare two dotted versions numerically.
 *
 * NOT `localeCompare`, and not string ordering: "0.0.10" sorts BEFORE "0.0.9"
 * as text, which would stop offering updates exactly when a project starts
 * shipping them. Missing segments read as 0, so "1.2" and "1.2.0" are equal.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(n => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export interface VersionAnswer { latest: string; minimum: string; url: string }

/** What a given answer means for a given build. Pure, so it is the tested part. */
export function stateFor(mine: string, answer: VersionAnswer): VersionState {
  if (compareVersions(mine, answer.minimum) < 0) {
    return { status: 'update_required', latest: answer.latest, minimum: answer.minimum, url: answer.url };
  }
  if (compareVersions(mine, answer.latest) < 0) {
    return { status: 'update_available', latest: answer.latest, url: answer.url };
  }
  return { status: 'ok' };
}

/**
 * Ask the server, and say nothing when it cannot be reached.
 *
 * Never throws: an unreachable server means "no news", not an error the UI has
 * to render. The previous state is kept rather than cleared, so a client that
 * has already been told it is too old stays told across a network blip.
 */
export async function checkVersion(fetchImpl = globalThis.fetch): Promise<VersionState | null> {
  try {
    const res = await fetchImpl(`${serverUrl()}/version`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const raw = await res.json() as Partial<VersionAnswer>;
    if (typeof raw.latest !== 'string' || typeof raw.minimum !== 'string') return null;
    const state = stateFor(appVersion(), {
      latest: raw.latest, minimum: raw.minimum,
      url: typeof raw.url === 'string' ? raw.url : '',
    });
    count('app.version.checked', { version_outcome: state.status });
    if (state.status !== 'ok') {
      emit('app.update.offered', { current: appVersion(), latest: state.latest, required: state.status === 'update_required' });
    }
    return state;
  } catch {
    // Offline, DNS, a 500, a proxy returning HTML. None of them are news.
    return null;
  }
}
