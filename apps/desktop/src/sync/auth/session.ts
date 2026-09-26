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
import { assertEdge } from './transitions.ts';
import { createPkce } from './pkce.ts';
import { listenForCallback } from './loopback.ts';
import { buildAuthorizeUrl, exchangeCode, refreshTokens, type Tokens, type WorkOSConfig } from './workos.ts';
import {
  exchangeForSession, createWorkspace, createWorkspaceAuthed, refreshSession,
  switchSession, signOutSession, fetchMe, joinWorkspace,
  ServerError, type Actor, type OurSession, type PendingJoin, type OrgMatch,
} from './relayed.ts';

export type AuthState =
  | { status: 'signed_out' }
  /** Binding the loopback socket. Nothing to cancel yet, and no link to open. */
  | { status: 'authenticating' }
  /**
   * The browser is open and we are waiting on the person in it.
   *
   * A STATE, not a boolean beside the status. It used to be `#attempt`, a second
   * variable tracking the same lifecycle, surfaced to the renderer as a sibling
   * of `auth` — so `authenticated` with a live attempt was representable and
   * meaningless (invariant 63). Six such combinations are now unconstructible.
   */
  | { status: 'awaiting_browser' }
  /** Signed in with WorkOS but no org yet — onboarding must run (§9). */
  | { status: 'needs_workspace'; identity: { email: string; displayName: string };
      handleSuggestions: string[]; pendingJoins: PendingJoin[];
      /** Company orgs their verified email domain admits them to (ORG-DOMAINS.md §4). */
      orgMatches: OrgMatch[] }
  /**
   * `pendingJoins` IS CARRIED HERE TOO, not only on `needs_workspace`.
   *
   * A pending join is a workspace WorkOS says you belong to and we have no
   * actor for — an accepted invitation, seen for the first time. That is not
   * only a first-run condition: somebody who signed up on their own and was
   * invited afterwards is authenticated AND has one. The server has always sent
   * it in both branches and recomputes it on every refresh, precisely so an
   * invitation accepted while signed in appears without signing out.
   *
   * It used to stop here. The field existed on `needs_workspace` alone, so the
   * only construction of this state dropped it, and every renderer that read it
   * had to gate on `needs_workspace` — correctly, given the type. The effect was
   * that anyone who created a workspace before being invited to another could
   * never join the second one: the handle picker was the only thing that could
   * complete a join, and it was unreachable.
   */
  | { status: 'authenticated'; actor: Actor | null; expiresAt: number;
      pendingJoins: PendingJoin[] }
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
  onSession?(session: OurSession, context: { email: string | null }): void | Promise<void>;
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
  /**
   * What renews it, and when it expires — held for exactly as long as the
   * token itself, and never persisted.
   *
   * WorkOS access tokens last minutes. Onboarding can take longer than that —
   * someone reading the join screen, or waiting for their company's domain to
   * be set up — and the token is the proof `/auth/join` and `/auth/workspace`
   * ask for. Without its refresh token, the only way past an expired one was
   * signing in again, which nothing on the screen offered. Once onboarding
   * ends both are dropped, and steady state depends on our server alone.
   */
  #pendingWorkosRefresh: string | null = null;
  #pendingWorkosExpiresAt: number | null = null;
  /**
   * The sign-in currently waiting on a browser.
   *
   * Tracked so it can be ABANDONED. Without this the only exit from
   * `authenticating` was the loopback's five-minute timeout — and a person who
   * closes the browser tab, or never sees it open, is left looking at a dead
   * control for five minutes with no way to start over. Reloading the window
   * does not help either: the attempt lives here, not in the renderer.
   */
  #attempt: { close(): void; url: string } | null = null;
  /**
   * Signing in to ANOTHER account while this one stays usable.
   *
   * Its own lifecycle, not a flag on `#state`: the held session is still the
   * open account's and still refreshing, and `#state` goes on describing it.
   * Routing the attempt through `authenticating` would put a signed-in person
   * on the sign-in screen, and a closed browser tab would sign them out.
   */
  #adding: { close(): void; url: string } | null = null;
  /**
   * What to put back if an added account turns out to need onboarding and the
   * person backs out of it. Held only while that onboarding is on screen.
   */
  #resume: { session: OurSession | null; workspaceId: string | null; state: AuthState } | null = null;
  /**
   * The email WorkOS just authenticated, held from the code exchange to the
   * adoption it leads to — possibly across onboarding — and then handed to
   * storage once. Our server keeps no email (DESIGN §6.2), so this is the one
   * moment the client can learn which address an account is.
   */
  #email: string | null = null;
  #listeners = new Set<(s: AuthState) => void>();
  /** The refresh in flight, if any — see `ensureFresh`. */
  #refreshing: Promise<string | null> | null = null;
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
  /**
   * Where an add-account attempt is, if one is running. `browser` while the
   * person is in it; `onboarding` when the account they chose has no workspace
   * yet and `#state` has become its `needs_workspace`.
   */
  get adding(): 'browser' | 'onboarding' | null {
    return this.#adding ? 'browser' : this.#resume ? 'onboarding' : null;
  }

  onChange(fn: (s: AuthState) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #set(next: AuthState): void {
    // The one chokepoint, so the table has somewhere to be enforced.
    assertEdge(this.#state.status, next.status);
    this.#state = next;
    for (const fn of this.#listeners) fn(next);
  }

  /** Full interactive sign-in: system browser, PKCE, loopback, then our server. */
  async signIn(preferredWorkspaceId?: string): Promise<AuthState> {
    const t0 = this.#now();
    // Starting again supersedes whatever was waiting. Otherwise "try again"
    // would leave the previous listener holding a port for five minutes, and
    // two callbacks could race for one sign-in.
    this.#abandon();
    this.#set({ status: 'authenticating' });
    const pkce = createPkce();
    const listener = await listenForCallback({ state: pkce.state });
    const url = buildAuthorizeUrl(this.#deps.config, pkce, listener.redirectUri);
    this.#attempt = { close: () => listener.close(), url };
    try {
      // AFTER the browser opens, not before: a state that is true one tick
      // early is a state that lies, and the test helper below polls on it.
      await this.#deps.openBrowser(url);
      this.#set({ status: 'awaiting_browser' });
      const { code } = await listener.result;
      const workos = await exchangeCode(this.#deps.config, { code, verifier: pkce.verifier });
      this.#email = workos.user.email || null;

      const result = await exchangeForSession(
        workos.accessToken, this.#deps.deviceId(), preferredWorkspaceId);
      if ('needsWorkspace' in result) {
        // Onboarding needs the WorkOS token again to prove identity to
        // /auth/workspace. Held in memory only, and dropped either way.
        this.#holdPendingWorkos(workos);
        this.#set({ status: 'needs_workspace', identity: result.identity,
                    handleSuggestions: result.handleSuggestions,
                    pendingJoins: result.pendingJoins, orgMatches: result.orgMatches });
        this.#signedIn('needs_workspace', this.#now() - t0);
        return this.#state;
      }
      await this.#adopt(result);
      this.#signedIn('authenticated', this.#now() - t0);
      return this.#state;
    } catch (err) {
      listener.close();
      // A cancel has already reset the state and counted itself; reporting it
      // again as a failure would make deliberate abandonment look like an
      // outage in the sign-in funnel.
      if (this.#attempt === null) throw err;
      this.#set({ status: 'signed_out' });
      this.#signedIn('failed', this.#now() - t0);
      throw err;
    } finally {
      this.#attempt = null;
    }
  }

  /**
   * Is a sign-in waiting on a browser right now?
   *
   * Derived from the state rather than tracked beside it. `#attempt` survives
   * as what it always was — a closer and a url — and no longer doubles as a
   * lifecycle flag.
   */
  get isAwaitingBrowser(): boolean { return this.#state.status === 'awaiting_browser'; }

  /**
   * Abandon the sign-in and return to a usable state.
   *
   * The affordance the five-minute timeout was standing in for. Idempotent, and
   * safe when nothing is in flight — a button that throws when pressed twice is
   * its own bug.
   */
  cancelSignIn(): AuthState {
    if (this.#attempt === null) return this.#state;
    this.#abandon();
    count('auth.signin', { outcome: 'cancelled' });
    this.#set({ status: 'signed_out' });
    return this.#state;
  }

  /**
   * Open the same authorize URL again.
   *
   * The browser may never have appeared — a default browser that failed to
   * launch, a tab opened behind another window, a link dismissed by accident.
   * Reusing the SAME url matters: a fresh one would mint a new PKCE challenge
   * and the listener is bound to this one.
   */
  async reopenBrowser(): Promise<boolean> {
    const url = this.#attempt?.url ?? this.#adding?.url;
    if (!url) return false;
    await this.#deps.openBrowser(url);
    return true;
  }

  #abandon(): void {
    this.#attempt?.close();
    this.#attempt = null;
  }

  /**
   * Sign in to another account, leaving the open one untouched until the new
   * one is in hand.
   *
   * `max_age=0` so AuthKit asks who you are rather than reusing the browser's
   * session — which is the account already open. Resolves with the state after
   * the attempt; a cancel or a failure leaves it exactly as it was.
   *
   * The device id sent is a PROVISIONAL one (`adding` is what tells the
   * resolver): the open account's would tie two accounts together server-side,
   * which STORAGE.md §8 exists to prevent.
   */
  async addAccount(): Promise<AuthState> {
    // `signed_out` is included: an account can be open and rendering with no
    // usable credential — a vault slot the keychain will not decrypt, say —
    // and adding (or re-adding) an account is a way out of that, not a reason
    // to refuse. What is excluded is a sign-in or an onboarding already on screen.
    const from = this.#state.status;
    if (from !== 'authenticated' && from !== 'stale' && from !== 'signed_out') {
      throw new Error('finish or cancel the sign-in already in progress first');
    }
    this.#abandonAdding();
    const pkce = createPkce();
    const listener = await listenForCallback({ state: pkce.state });
    const url = buildAuthorizeUrl(this.#deps.config, pkce, listener.redirectUri, { maxAge: 0 });
    const attempt = { close: () => listener.close(), url };
    this.#adding = attempt;
    this.#notify();
    try {
      await this.#deps.openBrowser(url);
      const { code } = await listener.result;
      const workos = await exchangeCode(this.#deps.config, { code, verifier: pkce.verifier });
      const result = await exchangeForSession(workos.accessToken, this.#deps.deviceId());
      if (this.#adding !== attempt) throw new Error('add account cancelled');
      this.#email = workos.user.email || null;

      if ('needsWorkspace' in result) {
        // The chosen account has no workspace, so it needs onboarding — and for
        // that screen to be the one showing, `#state` has to become its. The
        // open account's credentials are set aside rather than dropped: backing
        // out puts them back (cancelAddAccount), and while they are aside
        // nothing can refresh with them into the middle of onboarding.
        this.#resume = { session: this.#session, workspaceId: this.#workspaceId, state: this.#state };
        this.#adding = null;
        this.#session = null;
        this.#workspaceId = null;
        this.#holdPendingWorkos(workos);
        this.#set({ status: 'needs_workspace', identity: result.identity,
                    handleSuggestions: result.handleSuggestions,
                    pendingJoins: result.pendingJoins, orgMatches: result.orgMatches });
        count('auth.add_account', { outcome: 'needs_workspace' });
        return this.#state;
      }
      // Cleared BEFORE adopting: from here the device id to send is the new
      // account's own, which adoption is about to create.
      this.#adding = null;
      await this.#adopt(result);
      count('auth.add_account', { outcome: 'authenticated' });
      return this.#state;
    } catch (err) {
      listener.close();
      if (this.#adding === attempt) {
        this.#adding = null;
        count('auth.add_account', { outcome: 'failed' });
        this.#notify();
      }
      throw err;
    }
  }

  /**
   * Back out of adding an account: close the browser wait, or leave the
   * onboarding it led to and put the open account back as it was.
   */
  cancelAddAccount(): AuthState {
    if (this.#adding) {
      this.#abandonAdding();
      count('auth.add_account', { outcome: 'cancelled' });
      this.#notify();
      return this.#state;
    }
    const resume = this.#resume;
    if (!resume) return this.#state;
    this.#resume = null;
    this.#dropPendingWorkos();
    this.#email = null;
    this.#session = resume.session;
    this.#workspaceId = resume.workspaceId;
    count('auth.add_account', { outcome: 'cancelled' });
    this.#set(resume.state);
    return this.#state;
  }

  #abandonAdding(): void {
    this.#adding?.close();
    this.#adding = null;
  }

  /** Tell listeners something outside `#state` changed — `adding`, today. */
  #notify(): void {
    for (const fn of this.#listeners) fn(this.#state);
  }

  /**
   * Create an org, workspace and actor.
   *
   * Both onboarding and — once signed in — the way an additional workspace is
   * made, which before invitations exist is the only route to a
   * multi-workspace account (STORAGE.md §10.4).
   */
  async createWorkspace(workspaceName: string, handle: string): Promise<AuthState> {
    const workosToken = await this.#freshWorkosToken();
    if (!workosToken) throw new Error('no pending sign-in — start again');
    const session = await createWorkspace(
      workosToken, this.#deps.deviceId(), workspaceName, handle);
    this.#dropPendingWorkos();
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

  #holdPendingWorkos(workos: Tokens): void {
    this.#pendingWorkosToken = workos.accessToken;
    this.#pendingWorkosRefresh = workos.refreshToken || null;
    this.#pendingWorkosExpiresAt = workos.expiresAt;
  }

  #dropPendingWorkos(): void {
    this.#pendingWorkosToken = null;
    this.#pendingWorkosRefresh = null;
    this.#pendingWorkosExpiresAt = null;
  }

  /**
   * The onboarding WorkOS token, renewed first if it expires within a minute.
   *
   * A failed renewal hands back the old token rather than throwing: the server
   * then refuses it as `invalid_token`, which the screen turns into "sign in
   * again" — one path for every way this can end.
   */
  async #freshWorkosToken(): Promise<string | null> {
    const token = this.#pendingWorkosToken;
    if (!token) return null;
    const exp = this.#pendingWorkosExpiresAt;
    if (exp !== null && exp - this.#now() > 60_000) return token;
    if (!this.#pendingWorkosRefresh) return token;
    try {
      const renewed = await refreshTokens(this.#deps.config, this.#pendingWorkosRefresh);
      if (this.#pendingWorkosToken !== token) return this.#pendingWorkosToken;   // onboarding ended meanwhile
      this.#holdPendingWorkos(renewed);
      count('auth.onboarding_renewed', { result: 'ok' });
    } catch {
      count('auth.onboarding_renewed', { result: 'error' });
    }
    return this.#pendingWorkosToken;
  }

  /**
   * Ask the server again what this person can join (ORG-DOMAINS.md).
   *
   * Onboarding's lists were computed at sign-in. A company whose domain was
   * set up afterwards, or an invitation accepted since, would otherwise stay
   * invisible until a full restart. Should the answer be that they now HAVE a
   * workspace — joined from another device, say — that session is adopted.
   */
  async recheckOnboarding(): Promise<AuthState> {
    if (this.#state.status !== 'needs_workspace') return this.#state;
    const token = await this.#freshWorkosToken();
    if (!token) return this.#state;
    const result = await exchangeForSession(token, this.#deps.deviceId());
    // Onboarding may have ended while we asked — a join landed, or sign-out.
    if (this.#state.status !== 'needs_workspace' || this.#pendingWorkosToken !== token) return this.#state;
    if ('needsWorkspace' in result) {
      this.#set({ ...this.#state, handleSuggestions: result.handleSuggestions,
                  pendingJoins: result.pendingJoins, orgMatches: result.orgMatches });
    } else {
      this.#dropPendingWorkos();
      await this.#adopt(result);
    }
    return this.#state;
  }

  /** True once a WorkOS token is held and onboarding can proceed. */
  get canCreateWorkspace(): boolean { return this.#pendingWorkosToken !== null; }

  /**
   * An additional workspace, for someone already signed in. Authenticated with
   * our own token — no browser round trip for an identity we already hold.
   */
  async createAnotherWorkspace(workspaceName: string, handle: string, orgId?: string): Promise<AuthState> {
    const token = await this.ensureFresh();
    if (!token) throw new Error('not authenticated');
    await this.#adopt(await createWorkspaceAuthed(
      token, this.#deps.deviceId(), workspaceName, handle, orgId));
    return this.#state;
  }

  /**
   * Join a workspace we were admitted to in WorkOS, with a chosen handle.
   *
   * Needs the WorkOS token, which is only held between sign-in and onboarding —
   * so this is reachable from the same window as createWorkspace, and for the
   * same reason: the actor does not exist yet, so there is no session of ours
   * to authenticate with.
   */
  async joinWorkspace(workspaceId: string, handle: string): Promise<AuthState> {
    // Onboarding holds a WorkOS token. Somebody invited AFTER they signed up
    // holds none — it is cleared the moment onboarding completes — but does
    // hold one of our access tokens, for a different workspace. Either proves
    // the same identity, and demanding the first is what made an invitation
    // unacceptable to anyone who had already created a workspace.
    const workosToken = await this.#freshWorkosToken();
    const proof = workosToken
      ? { workosAccessToken: workosToken }
      : this.accessToken ? { bearer: this.accessToken } : null;
    if (!proof) throw new Error('no pending sign-in — start again');
    const session = await joinWorkspace(proof, this.#deps.deviceId(), workspaceId, handle);
    this.#dropPendingWorkos();
    await this.#adopt(session);
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
  async activate(workspaceId: string, opts: { mint?: boolean } = {}): Promise<AuthState> {
    const stored = await this.#deps.vault.read(workspaceId);
    // `mint: false` for a workspace in ANOTHER account: the held session is
    // the previous account's, and /auth/switch with it can only be refused
    // (STORAGE.md §10.2 step 3). A missing slot there means signed out of that
    // workspace, not a first visit to it.
    const source = opts.mint === false ? null : this.#session?.refreshToken ?? null;

    if (!stored && !source) {
      // Counted, because it is otherwise the one silent outcome: the replica
      // renders (R3) and nothing says this account cannot sync. A slot that
      // exists but will not decrypt lands here too (vault.ts).
      count('auth.no_credential');
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

  /**
   * Refresh if the access token is expired or close to it.
   *
   * ONE refresh at a time, shared by every caller that asks while it runs. The
   * server rotates refresh tokens on use, so two concurrent refreshes spend the
   * same token twice: the second is refused, and the session goes stale though
   * nothing was wrong. The socket's reconnect and an HTTP command arriving
   * together is exactly that race.
   */
  async ensureFresh(): Promise<string | null> {
    if (this.#state.status === 'authenticated' && this.#session
        && this.#session.expiresAt - this.#now() > REFRESH_SKEW_MS) {
      return this.#session.accessToken;
    }
    this.#refreshing ??= this.#refresh().finally(() => { this.#refreshing = null; });
    return this.#refreshing;
  }

  /**
   * Refresh even though the token is still good, because something we just
   * changed on the server rides on the membership wire — which workspace is the
   * org's default, who its admins are (ORG-DOMAINS.md). Shares the one
   * in-flight refresh, for the same reason `ensureFresh` does.
   */
  async refreshNow(): Promise<string | null> {
    this.#refreshing ??= this.#refresh().finally(() => { this.#refreshing = null; });
    return this.#refreshing;
  }

  async #refresh(): Promise<string | null> {
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
    this.#abandonAdding();
    this.#resume = null;
    this.#email = null;
    this.#session = null;
    this.#workspaceId = null;
    this.#dropPendingWorkos();
    this.#set({ status: 'signed_out' });
  }

  async #adopt(session: OurSession, workspaceId?: string): Promise<void> {
    // Any adoption ends an add-account onboarding: the new account now exists.
    this.#resume = null;
    this.#session = session;
    this.#workspaceId = workspaceId ?? session.actor?.workspaceId ?? this.#workspaceId;

    // Storage first: the vault slot lives under the account directory, which
    // may not exist yet on a first sign-in.
    // The email rides along exactly once: a refresh adopts too, and has none.
    const email = this.#email;
    this.#email = null;
    await this.#deps.onSession?.(session, { email });

    if (session.refreshToken && this.#workspaceId) {
      await this.#deps.vault.store(this.#workspaceId, session.refreshToken);
    }
    // Enrich with handle and display name; failure here must not undo a
    // successful sign-in.
    let actor = session.actor;
    try { actor = await fetchMe(session.accessToken); } catch { /* keep the ids we have */ }
    this.#set({ status: 'authenticated', actor, expiresAt: session.expiresAt,
                pendingJoins: session.pendingJoins });
  }
}
