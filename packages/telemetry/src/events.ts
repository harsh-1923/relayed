// The event catalogue (OBSERVABILITY.md §8).
//
// Every event the system can emit is enumerated here. Ad-hoc events are
// impossible by construction, so each addition is a reviewable diff — and the
// server validates incoming client telemetry against this same list, making it
// a runtime boundary rather than only a compile-time one.
//
// TWO RULES, both enforced by the types below:
//   1. No message bodies, ever. There is deliberately no `body` field type.
//   2. No unbounded id in a METRIC label. Ids are fine on events and spans
//      (indexed differently); metric labels are closed sets only (§5).

/** Field value shapes permitted on an event. Note the absence of free text. */
export type FieldType = 'id' | 'int' | 'ms' | 'bool' | 'enum';

export interface EventSpec {
  readonly fields: Readonly<Record<string, FieldType>>;
  readonly doc: string;
}

export const events = {
  // ── sync engine ──────────────────────────────────────────────────────────
  'sync.gap.entered': {
    fields: { stream: 'enum', id: 'id', head_rev: 'int', cursor_rev: 'int' },
    doc: 'Server returned a gap marker instead of a replay (DESIGN §9.3). Named '
       + 'by stream rather than by chat: spaces and the workspace directory can '
       + 'gap too, and an earlier `chat_id` field could not say which.',
  },
  'sync.event.unknown': {
    fields: { stream: 'enum', type: 'enum', rev: 'int' },
    doc: 'An unrecognised op advanced the cursor without being applied '
       + '(invariant 32). Rising means old clients are meeting new op types — '
       + 'and `type` is what says WHICH, without which the count cannot be '
       + 'acted on.',
  },
  'sync.cursor.stalled': {
    fields: { stream: 'enum', id: 'id', cursor_rev: 'int', head_rev: 'int', lag: 'int' },
    doc: 'The contiguity frontier did not move between two sweeps while the '
       + 'server head was ahead and nothing was in flight (invariant 1). Not '
       + 'merely "behind" — a client returning from a week offline is behind '
       + 'and perfectly healthy. This is behind AND not catching up.',
  },
  'sync.backfill.page': {
    fields: { chat_id: 'id', rows: 'int', duration: 'ms' },
    doc: 'One keyset backfill page fetched (DESIGN §9.4).',
  },
  'sync.repair.page': {
    fields: { chat_id: 'id', rows: 'int', applied: 'int', rejected: 'int', done: 'bool' },
    doc: 'One repair page applied after a gap (SYNC-FLOWS, the repair flow). '
       + '`rejected` counts rows older than what the client held — a live '
       + 'change landed mid-repair, and the row is served again; `done` is '
       + 'true only for a complete page with nothing rejected (invariant 87).',
  },

  'sync.failed': {
    fields: { stage: 'enum', frame: 'enum', id: 'id', rev: 'int' },
    doc: 'The engine threw and the error boundary caught it. Carries WHICH '
       + 'stream and revision, which is what makes one stuck client findable. '
       + 'The error MESSAGE is deliberately not here — there is no free-text '
       + 'field on any event (§6) — it rides the failed span instead, where '
       + 'only `e.message` is ever recorded.',
  },

  // ── write path ───────────────────────────────────────────────────────────
  'outbox.op.failed': {
    fields: { attempts: 'int', retryable: 'bool' },
    doc: 'An outbox op reached a terminal or retryable failure (DESIGN §10.5).',
  },
  'outbox.coalesced': {
    fields: { dropped: 'int' },
    doc: 'Ops collapsed on enqueue (invariant 6).',
  },

  // ── connection ───────────────────────────────────────────────────────────
  'ws.connected':        { fields: { attempt: 'int' }, doc: 'Socket established.' },
  'ws.disconnected':     { fields: { code: 'int', uptime: 'ms' }, doc: 'Socket closed.' },
  'ws.zombie.detected':  { fields: { last_pong: 'ms' }, doc: 'Heartbeat deadline missed (invariant 30).' },
  'ws.reauth':           { fields: { ok: 'bool' }, doc: 'In-band token refresh (DESIGN §9.7).' },

  // ── the renderer read path (FRONTEND.md §5, §10) ─────────────────────────
  // These four are designed to be read TOGETHER, filtered on `invalidation`:
  //
  //   sync.invalidated         { invalidation: 41, root: 'actors', ports: 1 }
  //   ui.invalidation.received { invalidation: 41, mounted: 6, matched: 1 }
  //   ui.query.read            { invalidation: 41, query: 'actors.list', rows: 2 }
  //
  // That chain is the whole loop across two processes, in order. `matched`
  // beside `mounted` is what answers "why did my surface not update" without
  // reading any code: 0 means the topic is wrong, 6 means it is too coarse.
  'sync.invalidated': {
    fields: { invalidation: 'int', root: 'enum', topics: 'int', ports: 'int' },
    doc: 'One coalesced invalidation push left the sync engine. `topics` is how '
       + 'many distinct ones the batch collapsed to; `ports` is how many '
       + 'renderers were listening — zero means nobody was attached and the '
       + 'push was dropped, which is correct rather than a loss.',
  },
  'ui.invalidation.received': {
    fields: { invalidation: 'int', mounted: 'int', matched: 'int' },
    doc: 'A push reached the registry. `matched` of `mounted` reads were woken.',
  },
  'ui.query.read': {
    fields: { invalidation: 'int', query: 'enum', topic: 'id',
              trigger: 'enum', rows: 'int', ms: 'ms' },
    doc: 'One read, resolved. `invalidation` is 0 for a mount or a workspace '
       + 'switch, so a non-zero value is exactly the set of reads the live-query '
       + 'loop caused. One event per read rather than a list per push, because '
       + 'the catalogue has no free-text field to hold a list of topics in.',
  },
  'ui.route.changed': {
    fields: { from: 'id', to: 'id', workspace: 'id' },
    doc: 'Navigation. The spine every other renderer event hangs off — it is '
       + 'what makes a session reconstructable when someone reports a bug, and '
       + 'the reason it is the first client event rather than a later one.',
  },
  'ui.first.paint': {
    fields: { to_first_paint: 'ms', from_local: 'bool' },
    doc: 'App start to the router actually painting, reported by the renderer '
       + 'after the frame commits. app.boot stops at the moment the renderer '
       + 'COULD paint; this is when it did, and R3 is a claim about this one. '
       + 'The R3 network counter deliberately still closes at port attach — '
       + 'moving it here would count ordinary sync traffic as a violation.',
  },

  // ── identity and storage ─────────────────────────────────────────────────
  // These carry ids on purpose. Metrics cannot (§5), so this is the only layer
  // that can answer "why did THIS user's switch hang" — at the cost of a
  // 14-day window, which is why the aggregate lives in metrics.ts as well.
  'auth.signed_in': {
    fields: { account: 'id', device: 'id', actor: 'id', workspace: 'id',
              outcome: 'enum', duration: 'ms' },
    doc: 'An interactive sign-in resolved. outcome=needs_workspace means '
       + 'authenticated but not yet onboarded (PHASE-1-IDENTITY §9).',
  },
  'auth.activated': {
    fields: { account: 'id', workspace: 'id', path: 'enum', ok: 'bool' },
    doc: 'Credentials established for a workspace. path=switch is the '
       + 'first-ever open on this device and should happen once (STORAGE §9).',
  },
  'auth.signed_out': {
    fields: { account: 'id', workspaces: 'int' },
    doc: 'Sign-out completing: every workspace revoked, then one directory '
       + 'delete taking replicas, blobs and vault together (STORAGE §13).',
  },
  'identity.provisioned': {
    fields: { actor: 'id', org: 'id', workspace: 'id', via: 'enum' },
    doc: 'An actor row was created. Server-side counterpart of auth.signed_in.',
  },
  'account.opened': {
    fields: { account: 'id', device: 'id', workspaces: 'int', epoch: 'int' },
    doc: 'An account.db was opened at boot or on an account switch.',
  },
  'workspace.switched': {
    fields: { account: 'id', from: 'id', to: 'id', local: 'ms', epoch: 'int' },
    doc: 'A workspace switch completed its LOCAL phase — the part the user '
       + 'waits on. Token and socket work follows and is timed separately.',
  },
  'workos.poll.applied': {
    fields: { events: 'int', after: 'id' },
    doc: 'Events applied and the cursor they advanced to. The cursor is the '
       + 'replay handle: rewinding it rebuilds the mirror.',
  },
  'workos.poll.failed': {
    fields: { after: 'id', reason: 'enum' },
    doc: 'A poll or an apply failed. The cursor did NOT move, so the failure '
       + 'mode is staleness rather than a silently skipped event.',
  },
  'identity.deactivated': {
    fields: { actor: 'id', via: 'enum' },
    doc: 'An actor was tombstoned and its sessions revoked.',
  },
  'directory.synced': {
    fields: { workspace: 'id', actors: 'int' },
    doc: 'The workspace directory was replicated. Replaced by the welcome '
       + 'frame in Phase 2 (DESIGN §9.1).',
  },
  'dev.offline': {
    fields: { offline: 'bool' },
    doc: 'The simulated-offline switch was toggled. Development builds only, '
       + 'and worth an event so a confusing local session can be explained.',
  },
  'blob.served': {
    fields: { blob: 'id', result: 'enum' },
    doc: 'The relayed-blob handler resolved. result=miss is a grey circle a '
       + 'user saw; result=rejected means invariant 45 fired.',
  },

  // ── lifecycle ────────────────────────────────────────────────────────────
  'app.boot':            { fields: { to_first_render: 'ms', from_local: 'bool' },
                           doc: 'Boot completed. from_local=false would violate R3.' },
  'db.migrated':         { fields: { tier: 'enum', from: 'int', to: 'int', duration: 'ms' },
                           doc: 'Schema migration applied. The account and workspace '
                              + 'databases advance on independent version lines.' },
  'sync.port.attached':  { fields: { live_ports: 'int' },
                           doc: 'A renderer attached a MessagePort (DESIGN §13.2).' },
  'blob.prefetched':     { fields: { kind: 'enum', count: 'int' },
                           doc: 'Blobs fetched eagerly. Avatars are the pinned class (DESIGN §13.3).' },
  'app.update.offered':  { fields: { current: 'enum', latest: 'enum', required: 'bool' },
                           doc: 'This build is behind. `required` separates the offer from the '
                              + 'refusal: false is a dismissible banner, true is a build below '
                              + 'the published floor that the app will not run (RELEASE.md §1). '
                              + 'A rising `required` count after a floor is raised is how you '
                              + 'watch people actually move.' },
} as const satisfies Record<string, EventSpec>;

export type EventName = keyof typeof events;

type FieldTs<T> =
  T extends 'id' ? string : T extends 'bool' ? boolean : T extends 'enum' ? string : number;

/** Payload type for an event, derived from its spec. */
export type EventFields<N extends EventName> = {
  [K in keyof (typeof events)[N]['fields']]: FieldTs<(typeof events)[N]['fields'][K]>
};
