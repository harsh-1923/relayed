// The metric catalogue (OBSERVABILITY.md §5, §8).
//
// Metrics and events answer different questions and are governed by different
// constraints, so they get different catalogues:
//
//   events  →  "why did THIS user's switch hang?"   ids allowed, 14 days
//   metrics →  "what is p95 switch latency?"        NO ids, ever, kept for months
//
// The 10,000 active-series cap is the binding constraint on the whole system,
// and it is a cardinality problem: a series is one unique combination of metric
// name and every label value. One `actor_id` label on one metric is unbounded
// series. §5 says enforce it in the type system rather than by remembering, so
// every label below is a closed union and a metric declares which it accepts.
//
// The 14-day retention on logs and traces has a consequence worth stating where
// it will be read: anything to be reasoned about over MONTHS has to exist as a
// metric, decided when the catalogue is written. It cannot be back-filled.

/** Every label value permitted anywhere. Closed unions, no exceptions. */
export interface LabelValues {
  result: 'ok' | 'error';
  /** DESIGN §10.3 op kinds. */
  op: 'send' | 'edit' | 'react' | 'delete' | 'read';
  /**
   * Which half of a workspace switch (STORAGE.md §12.2). `local` is everything
   * the user waits on; `authorized` is the token and socket work that follows.
   * Splitting them is how "the repaint never waits on the network" stays true
   * instead of quietly regressing.
   */
  phase: 'local' | 'authorized';
  /** Which database. The two migrate on independent version lines. */
  tier: 'account' | 'workspace';
  /** How an actor came to exist. */
  via: 'self_signup' | 'invite' | 'sso_jit' | 'scim' | 'api' | 'workos_event';
  /** How a workspace obtained credentials: a stored token, or a first-ever switch. */
  path: 'refresh' | 'switch';
  outcome: 'authenticated' | 'needs_workspace' | 'failed' | 'cancelled';
  /** Blob class. Avatars are the pinned one (DESIGN §13.3). */
  kind: 'avatar' | 'attachment';
  serve: 'hit' | 'miss' | 'rejected';
  /** Whether boot had local data to render. A cold install is a different number. */
  had_account: 'yes' | 'no';
  /**
   * What caused a renderer read (FRONTEND.md §5). `mount` is a surface opening;
   * `invalidate` is the live-query loop delivering; `epoch` is a workspace
   * switch replacing the replica underneath everything.
   *
   * The split is the point: if `invalidate` sits near zero while writes are
   * happening, the loop is broken and NOTHING else says so — the UI keeps
   * rendering what it fetched on mount, with no error and no spinner.
   */
  trigger: 'mount' | 'invalidate' | 'epoch';
  /**
   * Which of the three states a surface rendered (FRONTEND.md §6.2), plus the
   * transient before its first read lands. `offline` means rows on disk with no
   * network — the state the whole product exists to make ordinary.
   */
  surface: 'loading' | 'empty' | 'offline' | 'live';
  /**
   * `linked` is a blob we already held under another row — the same face in two
   * workspaces is one file, so it costs no network at all. Worth its own value
   * rather than counting as `stored`: a high linked rate means content
   * addressing is earning its keep, and a linked hit works offline where a
   * stored one does not.
   */
  stored: 'stored' | 'linked' | 'skipped' | 'failed';
}

export type LabelName = keyof LabelValues;

export interface MetricSpec {
  readonly kind: 'counter' | 'histogram' | 'gauge';
  readonly unit?: 'ms' | 'bytes' | 'count';
  readonly labels: readonly LabelName[];
  readonly doc: string;
  /**
   * Declared ahead of the code that will record it. Must be deliberate: a
   * metric with no call site is a panel that stays empty forever, and an empty
   * panel reads as "healthy" rather than "never wired". `metrics.test.ts`
   * fails any unmarked metric that nothing records.
   */
  readonly reserved?: true;
}

