// The auth state machine (PHASE-1-IDENTITY.md §7).
//
// WorkOS appears on the SIGN-IN path only. Its token is traded for one of ours
// immediately and then discarded, so refresh — and therefore steady-state sync —
// depends on our server alone. Keeping the WorkOS refresh token as well would
// leave two sources of truth about whether you are signed in, and they will
// disagree.
//
// The property this exists to protect: an auth failure must NEVER close the
// read path. Local data stays readable in every state except explicit sign-out,
// because "the token expired" and "the user signed out" are different events.
import { emit } from '@relayed/telemetry';
import { createPkce } from './pkce.ts';
import { listenForCallback } from './loopback.ts';
import { buildAuthorizeUrl, exchangeCode, type WorkOSConfig } from './workos.ts';
import {
  exchangeForSession, createWorkspace, refreshSession, signOutSession, fetchMe,
  ServerError, type Actor, type OurSession,
} from './relayed.ts';

export type AuthState =
  | { status: 'signed_out' }
  | { status: 'authenticating' }
  /** Signed in with WorkOS but no org yet — onboarding must run (§9). */
  | { status: 'needs_workspace'; identity: { email: string; displayName: string }; handleSuggestions: string[] }
  | { status: 'authenticated'; actor: Actor | null; expiresAt: number }
  /** Signed in, but the token could not be refreshed. Reads still work. */
  | { status: 'stale'; actor: Actor | null; reason: string };

export interface SessionDeps {
  config: WorkOSConfig;
  deviceId: string;
  /** Opens the SYSTEM browser. Never a BrowserWindow — providers refuse embedded webviews. */
  openBrowser(url: string): void | Promise<void>;
  vault: {
    read(): Promise<string | null>;
    store(token: string): Promise<void>;
    clear(): Promise<void>;
  };
  now?: () => number;
}

/** Refresh this far ahead of expiry so a live socket never carries a dead token. */
const REFRESH_SKEW_MS = 60_000;

export class Session {
  #state: AuthState = { status: 'signed_out' };
  #session: OurSession | null = null;
  /** Held only between the WorkOS exchange and onboarding completing. */
  #pendingWorkosToken: string | null = null;
  #listeners = new Set<(s: AuthState) => void>();
  readonly #deps: SessionDeps;
  readonly #now: () => number;

  constructor(deps: SessionDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  get state(): AuthState { return this.#state; }
  /** In-memory only. Never persisted, never sent to the renderer. */
  get accessToken(): string | null { return this.#session?.accessToken ?? null; }

  onChange(fn: (s: AuthState) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #set(next: AuthState): void {
    this.#state = next;
    for (const fn of this.#listeners) fn(next);
  }

  /** Full interactive sign-in: system browser, PKCE, loopback, then our server. */
  async signIn(): Promise<AuthState> {
    this.#set({ status: 'authenticating' });
    const pkce = createPkce();
    const listener = await listenForCallback({ state: pkce.state });
    try {
      await this.#deps.openBrowser(buildAuthorizeUrl(this.#deps.config, pkce, listener.redirectUri));
      const { code } = await listener.result;
      const workos = await exchangeCode(this.#deps.config, { code, verifier: pkce.verifier });

      const result = await exchangeForSession(workos.accessToken, this.#deps.deviceId);
      if ('needsWorkspace' in result) {
        // Onboarding needs the WorkOS token again to prove identity to
        // /auth/workspace. Held in memory only, and dropped either way.
        this.#pendingWorkosToken = workos.accessToken;
        this.#set({ status: 'needs_workspace', identity: result.identity,
                    handleSuggestions: result.handleSuggestions });
        return this.#state;
      }
      await this.#adopt(result);
      return this.#state;
    } catch (err) {
      listener.close();
      this.#set({ status: 'signed_out' });
      throw err;
    }
  }

  /** Onboarding: create the org, workspace and founding actor. */
  async createWorkspace(workspaceName: string, handle: string): Promise<AuthState> {
    if (!this.#pendingWorkosToken) throw new Error('no pending sign-in — start again');
    const session = await createWorkspace(
      this.#pendingWorkosToken, this.#deps.deviceId, workspaceName, handle);
    this.#pendingWorkosToken = null;
    await this.#adopt(session);
    return this.#state;
  }

  /**
   * Restore at boot from the stored refresh token.
   * Never throws — a failed restore is a degraded sync engine, not a failed boot.
   */
  async restore(): Promise<AuthState> {
    const stored = await this.#deps.vault.read();
    if (!stored) { this.#set({ status: 'signed_out' }); return this.#state; }
    try {
      await this.#adopt(await refreshSession(stored));
    } catch (err) {
      const e = err as ServerError;
      // 401/403 means the session is genuinely gone; anything else (offline,
      // server down) is temporary. Both leave local data untouched — the
      // difference is only what the banner offers.
      this.#set({ status: 'stale', actor: null, reason: e.code ?? 'refresh_failed' });
      emit('ws.reauth', { ok: false });
    }
    return this.#state;
  }

  /** Refresh if the access token is expired or close to it. */
  async ensureFresh(): Promise<string | null> {
    if (this.#state.status === 'authenticated' && this.#session
        && this.#session.expiresAt - this.#now() > REFRESH_SKEW_MS) {
      return this.#session.accessToken;
    }
    const refreshToken = this.#session?.refreshToken ?? await this.#deps.vault.read();
    if (!refreshToken) return null;
    try {
      await this.#adopt(await refreshSession(refreshToken));
      emit('ws.reauth', { ok: true });
      return this.#session?.accessToken ?? null;
    } catch (err) {
      const actor = this.#state.status === 'authenticated' ? this.#state.actor : null;
      this.#set({ status: 'stale', actor, reason: (err as ServerError).code });
      emit('ws.reauth', { ok: false });
      return null;
    }
  }

  /**
   * The ONLY path that clears local credentials. A token expiring must never
   * end up here (invariant: auth failure never clears local data).
   */
  async signOut(): Promise<void> {
    const refreshToken = this.#session?.refreshToken ?? await this.#deps.vault.read();
    // Best effort: revoking server-side is desirable but must not block a
    // local sign-out when offline.
    if (refreshToken) await signOutSession(refreshToken).catch(() => {});
    this.#session = null;
    this.#pendingWorkosToken = null;
    await this.#deps.vault.clear();
    this.#set({ status: 'signed_out' });
  }

  async #adopt(session: OurSession): Promise<void> {
    this.#session = session;
    if (session.refreshToken) await this.#deps.vault.store(session.refreshToken);
    // Enrich with handle and display name; failure here must not undo a
    // successful sign-in.
    let actor = session.actor;
    try { actor = await fetchMe(session.accessToken); } catch { /* keep the ids we have */ }
    this.#set({ status: 'authenticated', actor, expiresAt: session.expiresAt });
  }
}
