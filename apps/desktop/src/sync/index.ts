// The sync engine. Runs as an Electron utilityProcess (DESIGN.md §5): it owns
// the databases and — from Phase 2 — the WebSocket. Deliberately not the main
// process, because node:sqlite is synchronous and a catch-up batch would stall
// the UI; and deliberately not the renderer, which would make R2 impossible.
//
// Verified in Phase 0: timers here are NOT subject to Chromium's renderer
// throttling (§13.9), which is what protects the 30s heartbeat.
//
// Storage is tiered (STORAGE.md §5): one account.db per account, one replica
// per workspace beneath it, exactly one workspace active at a time.
import {
  emit, count, histogram, span, identify, useOtlpIfConfigured, type Identity,
  type EventName, type MetricName,
} from '@relayed/telemetry';
import { Session, type AuthState } from './auth/session.ts';
import { vault as bridgeVault, browserImport, openBrowser, pickFolder, setBlobAccount, setMenuShortcuts, setThemeSource } from './main-bridge.ts';
import { KEYBINDING_PREFIX } from '../shared/prefs.ts';
import { nativeMenuItems, resolveBindings } from '../shared/shortcuts/resolve.ts';
import { platformOf } from '../shared/shortcuts/tanstack-driver.ts';
import { cacheToolkitLogos, heldToolkitLogos, prefetchAvatars } from './blobs.ts';
import { Storage, type WorkspaceRow } from './storage.ts';
import {
  listInvitations, createInvite, revokeInvite,
  agentHandle, createAgent, updateAgent, deactivateAgent, setAgentMaintainers, addSpaceMember, createSpace, openDm, type SpaceInput,
  stopAgentRun, type AgentInput,
  listToolkits, disconnectConnection,
  grantAgentPermission, revokeAgentPermission, allowAccessRequest,
} from './auth/relayed.ts';
import { connect as connectToolkit } from './connect.ts';
import { newId } from './ids.ts';
import { enqueue } from './outbox.ts';
import { installNetworkGate } from './network.ts';
import { topic, INVALIDATE_CHANNEL } from '../shared/topics.ts';
import { decode } from '../shared/prefs.ts';
import type { PreferenceChange } from './prefs.ts';
import { createInvalidator } from './invalidate.ts';
import { createLink } from './link.ts';
import { createReauth } from './reauth.ts';
import { relayTelemetry } from './telemetry-relay.ts';
import { createRunnerLink } from './runner.ts';
import { LocalStore } from './local/store.ts';
import { createLocalRooms } from './local/rooms.ts';
import { createRoomTitles } from './local/titles.ts';
import { createLocalCommands } from './local/commands.ts';
import * as paths from './paths.ts';
import type { OurSession } from './auth/relayed.ts';
import type { ClaudeStatus } from '../shared/claude.ts';
import { AGENT_STREAM_CHANNEL } from '../shared/local-rooms.ts';
import { AGENT_ACTIVITY_CHANNEL } from '../shared/agent-activity.ts';

interface Request { id: number; op: string; params?: unknown }
type Reply =
  | { id: number; ok: true; data: unknown; epoch: number }
  | { id: number; ok: false; error: string; epoch: number };

useOtlpIfConfigured('desktop');

/**
 * The BOUNDED half of the identity, known before anything is opened.
 *
 * Platform, architecture and channel are a handful of values across the whole
 * fleet, which is what makes them safe on every signal — including metrics,
 * where a resource attribute becomes part of the identifying label set. They
 * answer the question no per-record id can: "is this only happening on
 * Windows", which needs something you can group by.
 *
 * Sent here rather than with the rest, because none of it waits on a database
 * and the first events are emitted milliseconds from now.
 */
identify({
  os: process.platform,
  arch: process.arch,
  env: process.env['RELAYED_DEV'] ? 'development' : 'production',
  // One series per build, on `client.info` alone — never on the resource,
  // where it would multiply every metric by the number of live versions (§5).
  version: process.env['npm_package_version'] ?? 'dev',
});

/**
 * R3, asserted rather than observed (STORAGE.md §17.4, OBSERVABILITY.md §9).
 *
 * "It rendered on a plane" is a story; a count of network calls made before the
 * renderer could paint is a fact. Counting here, in the process that owns every
 * outbound request, is the only place the number can be trusted.
 *
 * Always on, not behind the verify flag: an invariant that is only checked when
 * someone remembers to check it is not instrumented. The URL list stays behind
 * `RELAYED_VERIFY_BOOT=1`, because that is a debugging aid rather than a signal.
 */
const bootT0 = Number(process.env['RELAYED_BOOT_T0'] ?? 0);
/** Boot happens once per process; a port attach does not (see the call site). */
let bootRecorded = false;
/** Likewise the renderer's paint: a window reload paints again. */
let paintRecorded = false;

/**
 * Simulated offline, and R3's counter — the aeroplane without the aeroplane
 * (STORAGE.md §17.3, OBSERVABILITY.md §9).
 *
 * Development builds only for the offline half (see main): a control that can
 * disable the network has no business shipping, even behind a flag nothing
 * renders.
 */
const devTools = Boolean(process.env['RELAYED_DEV']);
const net = installNetworkGate(globalThis, {
  trace: Boolean(process.env['RELAYED_VERIFY_BOOT']),
  // A packaged build gets a wrapper with no offline branch in it at all — the
  // counting half ships, the switch does not.
  allowOffline: devTools,
});

const storage = new Storage(process.env['RELAYED_DATA'] ?? process.cwd());
const boot = storage.boot();

/**
 * Push the stored theme at main (PREFERENCES.md §9).
 *
 * Account-scoped, like `setBlobAccount` — and called beside it everywhere the
 * active account can change, because two accounts on one install each keep
 * their own theme (§4). No account open means no rows, which decodes to the
 * default, which is what main already has.
 */
function applyTheme(): Promise<void> {
  return setThemeSource(decode('appearance.theme', storage.preferences()));
}

/**
 * The menu's shortcuts, from the open account's keybinding rows — or the
 * defaults when there is no account. Sent wherever the theme is, since both are
 * account preferences main applies, and after any keybinding write.
 */
function applyMenuShortcuts(): Promise<void> {
  const platform = platformOf(process.platform);
  const overrides = new Map<string, unknown>();
  for (const row of storage.preferences()) {
    if (!row.key.startsWith(KEYBINDING_PREFIX)) continue;
    try { overrides.set(row.key.slice(KEYBINDING_PREFIX.length), JSON.parse(row.value)); } catch { /* resolves as invalid */ }
  }
  return setMenuShortcuts(nativeMenuItems(resolveBindings(overrides, platform), platform));
}

// EAGER, and deliberately not inside `startSyncing` below.
//
// That deferral exists to keep the network out of the path to first render, and
// this is an IPC message to the process next door — nothing it guards. It has
// the opposite requirement: the window is created in the same tick as this
// process is forked, so anything later than module load risks painting the
// system appearance over somebody's chosen one. Opening SQLite beats booting a
// renderer, so in practice this lands well before `ready-to-show`; §9 records
// why the remaining race is accepted rather than closed.
void applyTheme();
void applyMenuShortcuts();