export const metrics = {
  // ── invariants (OBSERVABILITY.md §9) ─────────────────────────────────────
  // Three silent failures. Each is invisible today until a user notices the
  // symptom, which is the definition of a metric worth alerting on.
  'boot.network_calls_before_paint': {
    kind: 'counter', labels: [],
    doc: 'R3. MUST be 0. Any value means the read path waited on the network.',
  },
  'ipc.stale_dropped': {
    kind: 'counter', labels: [],
    doc: 'Invariant 41. Replies discarded because a switch superseded them. A '
       + 'small spike per switch is correct; a sustained rate means the epoch '
       + 'is wrong and the UI is dropping work it should have shown.',
  },
  'blob.serve': {
    kind: 'counter', labels: ['serve'],
    doc: 'Invariant 45. `rejected` MUST be 0 — it means an id reached the '
       + 'handler that was not a sha256. `miss` is a grey circle a user saw.',
  },

  // ── boot and storage ─────────────────────────────────────────────────────
  'app.boot': {
    kind: 'histogram', unit: 'ms', labels: ['had_account'],
    doc: 'Time to first paint. R3s headline number, and a cold install is a '
       + 'genuinely different one — hence the label.',
  },
  'boot.accounts': {
    kind: 'histogram', unit: 'count', labels: [],
    doc: 'Accounts per install. Multi-account was built on an assumption about '
       + 'how common it is; this is what checks it.',
  },
  'boot.workspaces': {
    kind: 'histogram', unit: 'count', labels: [],
    doc: 'Workspaces on the active account, per install.',
  },
  'db.migrate': {
    kind: 'histogram', unit: 'ms', labels: ['tier'],
    doc: 'Migration cost at boot, per database. Grows with the schema and is '
       + 'paid on the path to first paint.',
  },

  // ── workspace switching (STORAGE.md §12.2) ───────────────────────────────
  'workspace.switch': {
    kind: 'histogram', unit: 'ms', labels: ['phase', 'result'],
    doc: 'Split by phase deliberately. `local` is what the user feels and must '
       + 'stay flat; `authorized` is allowed to be slow, and is unbounded when '
       + 'offline. Collapsing them hides a regression in the half that matters.',
  },
  'workspace.close': {
    kind: 'histogram', unit: 'ms', labels: [],
    doc: 'Closing a replica: outbox count plus a WAL checkpoint. Paid inside '
       + 'the local phase of every switch.',
  },

  // ── identity ─────────────────────────────────────────────────────────────
  'identity.provisioned': {
    kind: 'counter', labels: ['via'],
    doc: 'Actors created. `via` separates people who signed themselves up from '
       + 'people who were invited — two very different growth stories.',
  },
  'identity.memberships': {
    kind: 'histogram', unit: 'count', labels: [],
    doc: 'Workspaces per identity, sampled at every session exchange. The '
       + 'distribution multi-workspace was built for, and unrecoverable later: '
       + 'logs holding this are gone in 14 days.',
  },
  'auth.signin': {
    kind: 'counter', labels: ['outcome'],
    doc: 'The onboarding funnel. `needs_workspace` is someone who authenticated '
       + 'and has not finished; a rising share means onboarding is losing people.',
  },
  'auth.signin.duration': {
    kind: 'histogram', unit: 'ms', labels: ['outcome'],
    doc: 'Browser round trip — how long someone sits looking at a browser tab.',
  },
  'auth.activate': {
    kind: 'counter', labels: ['path', 'result'],
    doc: '`switch` should happen ONCE per workspace per device, ever '
       + '(STORAGE.md §9). A high switch:refresh ratio means vault slots are '
       + 'being lost and every visit is re-minting a session.',
  },
  'auth.illegal_transition': {
    kind: 'counter', labels: [],
    doc: 'An auth transition nobody declared (transitions.ts). Throws in '
       + 'development; here it is the production alarm, because a surprising '
       + 'state must never close the read path. Should be flat at zero.',
  },
  'auth.stale': {
    kind: 'counter', labels: [],
    doc: 'Sessions that degraded to read-only. Local data still works, so users '
       + 'may not report it — which is exactly why it needs a counter.',
  },
  'handle.collision': {
    kind: 'counter', labels: [], reserved: true,
    doc: 'A chosen handle was already taken. Measures whether the suggestion '
       + 'algorithm works or whether everyone has to retype (§10). NO CALL SITE '
       + 'YET, deliberately: a new workspace has an empty handle namespace, so '
       + 'a collision is only reachable by joining an existing one. Declared '
       + 'now because invitations will want it from their first day.',
  },
  'account.deleted': {
    kind: 'counter', labels: [],
    doc: 'Sign-out completing: replicas, blobs and vault gone together.',
  },

  // ── blobs ────────────────────────────────────────────────────────────────
  'blob.prefetch': {
    kind: 'counter', labels: ['kind', 'stored'],
    doc: 'Eager prefetch outcomes (DESIGN §13.3). `failed` is usually offline '
       + 'and recovers; a persistent rate means a broken CDN or a bad URL.',
  },
  // ── WorkOS reconciliation ────────────────────────────────────────────────
  'workos.poll': {
    kind: 'counter', labels: ['result'],
    doc: 'Event-log polls. A sustained error rate means the mirror is going '
       + 'stale — accepted invitations stop appearing and deactivations stop '
       + 'taking effect — with nothing user-visible to indicate it.',
  },
  'workos.poll.duration': {
    kind: 'histogram', unit: 'ms', labels: [],
    doc: 'How long a drain takes. Growing means a backlog rather than a slow API.',
  },
  'workos.poll.lag': {
    kind: 'histogram', unit: 'ms', labels: [],
    doc: 'Age of the newest applied event when it was applied. This is the real '
       + 'answer to "how soon does an accepted invitation appear", and the '
       + 'number that would justify webhooks if it ever got bad.',
  },
  'identity.deactivated': {
    kind: 'counter', labels: ['via'],
    doc: 'Actors tombstoned and their sessions revoked. via=workos_event is the '
       + 'gap accepted when we chose to mint our own tokens, now closed within '
       + 'a poll interval instead of an access-token TTL.',
  },

  'directory.synced': {
    kind: 'counter', labels: ['result'],
    doc: 'Workspace directory pulled into the replica. A sustained error rate '
       + 'means message authors will render as ids once Phase 2 lands.',
  },

  'blob.bytes': {
    kind: 'histogram', unit: 'bytes', labels: ['kind'],
    doc: 'What the blob store actually costs on disk.',
  },

  // ── the renderer read path (FRONTEND.md §5) ──────────────────────────────
  'ui.query.duration': {
    kind: 'histogram', unit: 'ms', labels: ['trigger', 'result'],
    doc: 'How long a local read takes, end to end from the renderer. The ~1ms '
       + 'figure is load-bearing for two decisions — not adopting a server-state '
       + 'cache, and refetching coarsely instead of diffing — and both are '
       + 'correct at 1ms and wrong at 40ms. Nothing else measures the number '
       + 'those rest on. Split by trigger because an invalidation refetch '
       + 'competing with a catch-up write is what degrades first.',
  },
  'ui.query.woken': {
    kind: 'histogram', unit: 'count', labels: [],
    doc: 'Mounted reads refetched by ONE invalidation — the fan-out of the topic '
       + 'tree. Flat at 1 while there is a single surface; it climbs when a '
       + 'topic is too coarse, and it climbs before anyone notices the UI '
       + 'working harder than it should. Advance warning, like chats_per_actor.',
  },
  'ui.surface.state': {
    kind: 'counter', labels: ['surface'],
    doc: 'What surfaces actually rendered, counted on transition rather than per '
       + 'render. Answers a product question nothing else can: how often is '
       + 'anyone offline-with-data, the state this app is built for. Sustained '
       + '`empty` on a populated workspace is the local-first failure.',
  },
  'ui.paint': {
    kind: 'histogram', unit: 'ms', labels: ['had_account'],
    doc: 'App start to the router painting, reported BY the renderer. app.boot '
       + 'measures to the moment the renderer could paint; this measures the '
       + 'moment it did. The gap between them is React and routing, and R3 is '
       + 'a claim about this number.',
  },
  'ui.telemetry.dropped': {
    kind: 'counter', labels: [],
    doc: 'Renderer telemetry discarded because the buffer was full '
       + '(OBSERVABILITY.md §7 — this buffer drops oldest, unlike the outbox). '
       + 'Non-zero means the sync process stopped draining, so treat every '
       + 'other renderer signal around that window as incomplete.',
  },

  // ── the invalidation loop, write side ────────────────────────────────────
  'sync.invalidate': {
    kind: 'counter', labels: [],
    doc: 'Invalidation pushes emitted — writes that told renderers to re-read. '
       + 'Paired with ui.query.woken this is delivery: pushes out against reads '
       + 'woken. Zero here while the directory is syncing means the write path '
       + 'is not announcing itself and every open surface is quietly stale.',
  },
} as const satisfies Record<string, MetricSpec>;

export type MetricName = keyof typeof metrics;

/** Exactly the labels a metric declares — passing any other is a type error. */
export type MetricLabelsFor<N extends MetricName> =
  (typeof metrics)[N]['labels'][number] extends never
    ? Record<string, never>
    : { [K in (typeof metrics)[N]['labels'][number]]: LabelValues[K] };
