// The auth state machine (PHASE-1-IDENTITY.md §7, STORAGE.md §9).
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
//
// Credentials are per (account, workspace): one vault slot each, because a
// session is per-actor and an actor is per-workspace. Switching away from a
// workspace drops its socket and its in-memory access token, and keeps its
// refresh token — which is what makes the workspace you left still drainable
// and still returnable-to offline (STORAGE.md §9).
import { emit, count, histogram } from '@relayed/telemetry';
import { createPkce } from './pkce.ts';
import { listenForCallback } from './loopback.ts';
import { buildAuthorizeUrl, exchangeCode, type WorkOSConfig } from './workos.ts';
import {
  exchangeForSession, createWorkspace, createWorkspaceAuthed, refreshSession,
  switchSession, signOutSession, fetchMe,
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
  /**
   * Resolved per call, not captured. device_id lives in account.db (STORAGE.md
   * §8), which on a first sign-in does not exist yet — a value captured at
   * construction would be the provisional one forever.
   */
  deviceId(): string;
  /** Opens the SYSTEM browser. Never a BrowserWindow — providers refuse embedded webviews. */
  openBrowser(url: string): void | Promise<void>;
  /** One slot per workspace. The account is bound by the caller (STORAGE.md §9). */
  vault: {
    read(workspaceId: string): Promise<string | null>;
    store(workspaceId: string, token: string): Promise<void>;
    clear(workspaceId: string): Promise<void>;
  };
  /**
   * Called with a freshly minted session BEFORE its refresh token is persisted.
   *
   * The ordering is load-bearing: the vault slot path is
   * accounts/<acc>/auth/refresh-<wsp>.bin, so storage must have matched or
   * created the account directory and opened the workspace before anything can
   * be written into it.
   */
  onSession?(session: OurSession): void | Promise<void>;
  now?: () => number;
}

/** Refresh this far ahead of expiry so a live socket never carries a dead token. */
const REFRESH_SKEW_MS = 60_000;