// What multi-account and multi-workspace were built on assumptions about.
// Sampled at boot because that is when both are known without extra work.
histogram('boot.accounts', boot.accounts.length);
histogram('boot.workspaces', storage.accountId ? storage.workspaces().length : 0);

/**
 * Used only until we know which account this sign-in lands in.
 *
 * A re-authentication of the account we are already looking at reuses ITS
 * device_id, so it does not register as a new device. The gap: re-authenticating
 * some OTHER existing account — after a keychain reset, say — cannot be
 * recognised before the memberships come back, so it adopts this provisional id
 * and leaves the account's previous device row stale. Rare, revocable, and the
 * alternative is an extra round trip on every sign-in.
 *
 * Regenerated once an account adopts it. Held as a process-wide constant it
 * would be handed to the NEXT account created in the same run — so signing out
 * and signing in as a different email would give two accounts one device
 * identity, which is the correlation invariant 38 exists to prevent.
 */
let provisional: string | null = null;
const provisionalDeviceId = (): string => (provisional ??= newId('dev'));

/** Live renderer ports. Multiple windows are normal; dead ones must be reaped. */
const ports = new Set<Electron.MessagePortMain>();

const session = new Session({
  config: { clientId: process.env['WORKOS_CLIENT_ID'] ?? '' },
  deviceId: () => (storage.accountId ? storage.deviceId : provisionalDeviceId()),
  openBrowser,
  vault: {
    read: (wsp) => storage.accountId
      ? bridgeVault.read(storage.accountId, wsp)
      : Promise.resolve(null),
    store: (wsp, token) => storage.accountId
      ? bridgeVault.store(storage.accountId, wsp, token)
      : Promise.resolve(),
    clear: (wsp) => storage.accountId
      ? bridgeVault.clear(storage.accountId, wsp)
      : Promise.resolve(),
  },
  onSession: (s) => adoptSession(s),
});

/**
 * Land a freshly minted session in storage, BEFORE its refresh token is
 * persisted — the vault slot lives under the account directory, which on a
 * first sign-in does not exist yet.
 *
 * Matching is on actor-id intersection, never on a WorkOS identifier: no Layer
 * 1 identity is written to disk (STORAGE.md §5).
 */
function adoptSession(s: OurSession): void {
  // Fall back to the workspace already open. A response that omits `actor` must
  // not silently discard the memberships beside it — belt and braces alongside
  // the server now always sending one.
  const workspaceId = s.actor?.workspaceId ?? storage.workspaceId;
  if (!workspaceId) return;

  if (s.memberships.length > 0) {
    const matched = storage.findAccountByActors(s.memberships.map(m => m.actorId));
    if (matched) {
      storage.openAccount(matched);
    } else {
      storage.openAccount(storage.createAccount(provisionalDeviceId()));
      // Consumed. The next account created in this run gets its own.
      provisional = null;
    }
    storage.syncMemberships(s.memberships);
  } else if (!storage.accountId) {
    // /auth/switch returns no memberships — it is scoped to one workspace and
    // says nothing new about the others. It can only follow a session that
    // already opened an account, so this is unreachable in practice.
    return;
  }

  if (storage.workspaceId !== workspaceId) storage.switchWorkspace(workspaceId);

  // Scope the blob handler to whatever account is now open, then fill the
  // avatar cache. Fire-and-forget: a grey circle is not a failed sign-in.
  // Both run HERE and nowhere else: adoptSession is reached by every path that
  // ends with a usable workspace — boot, switch, sign-in, join — so calling
  // them at those four call sites as well only duplicated the work.
  // THE UNBOUNDED HALF, now that there is something to say. Merged into every
  // event and span from here on, and onto no metric — which is what makes
  // "why did THIS device stall" answerable without touching the series budget.
  //
  // Repeated on every adoption rather than set once: the actor and workspace
  // change on a switch, and stale identity is worse than none because it looks
  // authoritative.
  const active = storage.workspaces()
    .find(w => w.workspaceId === storage.workspaceId);
  // Built by assignment rather than spread: `exactOptionalPropertyTypes` draws
  // a real distinction between a field that is absent and one that is
  // `undefined`, and only the first means "nothing to say".
  const who: Identity = { install: storage.installId, device: storage.deviceId };
  if (storage.accountId) who.account = storage.accountId;
  if (active) { who.actor = active.actorId; who.workspace = active.workspaceId; }
  identify(who);

  void setBlobAccount(storage.accountId);
  // The account may have changed under us, and each one keeps its own theme.
  void applyTheme();
  void applyMenuShortcuts();
  // Whatever this replica ALREADY holds. On a fresh one that is nothing, which
  // is the whole reason `avatarsWanted` exists below: the directory arrives
  // over the socket seconds later, and this call cannot see it.
  void fillAvatars();
  // The directory arrives over the socket now, page by page, and the link is
  // what asks for it. `fetchActors` and `GET /actors` are gone: a client that
  // has just connected needs the directory anyway, so fetching it over HTTP as
  // well was a second path to the same data.
  link.start();
}

/**
 * Ask for the avatars, at most once per burst.
 *
 * The directory pages in — one invalidation per page, and another per
 * `actor.updated` — so a fetch per invalidation would start the same work
 * several times over. A short debounce collapses a snapshot into one pass, and
 * `prefetchAvatars` is idempotent anyway: it links bytes already held rather
 * than downloading them again.
 */
let avatarTimer: ReturnType<typeof setTimeout> | null = null;
function avatarsWanted(): void {
  if (avatarTimer) clearTimeout(avatarTimer);
  avatarTimer = setTimeout(() => { avatarTimer = null; void fillAvatars(); }, 400);
  avatarTimer.unref?.();
}

/** §13.3: avatars are fetched eagerly, always. Failures are silent and retried. */
async function fillAvatars(): Promise<void> {
  if (await prefetchAvatars(storage) === 0) return;
  // Two subjects, two channels. The rail's account-tier avatars ride on
  // AppState; the directory's live on `actors.avatar_blob`, which is a replica
  // read and therefore an invalidation.
  push();
  invalidate([topic.actors()]);
}

/**
 * Pull the workspace directory into the replica.
 *
 * Without it a message author cannot render offline, which is why Phase 2
 * depends on this rather than Phase 1 needing it. Never throws: the directory
 * going stale degrades names, and a failed refresh must not take the read path
 * with it (§13.1).
 */
/**
 * The active workspace's own actor id — who "me" is in the open workspace.
 * `connections` and `agent_permissions` are always this actor's own rows
 * (WORKSPACE-AGENTS.md §6.3, §6.4), so every read and push scoped to "me"
 * resolves through this same lookup.
 */
function activeActorId(): string | null {
  return storage.workspaces().find(w => w.workspaceId === storage.workspaceId)?.actorId ?? null;
}

/**
 * The socket, and everything that arrives on it.
 *
 * Constructed once and started when a workspace is open — the connection itself
 * is idle until then, because there is nothing to authenticate with and nowhere
 * to put what arrives.
 *
 * `guardConnect` runs inside it before any socket is constructed, so simulated
 * offline cuts this as decisively as it cuts fetch. Patching `fetch` catches
 * fetch and nothing else, and half a simulation is worse than none because it
 * looks like it worked.
 */
/**
 * Brings the link back when the server refused its token — see `reauth.ts`.
 * `link` is read when an attempt fires, long after both exist.
 */
const reauth = createReauth({
  refresh: () => session.ensureFresh(),
  held: () => session.accessToken,
  signedOut: () => session.state.status === 'signed_out',
  retryNow: () => { link.retryNow(); },
});

const link = createLink({
  url: (process.env['RELAYED_SERVER_URL'] ?? 'http://127.0.0.1:8787')
    .replace(/^http/, 'ws') + '/sync',
  gate: net,
  db: () => (storage.hasWorkspace ? storage.workspace : null),
  workspaceId: () => storage.workspaceId,
  // Same lookup `messages.send` uses: the replica's own workspace row, not
  // the session — the source of truth for who I am here (SPACE-MEMBERSHIP-MARKERS.md).
  actorId: () => storage.workspaces()
    .find(w => w.workspaceId === storage.workspaceId)?.actorId ?? null,
  // Refreshed when expired, not merely read: a reconnect after the token lapsed
  // under a live socket — a server restart, say — presented it anyway, was
  // refused, and parked in `unauthorised` for good.
  token: () => session.ensureFresh(),
  onState: (state) => { reauth.onState(state); },
  invalidate: (topics) => {
    invalidate(topics);
    // NEW ACTORS MEAN NEW PICTURES, and this is the only place that can know.
    //
    // `fillAvatars` used to run once per session, in `adoptSession` — which was
    // right when the directory arrived synchronously over HTTP and wrong the
    // moment it started arriving over the socket. On a fresh replica the actors
    // table is empty at that point, so the prefetch found nothing, the
    // directory landed seconds later, and nobody ever went back for the bytes.
    // Every face stayed a monogram for the life of the install.
    //
    // Driven off the topic rather than off a directory callback so it covers
    // both ways an actor can appear: a page of the snapshot, and an
    // `actor.created` event arriving live.
    if (topics.some(t => t === topic.actors() || t.startsWith(`${topic.actors()}:`))) {
      avatarsWanted();
    }
  },
  onWelcome: (body) => {
    storage.applyWelcome({
      actorId: body.actor.id,
      spaces: (body.spaces ?? []).map(space => ({
        id: space.id, kind: space.kind, name: space.name, slug: space.slug,
        visibility: space.visibility, membershipPolicy: space.membership_policy,
        lifecycle: space.lifecycle, createdByActorId: space.created_by_actor_id ?? null,
        onBehalfOfActorId: space.on_behalf_of_actor_id ?? null, memberIds: space.member_ids ?? null,
        rev: space.rev,
      })),
      chats: (body.chats ?? []).map(chat => ({
        id: chat.id, spaceId: chat.space_id, kind: chat.kind, name: chat.name,
        headOrd: chat.head_ord, headRev: chat.head_rev,
        chatUnread: chat.chat_unread, threadUnread: chat.thread_unread,
        mentionCount: chat.mention_count,
      })),
      memberships: (body.memberships ?? []).map(m => ({
        scopeType: m.scope_type, scopeId: m.scope_id, role: m.role,
      })),
      connections: (body.connections ?? []).map(c => ({
        id: c.id, toolkit: c.toolkit, status: c.status, statusReason: c.status_reason, label: c.label,
      })),
      agentPermissions: (body.agent_permissions ?? []).map(p => ({
        agentActorId: p.agent_actor_id, toolkit: p.toolkit, effect: p.effect, revoked: p.revoked,
      })),
      panels: body.panels ?? [],
    });
    // Every badge in the sidebar is correct as of this line, with the message
    // table still empty. Waking the surfaces is what makes that visible.
    invalidate([topic.spaces(), topic.actors()]);
  },
  // Forwarded straight to the renderer, exactly as `AGENT_STREAM_CHANNEL` is:
  // never stored, never an invalidation. The renderer applies the `seq` and
  // `ended` rules itself (WORKSPACE-AGENTS.md §5.7).
  onActivity: (activity) => {
    for (const p of ports) p.postMessage({ push: AGENT_ACTIVITY_CHANNEL, data: activity });
  },
  // Both pushes are always the signed-in actor's own rows (§6.3, §6.4) — the
  // same lookup `actorId` above uses, repeated rather than shared: the four
  // other call sites in this file already do the same.
  onConnections: (rows) => {
    const actorId = activeActorId();
    if (!actorId) return;
    storage.applyConnections(actorId, rows.map(c => ({
      id: c.id, toolkit: c.toolkit, status: c.status, statusReason: c.status_reason, label: c.label,
    })));
    invalidate([topic.connections()]);
  },
  onAgentPermissions: (rows) => {
    const actorId = activeActorId();
    if (!actorId) return;
    storage.applyAgentPermissions(actorId, rows.map(p => ({
      agentActorId: p.agent_actor_id, toolkit: p.toolkit, effect: p.effect, revoked: p.revoked,
    })));
    invalidate([topic.agentPermissions()]);
  },
  // `onEvent` is deliberately not passed. It is a test seam now, not the
  // wiring: the engine records every marker through `sync/observe.ts` on the
  // same call, so production needs nothing here and a test that wants to watch
  // gets to without changing what production does (step 13 of the plan).
});

// ── the view the renderer renders ───────────────────────────────────────────

function view() {
  const hasAccount = storage.accountId !== null;
  const workspaces: WorkspaceRow[] = hasAccount ? storage.workspaces() : [];
  const active = workspaces.find(w => w.workspaceId === storage.workspaceId);
  return {
    /**
     * My grants in the ACTIVE workspace, as `scope:id -> role` — the shape
     * `can()` takes (AUTHZ.md §3). Sent as an array because a Map does not
     * survive structured cloning to the renderer intact.
     *
     * `welcome` replaces the active actor's workspace, space and chat rows in
     * one transaction, so this never combines grants from different moments.
     */
    grants: active && storage.hasWorkspace ? storage.grants(active.actorId) : [],
    installId: storage.installId,
    epoch: storage.epoch,
    accountId: storage.accountId,
    accounts: storage.accounts().map(a => ({
      accountId: a.accountId,
      workspaces: a.workspaces.filter(w => w.state === 'active').length,
      lastActiveAt: a.lastActiveAt,
    })),
    workspaceId: storage.workspaceId,
    workspaces,
    // `awaiting_browser` is one of its statuses now, not a boolean beside it —
    // so "is there something to cancel" is answered by the state rather than by
    // a second field that could disagree with it.
    auth: session.state,
    /** Development-only affordances. False in a packaged build, so the UI is absent. */
    devTools,
    offline: net.offline,
    canGoOffline: net.canGoOffline,
    platform: process.platform,
  };
}

function push(): void {
  const data = view();
  for (const p of ports) p.postMessage({ push: 'app:state', data });
}

/**
 * Tell every attached renderer that something it may be reading has changed.
 *
 * Dropped when nothing is attached: a renderer reads on mount anyway, so there
 * is no one to miss it. Coalescing and the flush rule live in `invalidate.ts`.
 */