export class Session {
  #state: AuthState = { status: 'signed_out' };
  #session: OurSession | null = null;
  /** Which workspace the held credential belongs to. */
  #workspaceId: string | null = null;
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
  get workspaceId(): string | null { return this.#workspaceId; }

  onChange(fn: (s: AuthState) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #set(next: AuthState): void {
    this.#state = next;
    for (const fn of this.#listeners) fn(next);
  }

  /** Full interactive sign-in: system browser, PKCE, loopback, then our server. */
  async signIn(preferredWorkspaceId?: string): Promise<AuthState> {
    const t0 = this.#now();
    this.#set({ status: 'authenticating' });
    const pkce = createPkce();
    const listener = await listenForCallback({ state: pkce.state });
    try {
      await this.#deps.openBrowser(buildAuthorizeUrl(this.#deps.config, pkce, listener.redirectUri));
      const { code } = await listener.result;
      const workos = await exchangeCode(this.#deps.config, { code, verifier: pkce.verifier });

      const result = await exchangeForSession(
        workos.accessToken, this.#deps.deviceId(), preferredWorkspaceId);
      if ('needsWorkspace' in result) {
        // Onboarding needs the WorkOS token again to prove identity to
        // /auth/workspace. Held in memory only, and dropped either way.
        this.#pendingWorkosToken = workos.accessToken;
        this.#set({ status: 'needs_workspace', identity: result.identity,
                    handleSuggestions: result.handleSuggestions });
        this.#signedIn('needs_workspace', this.#now() - t0);
        return this.#state;
      }
      await this.#adopt(result);
      this.#signedIn('authenticated', this.#now() - t0);
      return this.#state;
    } catch (err) {
      listener.close();
      this.#set({ status: 'signed_out' });
      this.#signedIn('failed', this.#now() - t0);
      throw err;
    }
  }

  /**
   * Create an org, workspace and actor.
   *
   * Both onboarding and — once signed in — the way an additional workspace is
   * made, which before invitations exist is the only route to a
   * multi-workspace account (STORAGE.md §10.4).
   */
  async createWorkspace(workspaceName: string, handle: string): Promise<AuthState> {
    if (!this.#pendingWorkosToken) throw new Error('no pending sign-in — start again');
    const session = await createWorkspace(
      this.#pendingWorkosToken, this.#deps.deviceId(), workspaceName, handle);
    this.#pendingWorkosToken = null;
    await this.#adopt(session);
    return this.#state;
  }

  /**
   * The onboarding funnel. `needs_workspace` is someone who authenticated and
   * has not finished — a rising share means onboarding is losing people, which
   * is invisible from a success/failure count alone.
   */
  #signedIn(outcome: 'authenticated' | 'needs_workspace' | 'failed', ms: number): void {
    count('auth.signin', { outcome });
    histogram('auth.signin.duration', Math.round(ms), { outcome });
    const actor = this.#state.status === 'authenticated' ? this.#state.actor : null;
    emit('auth.signed_in', {
      account: '', device: this.#deps.deviceId(),
      actor: actor?.id ?? '', workspace: this.#workspaceId ?? '',
      outcome, duration: Math.round(ms),
    });
  }

  /** True once a WorkOS token is held and onboarding can proceed. */
  get canCreateWorkspace(): boolean { return this.#pendingWorkosToken !== null; }

  /**
   * An additional workspace, for someone already signed in. Authenticated with
   * our own token — no browser round trip for an identity we already hold.
   */
  async createAnotherWorkspace(workspaceName: string, handle: string): Promise<AuthState> {
    const token = await this.ensureFresh();
    if (!token) throw new Error('not authenticated');
    await this.#adopt(await createWorkspaceAuthed(
      token, this.#deps.deviceId(), workspaceName, handle));
    return this.#state;
  }

  /**
   * Establish credentials for a workspace. Boot and switch both land here.
   *
   * At boot there is no held session, so a missing slot means signed out.
   * Mid-switch there is one, so a missing slot means this workspace has never
   * been opened on this device and is bootstrapped through /auth/switch —
   * once, ever (STORAGE.md §9).
   *
   * Never throws. A failure here is a degraded sync engine, not a failed boot
   * and not a failed switch: the replica is already open and already rendering.
   */
  async activate(workspaceId: string): Promise<AuthState> {
    const stored = await this.#deps.vault.read(workspaceId);
    const source = this.#session?.refreshToken ?? null;

    if (!stored && !source) {
      this.#session = null;
      this.#workspaceId = null;
      this.#set({ status: 'signed_out' });
      return this.#state;
    }

    // `switch` is the first-ever open of this workspace on this device and
    // should happen once, ever. A high switch:refresh ratio means vault slots
    // are being lost and every visit re-mints a session (STORAGE.md §9).
    const path = stored ? 'refresh' as const : 'switch' as const;
    try {
      const next = stored
        ? await refreshSession(stored)
        : await switchSession(source!, workspaceId);
      await this.#adopt(next, workspaceId);
      count('auth.activate', { path, result: 'ok' });
      emit('auth.activated', { account: '', workspace: workspaceId, path, ok: true });
      emit('ws.reauth', { ok: true });
    } catch (err) {
      const e = err as ServerError;
      // 401/403 means the session is genuinely gone; anything else (offline,
      // server down) is temporary. Both leave local data untouched — the
      // difference is only what the banner offers.
      this.#workspaceId = workspaceId;
      this.#set({ status: 'stale', actor: null, reason: e.code ?? 'activate_failed' });
      count('auth.activate', { path, result: 'error' });
      // Local data still works, so users often do not report this state. That
      // is exactly why it needs a counter of its own.
      count('auth.stale');
      emit('auth.activated', { account: '', workspace: workspaceId, path, ok: false });
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
    const workspaceId = this.#workspaceId;
    if (!workspaceId) return null;
    const refreshToken = this.#session?.refreshToken ?? await this.#deps.vault.read(workspaceId);
    if (!refreshToken) return null;
    try {
      await this.#adopt(await refreshSession(refreshToken), workspaceId);
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
   *
   * Every workspace of the account is revoked and cleared, not just the active
   * one: signing out of an account means signing out of all of it.
   */
  async signOut(workspaceIds: readonly string[]): Promise<void> {
    const ids = new Set(workspaceIds);
    if (this.#workspaceId) ids.add(this.#workspaceId);

    for (const id of ids) {
      const token = id === this.#workspaceId
        ? this.#session?.refreshToken ?? await this.#deps.vault.read(id)
        : await this.#deps.vault.read(id);
      // Best effort: revoking server-side is desirable but must not block a
      // local sign-out when offline.
      if (token) await signOutSession(token).catch(() => {});
      await this.#deps.vault.clear(id);
    }

    emit('auth.signed_out', { account: '', workspaces: ids.size });
    this.#session = null;
    this.#workspaceId = null;
    this.#pendingWorkosToken = null;
    this.#set({ status: 'signed_out' });
  }

  async #adopt(session: OurSession, workspaceId?: string): Promise<void> {
    this.#session = session;
    this.#workspaceId = workspaceId ?? session.actor?.workspaceId ?? this.#workspaceId;

    // Storage first: the vault slot lives under the account directory, which
    // may not exist yet on a first sign-in.
    await this.#deps.onSession?.(session);

    if (session.refreshToken && this.#workspaceId) {
      await this.#deps.vault.store(this.#workspaceId, session.refreshToken);
    }
    // Enrich with handle and display name; failure here must not undo a
    // successful sign-in.
    let actor = session.actor;
    try { actor = await fetchMe(session.accessToken); } catch { /* keep the ids we have */ }
    this.#set({ status: 'authenticated', actor, expiresAt: session.expiresAt });
  }
}