const invalidate = createInvalidator(({ invalidation, topics }) => {
  count('sync.invalidate');
  // One event per distinct ROOT rather than one carrying the list: the
  // catalogue has no free-text field, deliberately, and a root is a closed set
  // where a full topic is not. They share the batch id, so filtering on it
  // still reassembles the whole push.
  const perRoot = new Map<string, number>();
  for (const changed of topics) {
    const root = changed.split(':')[0] ?? changed;
    perRoot.set(root, (perRoot.get(root) ?? 0) + 1);
  }
  for (const [root, under] of perRoot) {
    emit('sync.invalidated', { invalidation, root, topics: under, ports: ports.size });
  }

  if (ports.size === 0) return;
  const data = { invalidation, topics };
  for (const p of ports) p.postMessage({ push: INVALIDATE_CHANNEL, data });
  // `grants` rides on AppState, not on a query, so an invalidation alone never
  // reaches it. Every write to the replica's own memberships (a space created
  // or joined, `welcome`) invalidates `spaces` — without this, a channel you
  // just created hides its admin affordances until something else pushes.
  if (topics.includes(topic.spaces())) push();
});

session.onChange((_state: AuthState) => push());

// ── the agent runner (LOCAL-ROOMS.md §5) ────────────────────────────────────

/**
 * The open account's local rooms (LOCAL-ROOMS.md §4), opened on first use and
 * reopened when the account changes. Account-tier on purpose: a workspace
 * switch does not touch it, so a reply being written survives one.
 */
let local: { accountId: string; store: LocalStore } | null = null;

function localStore(): LocalStore | null {
  const accountId = storage.accountId;
  if (local?.accountId === accountId) return local.store;
  local?.store.close();
  local = accountId ? { accountId, store: LocalStore.open(paths.localRoomsDb(storage.root, accountId)) } : null;
  return local?.store ?? null;
}

function closeLocalStore(): void {
  local?.store.close();
  local = null;
}

/** The runner's port, handed over by main whenever either process starts. */
const runner = createRunnerLink({
  onEvent: event => { localRooms.onEvent(event); localCommands.onEvent(event); },
  onDetach: () => localRooms.onDetach(),
});

/**
 * Room names (titles.ts). Every step is on; a preference for turning automatic
 * naming off becomes `policy`, read at the moment a room's first message lands.
 */
const roomTitles = createRoomTitles({
  store: localStore,
  runner,
  invalidate: topics => invalidate(topics),
});

const localCommands = createLocalCommands({ store: localStore, runner, invalidate: topics => invalidate(topics) });

const localRooms = createLocalRooms({
  store: localStore,
  runner,
  invalidate: topics => invalidate(topics),
  putBlob: (id, bytes) => { if (!storage.hasBlob(id)) storage.putBlob(id, bytes); },
  // Fired and forgotten: the seed is written before this returns, the generated title whenever it arrives.
  onFirstMessage: (spaceId, text) => { void roomTitles.onFirstMessage(spaceId, text); },
  // Live text, straight to every window. Not an invalidation: nothing was written.
  stream: data => { for (const p of ports) p.postMessage({ push: AGENT_STREAM_CHANNEL, data }); },
  pickFolder,
});

/**
 * The last probe's answer, kept for the life of this process.
 *
 * Probing starts a Claude Code child, so a read does not do it every time the
 * settings screen mounts: the first read probes, later reads return this, and
 * `claude.refresh` probes again. Not stored on disk — whether Claude Code is
 * installed is a fact about the machine now, not something to remember.
 */
let claudeStatus: ClaudeStatus | null = null;

async function probeClaude(): Promise<ClaudeStatus> {
  try {
    claudeStatus = await runner.request('claude.status', undefined);
  } catch (error) {
    // The runner being down is a state the screen shows, not a failed read.
    claudeStatus = {
      state: 'error', binary: null, version: null, checkedAt: Date.now(),
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  invalidate([topic.claude()]);
  return claudeStatus;
}

// ── handlers ────────────────────────────────────────────────────────────────

/**
 * The slugs and logo sources of the last catalogue read, for `toolkits.logos`.
 * Memory only: the catalogue is online-only (WORKSPACE-AGENTS.md §7.1), and
 * the bytes it points at are what persist.
 */
let lastCatalogue: { slug: string; logoUrl: string | null }[] = [];
/** One download pass at a time; reopening the store while one runs does not start another. */
let logoPass: Promise<void> | null = null;

function fetchMissingLogos(): void {
  if (logoPass) return;
  const held = new Set(heldToolkitLogos(storage, lastCatalogue).map(logo => logo.slug));
  const missing = lastCatalogue.filter(toolkit => !held.has(toolkit.slug));
  if (missing.length === 0) return;
  logoPass = cacheToolkitLogos(storage, missing)
    .then(stored => { if (stored > 0) invalidate([topic.toolkitLogos()]); })
    .catch(() => { /* a mark that fails to download is initials */ })
    .finally(() => { logoPass = null; });
}

const handlers: Record<string, (params?: unknown) => unknown | Promise<unknown>> = {
  ping: () => ({ pong: true, at: Date.now() }),
  'app.state': () => view(),
  'ports.live': () => ({ count: ports.size }),

  /**
   * Cut or restore the network for this process. Development only.
   *
   * Coming back online re-activates deliberately: a `stale` session would
   * otherwise sit there until the next refresh, which makes the toggle look
   * one-way and hides whether recovery actually works.
   */
  'dev.setOffline': async (params) => {
    if (!devTools) throw new Error('development builds only');
    // The gate notifies the transport, which drops any live socket rather than
    // merely refusing the next one — see `network.ts`. Nothing to stop here.
    net.setOffline(Boolean((params as { offline?: boolean })?.offline));
    emit('dev.offline', { offline: net.offline });
    push();
    if (!net.offline && storage.workspaceId) {
      await session.activate(storage.workspaceId);
      // AFTER the token, and deliberately a second nudge. Lifting the gate
      // already asked the transport to retry, but that happened before
      // `activate` had a credential — so a session that went stale while the
      // network was cut would reconnect with nothing and land in
      // `unauthorised`, where it waits for exactly this call.
      link.retryNow();
      push();
    }
    return view();
  },

  /** The workspace directory, straight from the replica — no network. */
  'actors.list': () => (storage.hasWorkspace ? storage.actors() : []),

  /** The sidebar: spaces this actor is in, each with its chats. */
  'spaces.list': () => (storage.hasWorkspace ? storage.spaces() : []),

  /** The connector store's Yours list, straight from the replica — no network (WORKSPACE-AGENTS.md §6.3). */
  'connections.list': () => {
    const actorId = activeActorId();
    return storage.hasWorkspace && actorId ? storage.connections(actorId) : [];
  },
  /** Which agents this actor has allowed, and at what effect (§6.4). */
  'agentPermissions.list': () => {
    const actorId = activeActorId();
    return storage.hasWorkspace && actorId ? storage.agentPermissions(actorId) : [];
  },

  /** One space and its chats. An array, as every read is: one row, or none. */
  /** One synced room's shared panels, from the replica (PANELS.md). */
  'panels.list': (params) => {
    const spaceId = (params as { spaceId?: string } | undefined)?.spaceId;
    return spaceId && storage.hasWorkspace ? storage.panels(spaceId) : [];
  },
  'space.get': (params) => {
    const spaceId = (params as { spaceId?: string } | undefined)?.spaceId;
    const space = spaceId && storage.hasWorkspace ? storage.space(spaceId) : null;
    return space ? [space] : [];
  },

  /**
   * The person's Claude Code, as one row: not installed, signed out, ready, or
   * an error (LOCAL-ROOMS.md §3.2). An array because every read in the
   * catalogue returns rows.
   */
  'claude.status': async () => [claudeStatus ?? await probeClaude()],

  /** Probe again — after the person installs Claude Code or signs in, say. */
  'claude.refresh': async () => { await probeClaude(); return null; },

  // ── browser import (PANELS.md) — main does the work; only a person in settings starts it
  'browserImport.sources': () => browserImport.sources(),
  'browserImport.run': (params) => {
    const { sourceId, directory } = (params ?? {}) as { sourceId?: unknown; directory?: unknown };
    if (typeof sourceId !== 'string' || typeof directory !== 'string') throw new Error('sourceId and directory required');
    return browserImport.run(sourceId, directory);
  },
  'browserImport.clear': () => browserImport.clear(),
  'browserImport.openFullDiskAccess': () => browserImport.openFullDiskAccess(),

  // ── local rooms (LOCAL-ROOMS.md §7–§8) ─────────────────────────────────
  ...localRooms.handlers,
  ...roomTitles.handlers,
  ...localCommands.handlers,

  /** One chat's tail. Everything below it is backfill's job, on demand. */
  'messages.list': (params) => {
    const chatId = (params as { chatId?: string } | undefined)?.chatId;
    if (!chatId || !storage.hasWorkspace) return [];
    return storage.messages(chatId);
  },

  /** The root composer draft is local to this replica and never enters sync. */
  'drafts.get': (params) => {
    const chatId = (params as { chatId?: string } | undefined)?.chatId;
    if (!chatId || !storage.hasWorkspace) return [];
    const row = storage.workspace.prepare(`
      SELECT chat_id, body, revision, updated_at FROM drafts
       WHERE chat_id = ? AND draft_kind = 'compose' AND context_key = 'root'
    `).get(chatId) as { chat_id: string; body: string; revision: number; updated_at: number } | undefined;
    return row ? [{ chatId: row.chat_id, body: row.body, revision: row.revision, updatedAt: row.updated_at }] : [];
  },

  'drafts.save': (params) => {
    const { chatId, body, revision } = (params ?? {}) as { chatId?: string; body?: string; revision?: number };
    if (!chatId || typeof revision !== 'number' || revision < 1) throw new Error('chatId and positive revision required');
    if (!storage.hasWorkspace) throw new Error('no workspace open');
    if ((body ?? '').trim().length === 0) {
      storage.workspace.prepare("DELETE FROM drafts WHERE chat_id = ? AND draft_kind = 'compose' AND context_key = 'root'")
        .run(chatId);
    } else {
      storage.workspace.prepare(`
        INSERT INTO drafts (chat_id, draft_kind, context_key, body, revision, updated_at)
        VALUES (?, 'compose', 'root', ?, ?, ?)
        ON CONFLICT(chat_id, draft_kind, context_key) DO UPDATE SET
          body = excluded.body, revision = excluded.revision, updated_at = excluded.updated_at
        WHERE excluded.revision >= drafts.revision
      `).run(chatId, body ?? '', revision, Date.now());
    }
    invalidate([topic.draft(chatId)]);
    return null;
  },

  /**
   * Compose a message.
   *
   * THE FIRST CALLER THE OUTBOX HAS EVER HAD. Everything below this line was
   * built in step 11 and exercised only by tests and the load run; this is the
   * path a person takes.
   *
   * Returns once the row is ON DISK, never when it is sent. The outbox is
   * durable and the socket is not — waiting on the network here would make
   * composing fail while offline, which is the one thing this app must not do
   * (DESIGN.md §10). `drain` puts it on the wire if there is a wire.
   *
   * The optimistic row and the outbox entry are written in ONE transaction
   * (invariant 40). A crash between them leaves a message that looks sent and
   * never will be — indistinguishable, to the person who wrote it, from having
   * been delivered.
   */
  'messages.send': async (params) => {
    const { chatId, body, draftRevision } = (params ?? {}) as { chatId?: string; body?: string; draftRevision?: number };
    const text = (body ?? '').trim();
    if (!chatId || text.length === 0) throw new Error('chatId and body required');
    if (!storage.hasWorkspace) throw new Error('no workspace open');
    // From the workspace ROW, not the session: the replica is the source of
    // truth for who I am in this workspace, and it is what every other read
    // here joins against. A session-derived id would be a second answer.
    const actorId = storage.workspaces()
      .find(w => w.workspaceId === storage.workspaceId)?.actorId;
    if (!actorId) throw new Error('not signed in');

    const db = storage.workspace;
    const messageId = newId('msg');

    // A span per composed message, and the ROOT of the send's trace: the
    // server's `sync.op` becomes a child of it through the traceparent stored
    // on the outbox row, so "user pressed send" and "server assigned the
    // ordinal" are one trace rather than two that happen to be near in time.
    await span('ui.compose', () => {
      enqueue(db, {
        opId: newId('op'), kind: 'send', chatId, targetId: messageId,
        payload: { body: text, parent_id: null },
      }, (tx) => {
        tx.prepare(`
          INSERT INTO messages (id, chat_id, parent_id, ord, rev, author_id, body,
                                created_at, state, local_only)
          VALUES (?, ?, NULL, NULL, 0, ?, ?, ?, 'pending', 0)
        `).run(messageId, chatId, actorId, text, Date.now());
        if (draftRevision !== undefined) {
          tx.prepare(`
            DELETE FROM drafts WHERE chat_id = ? AND draft_kind = 'compose'
              AND context_key = 'root' AND revision = ?
          `).run(chatId, draftRevision);
        }
      });
    }, { attributes: { chat_id: chatId, op_kind: 'send' } });

    // The surface repaints from the replica, exactly as it would for a message
    // that arrived from somebody else. One path, not a special case for "mine".
    invalidate([topic.messages(chatId), topic.chatState(chatId), topic.draft(chatId)]);
    link.drain();
    return { id: messageId };
  },

  // ── preferences (PREFERENCES.md §8) ────────────────────────────────────

  /**
   * Every preference, undecoded.
   *
   * ONE read for all of them rather than one per key. The table holds tens of
   * rows at most — a missing row is the default and defaults are never written,
   * and keyboard shortcuts add one per customized command — so a per-key query
   * would be that many subscriptions and reads to save nothing,
   * and one shared entry means two surfaces reading the same key share a fetch.
   *
   * Decoding happens in the renderer, against the same shared catalogue this
   * side validates writes with: a value this build cannot parse has to fall
   * back rather than fail, and the fallback is the catalogue's.
   */
  'prefs.list': () => storage.preferences(),

  /**
   * Change one preference.
   *
   * VALIDATED HERE, not only at the control that offered the value. The
   * renderer is a surface and not an authority, and the catalogue is the same
   * file on both sides — so there is one rule and one implementation of it.
   * An unknown key or a value outside its domain throws.
   */
  'prefs.set': async (params) => {
    const { key, value } = (params ?? {}) as { key?: string; value?: unknown };
    if (!key) throw new Error('key required');
    storage.setPreference(key, value);
    if (key.startsWith(KEYBINDING_PREFIX)) void applyMenuShortcuts();
    // The one preference that also lives outside the database (§9). Gated on
    // the key rather than run unconditionally, so adding a preference does not
    // quietly add an IPC round trip to every write.
    //
    // AWAITED, AND BEFORE THE INVALIDATION. The renderer resolves `system`
    // against `prefers-color-scheme`, which is what `themeSource` drives — so
    // waking it before main has applied the new value hands it the window's
    // OLD appearance to resolve against. Ordering the two removes that race
    // rather than papering over it with a delay.
    if (key === 'appearance.theme') await applyTheme();
    // Written fine, subscribed coarse: this names the key, and a reader
    // subscribed to `prefs` is woken by the prefix rule in topics.ts.
    invalidate([topic.pref(key)]);
    return null;
  },

  /**
   * Return one preference to its default by deleting its row — reset, as
   * distinct from a set to an empty keybinding list, which disables
   * (SHORTCUTS.md §9.1). Same key authorization as `prefs.set`.
   */
  'prefs.clear': async (params) => {
    const { key } = (params ?? {}) as { key?: string };
    if (!key) throw new Error('key required');
    storage.clearPreference(key);
    if (key.startsWith(KEYBINDING_PREFIX)) void applyMenuShortcuts();
    if (key === 'appearance.theme') await applyTheme();
    invalidate([topic.pref(key)]);
    return null;
  },

  /**
   * Several sets and clears, committed together or not at all. What
   * "Replace existing" and "Reset all shortcuts" need, because a two-write
   * sequence can fail halfway (SHORTCUTS.md §9.2). A hard keybinding conflict
   * rejects the whole batch with a message starting `keybinding conflict`.
   */
  'prefs.apply': async (params) => {
    const { changes } = (params ?? {}) as { changes?: PreferenceChange[] };
    if (!Array.isArray(changes)) throw new Error('changes required');
    storage.applyPreferences(changes);
    const keys = changes.map(change => change.key);
    if (keys.some(key => key.startsWith(KEYBINDING_PREFIX))) void applyMenuShortcuts();
    if (keys.includes('appearance.theme')) await applyTheme();
    invalidate(keys.map(key => topic.pref(key)));
    return null;
  },

  'db.info': () => {
    if (!storage.hasWorkspace) return { open: false };
    const db = storage.workspace;
    const uv = db.prepare('PRAGMA user_version').get() as { user_version: number };
    const av = db.prepare('SELECT * FROM pragma_auto_vacuum()').get() as Record<string, number>;
    const jm = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    const tables = db.prepare(
      "SELECT count(*) c FROM sqlite_master WHERE type='table'").get() as { c: number };
    return {
      open: true,
      accountId: storage.accountId,
      workspaceId: storage.workspaceId,
      schemaVersion: uv.user_version,
      autoVacuum: Object.values(av)[0],
      journalMode: jm.journal_mode,
      tables: tables.c,
      sqlite: (db.prepare('select sqlite_version() v').get() as { v: string }).v,
      node: process.versions.node,
      pid: process.pid,
    };
  },

  // ── auth (PHASE-1-IDENTITY.md §7) ──────────────────────────────────────
  'auth.state': () => session.state,
  'auth.signIn': async () => {
    // Opens the SYSTEM browser and blocks on the loopback callback — for up to
    // five minutes. The renderer must NOT wait on this reply to know what is
    // happening: state is pushed, so a window that reloads mid-sign-in still
    // renders the right thing.
    try {
      await session.signIn(storage.workspaceId ?? undefined);
    } catch (e) {
      // A cancelled or timed-out attempt is an ordinary outcome, not an error
      // worth an alert dialog. The pushed state already says signed_out.
      if (!/cancel|timed out/i.test((e as Error).message)) throw e;
    }
    push();
    return view();
  },
  /** Abandon a sign-in waiting on a browser that is not coming back. */
  'auth.cancelSignIn': () => { session.cancelSignIn(); push(); return view(); },
  /** Re-open the same authorize URL — the browser may never have appeared. */
  'auth.reopenBrowser': async () => ({ reopened: await session.reopenBrowser() }),
  'auth.signOut': async () => {
    const accountId = storage.accountId;
    const ids = accountId ? storage.workspaces().map(w => w.workspaceId) : [];

    // signOut() flips auth state, which pushes. That push necessarily describes
    // a half-finished sign-out: credentials gone, storage still on disk. The
    // authoritative push is the one at the end of this handler.
    await session.signOut(ids);

    // §13: sign-out wipes the database and blob directory. With this layout
    // that is one directory delete, which cannot be half-completed. The local
    // rooms file lives in that directory, so its handle is closed first.
    if (accountId) {
      closeLocalStore();
      storage.deleteAccount(accountId);
    }
    void setBlobAccount(storage.accountId);

    // Another account may still be signed in on this device; boot picks it up.
    const next = storage.boot();
    if (next.workspaceId) void session.activate(next.workspaceId);
    // AFTER boot, not beside the setBlobAccount above: whichever account it
    // just adopted owns the theme now, and signing out of the last one leaves
    // no rows at all, which correctly decodes back to the system default.
    void applyTheme();
    void applyMenuShortcuts();

    push();
    return view();
  },
  'auth.createWorkspace': async (params) => {
    const p = params as { workspaceName: string; handle: string };
    // Onboarding holds a WorkOS token; a signed-in user creating an additional
    // workspace does not, and does not need one (§10.4).
    if (session.canCreateWorkspace) await session.createWorkspace(p.workspaceName, p.handle);
    else await session.createAnotherWorkspace(p.workspaceName, p.handle);
    push();
    return view();
  },
  'auth.configured': () => ({ clientId: (process.env['WORKOS_CLIENT_ID'] ?? '').slice(0, 14) || null }),

  // ── invitations (AUTHZ.md §9) ──────────────────────────────────────────
  // The renderer never holds a token, so every one of these is proxied through
  // the process that does (DESIGN.md §13.1).
  'invite.list': async () => {
    const token = await session.ensureFresh();
    if (!token) return { invitations: [], offline: true };
    return { ...(await listInvitations(token)), offline: false };
  },
  'invite.create': async (params) => {
    const token = await session.ensureFresh();
    if (!token) throw new Error('offline — an invitation cannot be queued');
    return createInvite(token, (params as { email: string }).email);
  },
  'invite.revoke': async (params) => {
    const token = await session.ensureFresh();
    if (!token) throw new Error('offline');
    return revokeInvite(token, (params as { id: string }).id);
  },
  // A live command, not an outbox item: membership changes who may receive the
  // next event, so the server must decide it now. Its event updates replicas.
  'spaces.create': async (params) => {
    const input = params as SpaceInput;
    if (input.workspaceId !== storage.workspaceId) throw new Error('Workspace changed. Reopen the dialog.');
    const token = await session.ensureFresh();
    if (!token) throw new Error('Could not refresh your session. Reconnect or sign in again to create a channel or room.');
    return createSpace(token, input);
  },
  'dms.open': async (params) => {
    const input = params as { workspaceId: string; actorIds: string[] };
    if (input.workspaceId !== storage.workspaceId) throw new Error('Workspace changed. Start the conversation again.');
    const token = await session.ensureFresh();
    if (!token) throw new Error('Could not refresh your session. Reconnect or sign in again to start a conversation.');
    return openDm(token, input);
  },
  'spaces.addMember': async (params) => {
    const { spaceId, actorId } = params as { spaceId: string; actorId: string };
    const token = await session.ensureFresh();
    if (!token) throw new Error('offline — a space member cannot be added');
    return addSpaceMember(token, spaceId, actorId, newId('msg'));
  },
  // ── agents (WORKSPACE-AGENTS.md §4) ────────────────────────────────────
  // Refusals come back as answers ({ ok: false, field, reason }) so the editor
  // can draw them beside the field; only being offline throws. The directory
  // event the server delivers after a write is what updates every list — none
  // of these invalidates anything itself.
  'agents.handle': async (params) => {
    const p = params as { handle: string; except?: string };
    const token = await session.ensureFresh();
    if (!token) throw new Error('offline');
    return agentHandle(token, p.handle, p.except);
  },
  'agents.create': async (params) => {
    const token = await session.ensureFresh();
    if (!token) throw new Error('offline — an agent cannot be created offline');
    return createAgent(token, params as AgentInput);
  },
  'agents.update': async (params) => {
    const { agentId, ...input } = params as AgentInput & { agentId: string };
    const token = await session.ensureFresh();
    if (!token) throw new Error('offline — changes to an agent cannot be queued');
    return updateAgent(token, agentId, input);
  },
  'agents.deactivate': async (params) => {
    const token = await session.ensureFresh();
    if (!token) throw new Error('offline');
    return deactivateAgent(token, (params as { agentId: string }).agentId);
  },
  'agents.setMaintainers': async (params) => {
    const p = params as { agentId: string; actorIds: string[] };
    const token = await session.ensureFresh();
    if (!token) throw new Error('offline');
    return setAgentMaintainers(token, p.agentId, p.actorIds);
  },
  /**
   * An agent's instructions, over the socket, online only. Null when the socket
   * is not live or does not answer in time — "unreachable", which is not the
   * same as `found: false`.
   */
  'agents.definition': async (params) => link.definition((params as { agentId: string }).agentId),
  /** Stop a run in flight, invoker-only (WORKSPACE-AGENTS.md §5.8). */
  'agents.stopRun': async (params) => {
    const token = await session.ensureFresh();
    if (!token) throw new Error('offline');
    return stopAgentRun(token, (params as { runId: string }).runId);
  },

  // ── connections, through Composio (WORKSPACE-AGENTS.md §6) ────────────────

  /** The offered catalogue, online-only (§7.1) — the same offline shape `invite.list` uses. */
  'toolkits.list': async () => {
    const token = await session.ensureFresh();
    if (!token) return { toolkits: [], offline: true };
    const catalogue = await listToolkits(token);
    lastCatalogue = catalogue.toolkits.map(({ slug, logoUrl }) => ({ slug, logoUrl }));
    // The list goes back now; marks are `toolkits.logos`, which reads only
    // what is on disk and wakes as each download lands.
    invalidate([topic.toolkitLogos()]);
    fetchMissingLogos();
    // Without `logoUrl`: the renderer never holds a remote image address.
    return { toolkits: catalogue.toolkits.map(({ logoUrl: _remote, ...toolkit }) => toolkit), offline: false };
  },
  /** The catalogue's marks this account already holds. Local only, so it answers offline too. */
  'toolkits.logos': () => (storage.accountId ? heldToolkitLogos(storage, lastCatalogue) : []),
  /**
   * Listens, asks the server to start a connection, opens the result in the
   * system browser, and resolves once the account is ACTIVE (§6.5) — slow,
   * by design: it waits on the person, not on us.
   */
  'connections.connect': async (params) => {
    const p = params as { toolkit: string; accessRequestId?: string };
    const token = await session.ensureFresh();
    if (!token) throw new Error('offline — connecting needs the server');
    const result = await connectToolkit(openBrowser, token, p.toolkit, p.accessRequestId);
    return result.ok
      ? { ok: true, connectionId: result.connectionId, status: result.status }
      : { ok: false, status: 0, error: result.reason };
  },
  'connections.disconnect': async (params) => {
    const token = await session.ensureFresh();
    if (!token) throw new Error('offline');
    return disconnectConnection(token, (params as { connectionId: string }).connectionId);
  },
  'permissions.grant': async (params) => {
    const p = params as { agentId: string; toolkit: string };
    const token = await session.ensureFresh();
    if (!token) throw new Error('offline');
    return grantAgentPermission(token, p.agentId, p.toolkit);
  },
  'permissions.revoke': async (params) => {
    const p = params as { agentId: string; toolkit: string };
    const token = await session.ensureFresh();
    if (!token) throw new Error('offline');
    return revokeAgentPermission(token, p.agentId, p.toolkit);
  },
  /** The card's own Allow (§7.4) — the same grant as `permissions.grant`, reached from the request instead of the connector store. */
  'access.allow': async (params) => {
    const token = await session.ensureFresh();
    if (!token) throw new Error('offline');
    return allowAccessRequest(token, (params as { requestId: string }).requestId);
  },

  'auth.join': async (params) => {
    const p = params as { workspaceId: string; handle: string };
    await session.joinWorkspace(p.workspaceId, p.handle);
    push();
    return view();
  },

  /** Everything on disk. Debug only — see Storage.debug(). */
  'debug.snapshot': () => storage.debug(),

  /**
   * Invariant 41, reported from the preload — the only place that knows a reply
   * was superseded. A small spike per switch is correct; a sustained rate means
   * the epoch is wrong and the UI is discarding work it should have shown.
   */
  'telemetry.staleDropped': () => { count('ipc.stale_dropped'); return null; },

  /**
   * The renderer's telemetry, emitted here (OBSERVABILITY.md §3).
   *
   * Validation and the drop accounting live in `telemetry-relay.ts`, where they
   * can be tested against malformed input directly.
   */
  'telemetry.emit': (params) => {
    relayTelemetry(params, {
      event: (name, fields) => emit(name as EventName, fields as never),
      count: (name, labels) => count(name as MetricName, labels as never),
      histogram: (name, value, labels) => histogram(name as MetricName, value, labels as never),
      dropped: (n) => count('ui.telemetry.dropped', n),
    });
    return null;
  },

  /**
   * The renderer painted. Only this side knows when the app started, so the
   * duration is computed here from the renderer's timestamp.
   *
   * Once per process, for the same reason app.boot is: a window reload paints
   * again while bootT0 still points at process start, and one sample of
   * "twenty-five minutes to first paint" moves every percentile on the R3 panel.
   */
  'telemetry.firstPaint': (params) => {
    if (paintRecorded || bootT0 <= 0) return null;
    paintRecorded = true;
    const at = (params as { at?: number })?.at ?? Date.now();
    const had = storage.accountId ? 'yes' : 'no';
    histogram('ui.paint', at - bootT0, { had_account: had });
    emit('ui.first.paint', { to_first_paint: at - bootT0, from_local: had === 'yes' });
    return null;
  },

  // ── workspaces (STORAGE.md §12.2) ──────────────────────────────────────
  'workspace.switch': (params) => {
    const { workspaceId } = params as { workspaceId: string };
    if (workspaceId === storage.workspaceId) return view();

    // Two phases, timed separately and deliberately (STORAGE.md §12.2).
    //
    // `local` is everything the user waits on: the durable write, closing one
    // replica, opening the next, and the repaint. It must stay flat.
    // `authorized` is the token and socket work that follows, is allowed to be
    // slow, and is unbounded when offline. One number covering both would hide
    // a regression in the half that matters.
    const t0 = performance.now();
    let result: 'ok' | 'error' = 'ok';
    try {
      // STEP 3: CLOSE THE SOCKET, and it must happen BEFORE the replica moves.
      //
      // The comment here used to say "none exists until Phase 2", which stopped
      // being true and stopped being noticed. What it left is worse than the
      // empty directory that exposed it: the link resolves its database through
      // `storage.workspace`, so a connection still authenticated for the old
      // workspace goes on delivering that workspace's events INTO THE NEW
      // REPLICA. Rows from a tenant you are no longer looking at, written to a
      // tenant you are — with the frontier advancing as if they belonged.
      //
      // Stopping first makes that window empty rather than small. The token for
      // the next workspace does not exist yet anyway (step 7 mints it), so
      // there is nothing to reconnect with until `activate` resolves.
      link.stop();
      // Steps 2, 4 and 5 are storage's, and commit `last_workspace` before
      // touching a handle.
      storage.switchWorkspace(workspaceId);
    } catch (e) {
      result = 'error';
      histogram('workspace.switch', Math.round(performance.now() - t0),
                { phase: 'local', result });
      throw e;
    }
    histogram('workspace.switch', Math.round(performance.now() - t0),
              { phase: 'local', result });

    // Step 7 is deliberately not awaited — a switch must complete offline, and
    // activate() resolves to `stale` rather than throwing when it cannot reach
    // the server.
    const t1 = performance.now();
    void span('workspace.authorize', () => session.activate(workspaceId))
      .then((state) => {
        histogram('workspace.switch', Math.round(performance.now() - t1),
                  { phase: 'authorized', result: state.status === 'stale' ? 'error' : 'ok' });
        // STEP 8: reconnect, now that there is a credential for this workspace.
        //
        // Only on success. A `stale` session has no usable token, and starting
        // the link would open a socket that can only be refused — a reconnect
        // loop against a server already saying no. It stays down until
        // something with a better token calls `retryNow`, which is what the
        // aeroplane toggle and waking from sleep already do.
        //
        // `welcome` is what fills the new replica: spaces, chats, every stream
        // cursor and the directory. Without this the workspace you switched to
        // stays empty for ever, which is exactly how this was found.
        if (state.status !== 'stale') link.start();
      });
    return view();
  },
};

function attach(port: Electron.MessagePortMain) {
  ports.add(port);
  port.on('message', (e: Electron.MessageEvent) => {
    const req = e.data as Request;
    void (async () => {
      let reply: Reply;
      try {
        const handler = handlers[req.op];
        if (!handler) throw new Error(`unknown op: ${req.op}`);
        reply = { id: req.id, ok: true, data: await handler(req.params), epoch: storage.epoch };
      } catch (err) {
        reply = { id: req.id, ok: false, error: (err as Error).message, epoch: storage.epoch };
      }
      // Every reply is stamped (invariant 41). A query issued against the
      // previous workspace can still be in flight when the switch lands, and
      // without this the renderer would paint it under the new workspace.
      port.postMessage(reply);
    })();
  });
  // A port dies when its renderer reloads or its window closes. Reaping is what
  // stops a leak across reloads (DESIGN.md §13.2).
  port.on('close', () => { ports.delete(port); });
  port.start();
  emit('sync.port.attached', { live_ports: ports.size });

  if (ports.size === 1) {
    // The renderer can paint the moment it holds a port, and syncing has not
    // been allowed to start yet — so anything counted before now is a real R3
    // violation. Closing the window here stops counting ordinary sync traffic.
    net.markPaintable();
    // R3's headline number, from app start to the moment the renderer holds a
    // port and can paint. Recorded HERE rather than in main because the label —
    // whether there was local data at all — is only known on this side, and a
    // cold install is a genuinely different number from a warm one.
    //
    // Once per PROCESS, not once per attach. A renderer reload closes its port
    // and opens a new one, so `ports.size === 1` becomes true again while
    // bootT0 still points at process start — which recorded a 1,555,160 ms
    // "boot" the first time anyone reloaded the window. One sample like that
    // moves every percentile on the R3 panel, and the panel then reads as a
    // regression that did not happen.
    if (bootT0 > 0 && !bootRecorded) {
      bootRecorded = true;
      histogram('app.boot', Date.now() - bootT0,
                { had_account: storage.accountId ? 'yes' : 'no' });
    }
    if (process.env['RELAYED_VERIFY_BOOT']) {
      console.log(JSON.stringify({
        verify: 'boot', networkCallsBeforeFirstPaint: net.callsBeforePaint.length,
        calls: net.callsBeforePaint,
        accountId: storage.accountId, workspaceId: storage.workspaceId,
        workspaces: storage.accountId ? storage.workspaces().length : 0,
      }));
    }
    startSyncing();
  }
}

/**
 * Sync starts only once the UI can paint (§11, step 7).
 *
 * Not merely un-awaited — deferred. An un-awaited restore would still open a
 * socket and a token request while the window is being created, which makes
 * "no network before first render" true by accident and unprovable by
 * measurement. Deferring it makes the ordering the code's, not the scheduler's.
 *
 * The timer is the fallback for a launch that never opens a window; whichever
 * comes first wins, and startSyncing is idempotent.
 */
let syncStarted = false;
function startSyncing(): void {
  if (syncStarted) return;
  syncStarted = true;
  void setBlobAccount(storage.accountId);
  if (boot.workspaceId) void session.activate(boot.workspaceId);
  // Boot may already hold everything but the bytes — an install whose blobs
  // were evicted, or a fetch that failed while offline last run.
  void fillAvatars();
}
setTimeout(startSyncing, 5_000).unref?.();

process.parentPort.on('message', (e) => {
  const [port] = e.ports;
  const msg = e.data as { type?: string; url?: string };
  // The agent runner's end of a channel main minted for the two of us. Every
  // other port is a renderer's.
  if (port && msg?.type === 'runner:attach') { runner.attach(port); return; }
  if (port) { attach(port); return; }
  // Waking from sleep, forwarded by main because `powerMonitor` is a
  // main-process API and the socket lives here. Worth the hop: after a lid
  // closes the connection is dead and the operating system will not find out
  // for minutes, so a machine that has just woken is the only prompt signal
  // there is (invariant 30).
  if (msg?.type === 'net:resume') { link.retryNow(); return; }
  if (msg?.type === 'auth:callback' && msg.url) {
    // Phase 1: PKCE exchange lands here. Logging only for now — the point is
    // that the URL reached the process that owns the verifier.
    console.log(JSON.stringify({ phase1: 'callback-received', url: msg.url }));
  }
});
