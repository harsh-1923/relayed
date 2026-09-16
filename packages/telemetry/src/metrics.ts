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

  // ── sync (DESIGN §8, §9) ─────────────────────────────────────────────────
  /**
   * Which stream a sync event belongs to. Three kinds and no more, by design
   * (DESIGN §8.1) — an actor is a delivery address, not an ordered stream, so
   * there is no fourth value waiting to appear here.
   */
  stream: 'chat' | 'space' | 'workspace';
  /**
   * What catch-up answered with: the events themselves, or a marker saying the
   * distance is unreplayable and here is a snapshot instead.
   *
   * The split is the point. A rising `gap` share means the threshold or the
   * retention horizon is wrong, and every gap costs a client the history below
   * the tail it was handed.
   */
  answer: 'replay' | 'gap';
  /**
   * Why a socket ended. Every path that closes one is a value here, which is
   * what makes "a deploy" distinguishable from "everyone's token expired"
   * without reading a log.
   */
  close: 'client_stop' | 'server_closing' | 'handshake_timeout' | 'hello_timeout'
       | 'read_timeout' | 'zombie' | 'too_old' | 'unauthenticated'
       | 'slow_consumer' | 'error';
  /**
   * Why a frame arrived and was not acted on. `unknown` is invariant 43 working
   * — a newer peer naming something this build predates — and `malformed` is a
   * bug somewhere; counting them under one name with different values is how
   * the two stay comparable.
   */
  frame: 'unknown' | 'malformed' | 'denied';
  /**
   * How an op left the outbox. `coalesced` never reached the network at all
   * (invariant 6), which is a success rather than a loss and so needs its own
   * value rather than being counted as `acked`.
   */
  settled: 'acked' | 'retrying' | 'failed' | 'coalesced' | 'discarded';
  /** Which OTLP signal a dropped record belonged to. */
  signal: 'records' | 'spans';
  /**
   * THE ONE PLACE A VERSION IS ALLOWED, and the reason it is a label here and
   * nowhere else. Updates are opt-in (RELEASE.md), so many versions run at
   * once; on the resource it would multiply EVERY metric by however many are
   * in the field, and 2,900 series becomes 29,000 (§5). On one gauge it is one
   * series per version, which is what makes per-version attribution affordable
   * at all.
   *
   * Not a closed set in the usual sense — it grows with releases — so it is
   * counted against the budget as a generous fixed allowance rather than an
   * enumeration.
   */
  version: string;
  /**
   * Where the engine threw. Seven places, because they are seven different
   * bugs: an apply that cannot write is not a pager that lost its page.
   */
  stage: 'frame' | 'apply' | 'catchup' | 'directory' | 'roster' | 'drain' | 'welcome';

  // ── message parts (AGENT-RESPONSES.md §3, §9 phase 3) ────────────────────
  /**
   * Whether a model's `show_ui` call needed a retry before the block it wrote
   * was stored. `given_up` is a turn that ended with an invalid call still
   * outstanding — nothing of that attempt is kept, and the reply is text alone.
   */
  genui_outcome: 'valid' | 'repaired' | 'given_up';
  /**
   * Why a `show_ui` call failed validation — the parser's own codes plus the
   * two the server adds for a block it cannot read at all. A closed allowlist,
   * `other` for anything `@openuidev/lang-core` adds that this catalogue has
   * not been updated for yet — never the block's source.
   */
  genui_error: 'empty' | 'too-large' | 'parse-exception' | 'no-root' | 'wrong-root'
    | 'incomplete' | 'too-many-statements' | 'data-not-allowed' | 'state-not-allowed'
    | 'unknown-lang' | 'unknown-library' | 'other';
  /**
   * Which library component failed to draw. The closed set is the library's
   * own component names (`@relayed/genui`'s `library.ts`); `other` covers one
   * added there before this catalogue is, so the metric never becomes a reason
   * to delay a component.
   */
  genui_component: 'Card' | 'Stack' | 'CardHeader' | 'Text' | 'Stat' | 'Badge'
    | 'Col' | 'Table' | 'List' | 'Callout' | 'FileRef' | 'Series' | 'BarChart'
    | 'Actions' | 'Reply' | 'Link' | 'other';
  /**
   * Why the server refused a message's parts (AGENT-RESPONSES.md §7).
   * `forbidden_kind` rising means something is trying to put a `tool` or `ui`
   * part under a person's name — the costume rule (rule 1) failing to hold.
   */
  parts_refusal: 'invalid' | 'forbidden_kind' | 'invalid_ui';

  // ── agent runs (WORKSPACE-AGENTS.md §5, §11) ─────────────────────────────
  /** A run's terminal state. Not `outcome`: that label already has a fixed, unrelated set (auth). */
  run_outcome: 'completed' | 'failed' | 'cancelled' | 'timeout' | 'refused' | 'interrupted';
  /** Why a claimed run did not start at all (`admitRun`, §5.3). */
  run_refusal: 'invoker_inactive' | 'agent_inactive' | 'not_a_member' | 'trigger_deleted';
  /** Why a run stays queued a little longer (`admitRun`, §5.3). */
  run_defer_reason: 'runtime_busy';

  // ── connections, through Composio (WORKSPACE-AGENTS.md §6, §11) ──────────
  /** Every operation `composio.ts` exposes — the only file that calls Composio at all. */
  composio_op: 'link' | 'complete_auth' | 'get_account' | 'list_accounts' | 'revoke'
    | 'delete_account' | 'list_toolkits' | 'get_toolkit' | 'list_tools' | 'create_auth_config'
    | 'create_session' | 'patch_session' | 'session_search' | 'session_execute';
  /** Composio's own auth schemes (§6.5's table) — the toolkit's, at the moment a connection touches it. */
  connect_scheme: 'OAUTH2' | 'OAUTH1' | 'DCR_OAUTH' | 'CIMD_OAUTH'
    | 'API_KEY' | 'BEARER_TOKEN' | 'BASIC' | 'BASIC_WITH_JWT';
  /**
   * Where in the connect flow (§6.5) an outcome was recorded. Not `stage`:
   * that label already has a fixed, unrelated set (the sync engine).
   */
  connect_stage: 'link' | 'start' | 'verify' | 'complete' | 'disconnect';

  // ── the broker (WORKSPACE-AGENTS.md §5.5, §11) ───────────────────────────
  /** The tool's effect, at the moment the audit row was claimed (agent_tools.effect at claim). */
  tool_effect: 'read' | 'write' | 'destructive';
  /**
   * Every terminal state `agent_tool_calls.outcome` can hold, minus `pending`
   * (that one is never terminal, so never counted). Every value from step 6 on
   * (§5.5's own words) — never `run_not_running`, `invoker_inactive`,
   * `agent_inactive` or `tool_not_allowed`, which stop before a tool's effect
   * is even known and so have nothing to label this counter with.
   */
  tool_outcome: 'ok' | 'duplicate_call' | 'permission_required' | 'connection_required'
    | 'needs_reauth' | 'failed' | 'refused' | 'tool_deprecated' | 'rate_limited'
    | 'provider_forbidden' | 'provider_unavailable';
}

export type LabelName = keyof LabelValues;

/**
 * The same closed sets, at RUNTIME.
 *
 * The interface above is the contract every call site is checked against, and
 * it vanishes at compile time — so nothing could check a dashboard query, or
 * telemetry arriving from a client we did not compile (§8).
 *
 * BOTH DIRECTIONS ARE PROVEN, and they need different mechanisms. `satisfies`
 * below proves every value here is a member of its union. It cannot prove the
 * reverse — a union member left OUT of an array compiles cleanly and silently
 * shrinks the set anything checks against — so `Missing` underneath does that,
 * and names the absent value in the error.
 */
export const labelValues = {
  result: ['ok', 'error'],
  op: ['send', 'edit', 'react', 'delete', 'read'],
  phase: ['local', 'authorized'],
  tier: ['account', 'workspace'],
  via: ['self_signup', 'invite', 'sso_jit', 'scim', 'api', 'workos_event'],
  path: ['refresh', 'switch'],
  outcome: ['authenticated', 'needs_workspace', 'failed', 'cancelled'],
  kind: ['avatar', 'attachment'],
  serve: ['hit', 'miss', 'rejected'],
  had_account: ['yes', 'no'],
  stored: ['stored', 'linked', 'skipped', 'failed'],
  trigger: ['mount', 'invalidate', 'epoch'],
  surface: ['loading', 'empty', 'offline', 'live'],
  stream: ['chat', 'space', 'workspace'],
  answer: ['replay', 'gap'],
  close: ['client_stop', 'server_closing', 'handshake_timeout', 'hello_timeout',
          'read_timeout', 'zombie', 'too_old', 'unauthenticated',
          'slow_consumer', 'error'],
  frame: ['unknown', 'malformed', 'denied'],
  settled: ['acked', 'retrying', 'failed', 'coalesced', 'discarded'],
  signal: ['records', 'spans'],
  // Not enumerable: a version is minted by a release, not declared here. The
  // number is the allowance the series budget reserves for live versions.
  version: Array.from({ length: 12 }, (_, i) => `v${i}`) as unknown as string[],
  stage: ['frame', 'apply', 'catchup', 'directory', 'roster', 'drain', 'welcome'],
  genui_outcome: ['valid', 'repaired', 'given_up'],
  genui_error: ['empty', 'too-large', 'parse-exception', 'no-root', 'wrong-root',
                'incomplete', 'too-many-statements', 'data-not-allowed', 'state-not-allowed',
                'unknown-lang', 'unknown-library', 'other'],
  genui_component: ['Card', 'Stack', 'CardHeader', 'Text', 'Stat', 'Badge',
                     'Col', 'Table', 'List', 'Callout', 'FileRef', 'Series', 'BarChart',
                     'Actions', 'Reply', 'Link', 'other'],
  parts_refusal: ['invalid', 'forbidden_kind', 'invalid_ui'],
  run_outcome: ['completed', 'failed', 'cancelled', 'timeout', 'refused', 'interrupted'],
  run_refusal: ['invoker_inactive', 'agent_inactive', 'not_a_member', 'trigger_deleted'],
  run_defer_reason: ['runtime_busy'],
  composio_op: ['link', 'complete_auth', 'get_account', 'list_accounts', 'revoke',
                'delete_account', 'list_toolkits', 'get_toolkit', 'list_tools', 'create_auth_config',
                'create_session', 'patch_session', 'session_search', 'session_execute'],
  tool_effect: ['read', 'write', 'destructive'],
  tool_outcome: ['ok', 'duplicate_call', 'permission_required', 'connection_required',
                 'needs_reauth', 'failed', 'refused', 'tool_deprecated', 'rate_limited',
                 'provider_forbidden', 'provider_unavailable'],
  connect_scheme: ['OAUTH2', 'OAUTH1', 'DCR_OAUTH', 'CIMD_OAUTH',
                   'API_KEY', 'BEARER_TOKEN', 'BASIC', 'BASIC_WITH_JWT'],
  connect_stage: ['link', 'start', 'verify', 'complete', 'disconnect'],
} as const satisfies { readonly [K in LabelName]: readonly LabelValues[K][] };

/** Union members not present in `labelValues`. `never` when the sets agree. */
type Missing = {
  [K in LabelName]: Exclude<LabelValues[K], (typeof labelValues)[K][number]>
}[LabelName];

/**
 * The proof, and it is load-bearing rather than decorative.
 *
 * When the sets agree this is `true`, which is assignable, and this line
 * disappears. When a value is missing the type becomes that value — so adding
 * one to the union above and forgetting the array below fails the build with
 * the missing string in the message, rather than passing and quietly narrowing
 * what every dashboard check compares against.
 */
const _labelSetsAreExhaustive: Missing extends never ? true : Missing = true;
void _labelSetsAreExhaustive;

/** How many series each label multiplies a metric by. Derived, never counted. */
export const cardinality: { readonly [K in LabelName]: number } =
  Object.fromEntries(Object.entries(labelValues)
    .map(([label, values]) => [label, values.length])) as
    { readonly [K in LabelName]: number };

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
  // ── the sync engine, server side (SYNC-FLOWS.md step 13) ─────────────────
  //
  // Decided in one pass rather than one at a time, so they answer a question
  // TOGETHER: a message is appended, fanned out to an audience, missed by
  // somebody who was offline, and replayed to them on reconnect. Each metric
  // below names the question it exists for, and the ones deliberately NOT
  // added are listed at the bottom of this block with the reason.
  'sync.op': {
    kind: 'counter', labels: ['op', 'result'],
    doc: 'Writes the server accepted or refused, by kind. Answers "what share '
       + 'of writes are we rejecting, and is it one op type" — a refusal is one '
       + 'nack on one socket, so nothing else aggregates it, and a client shows '
       + 'a permanent failure to exactly one person who may not report it.',
  },
  'sync.op.duration': {
    kind: 'histogram', unit: 'ms', labels: ['op'],
    doc: 'How long the server holds a write: gate, allocate, append, commit. '
       + 'Answers "is send latency ours or the network\'s", which is the first '
       + 'question anyone asks about a slow send and the one a client cannot '
       + 'answer about itself.',
  },
  'sync.parts.refused': {
    kind: 'counter', labels: ['parts_refusal'],
    doc: 'AGENT-RESPONSES.md §7. A write refused because its parts do not '
       + 'parse, name a kind (`tool`/`ui`) the author may not write, or hold a '
       + 'UI block that does not validate. A `forbidden_kind` share rising is '
       + 'someone trying to draw a card under a person\'s name; the server\'s '
       + 'own refusal message never carries the source.',
  },
  'sync.event.appended': {
    kind: 'counter', labels: ['stream'],
    doc: 'Events written to the log, by stream kind. Answers "how fast is the '
       + 'log growing" — and read against sync.retention.swept it is the '
       + 'table\'s actual growth rate, which is what sizes the sweep and the '
       + 'disk. Split by kind because chat traffic and directory churn grow for '
       + 'entirely different reasons.',
  },
  'sync.fanout.audience': {
    kind: 'histogram', unit: 'count', labels: ['stream'],
    doc: 'How many actors one event resolves an audience of. Answers "when '
       + 'does fanout stop being a loop" — the design is O(audience) per event '
       + 'and this is the number that says when that stops being free. A '
       + 'workspace stream fans out to everyone, which is why kind is a label.',
  },
  'sync.fanout.duration': {
    kind: 'histogram', unit: 'ms', labels: [],
    doc: 'Commit to bytes on the wire. Answers "how much delivery latency is '
       + 'ours after the write landed" — the half of the path no client can '
       + 'see or report, because from the outside it is indistinguishable from '
       + 'a slow network.',
  },
  'sync.fanout.dropped': {
    kind: 'counter', labels: [],
    doc: 'Connections disconnected mid-fanout for exceeding the backlog limit. '
       + 'Answers "is anyone losing live delivery" — MUST be near zero. A '
       + 'sustained rate is people silently falling back to catch-up on every '
       + 'event, which feels like a laggy app and produces no error anywhere.',
  },
  'sync.catchup': {
    kind: 'counter', labels: ['answer'],
    doc: 'How reconnects were answered: replayed, or pushed into a gap '
       + '(invariant 25). Answers "is the gap threshold right" — a rising gap '
       + 'share means the threshold or the retention horizon is wrong, and a '
       + 'gap costs the client every message below the tail it is handed.',
  },
  'sync.catchup.events': {
    kind: 'histogram', unit: 'count', labels: [],
    doc: 'Events in one replay. Answers "how close do real clients run to the '
       + '500-event threshold" — which is what makes 500 a measured number '
       + 'rather than the one somebody picked. If p99 sits at the cap, the cap '
       + 'is what is producing the gaps, not the clients.',
  },
  'sync.catchup.duration': {
    kind: 'histogram', unit: 'ms', labels: ['answer'],
    doc: 'Server time to answer catch-up. Answers "what does a reconnect storm '
       + 'cost" — the load spike this system actually has is ten thousand '
       + 'clients returning at once (invariant 31), and this is the per-request '
       + 'number that storm multiplies.',
  },
  'sync.welcome.bytes': {
    kind: 'histogram', unit: 'bytes', labels: [],
    doc: 'The size of the welcome frame. Answers "how close is welcome to '
       + 'needing to page" (DESIGN §9.9) — measured rather than assumed, and '
       + 'the one number that decides it. p99 is the interesting one: the '
       + 'largest workspace is the one that hits the ceiling first.',
  },
  'sync.chats_per_actor': {
    kind: 'histogram', unit: 'count', labels: [],
    doc: 'Chats one actor can reach, sampled at every welcome. Answers "when '
       + 'will welcome have to page" BEFORE anybody hits it — OBSERVABILITY §9 '
       + 'asks for exactly this, as the example of a signal that gives advance '
       + 'warning of a design limit rather than reporting it afterwards.',
  },
  'sync.retention.swept': {
    kind: 'counter', labels: [],
    doc: 'Events deleted past the horizon. Answers "is the sweep keeping up" — '
       + 'appended minus swept is the log\'s net growth, and a sweep that falls '
       + 'behind shows up here long before it shows up as disk.',
  },
  'ws.sessions': {
    kind: 'gauge', labels: [],
    doc: 'Authenticated sockets attached right now. The denominator for every '
       + 'rate above — a fanout count means nothing without it — and the thing '
       + 'that drops to zero in an outage while every other counter simply '
       + 'stops emitting, which looks identical to a quiet night.',
  },
  'ws.closed': {
    kind: 'counter', labels: ['close'],
    doc: 'Sockets ending, by cause. Answers "why did everyone reconnect" in one '
       + 'query: a deploy, expired tokens, clients being killed, and zombies '
       + 'are four different incidents that look the same from a connection '
       + 'count alone.',
  },
  'sync.frame.dropped': {
    kind: 'counter', labels: ['frame'],
    doc: 'Frames received and not acted on. Answers "is version skew real yet" '
       + '(invariant 43): `unknown` climbing after a release is old clients '
       + 'meeting new frames and is CORRECT, while `malformed` is a bug and '
       + '`denied` is somebody asking for a stream they cannot read.',
  },

  // ── message parts, the renderer and the local runner (AGENT-RESPONSES.md §9) ─
  'genui.block': {
    kind: 'counter', labels: ['genui_outcome'],
    doc: 'One `show_ui` call from the model resolved: stored on the first try, '
       + 'stored after a repair, or the turn ended with the attempt abandoned. '
       + 'Answers "is the UI prompt still working" — a rising `given_up` share '
       + 'means the model is losing a fight the instructions should be winning.',
  },
  'genui.error': {
    kind: 'counter', labels: ['genui_error'],
    doc: 'Why one `show_ui` call was refused, by the parser\'s own code. '
       + 'Answers "which mistake is growing" — the thing a prompt change is '
       + 'meant to fix, and the only way to tell whether it did.',
  },
  // ── agent runs (WORKSPACE-AGENTS.md §5.3, §11) ───────────────────────────
  'agent.run': {
    kind: 'counter', labels: ['run_outcome'],
    doc: 'A run reached a terminal state. Six values, never `queued` or '
       + '`running` — this counts what a run ENDED as. A rising `interrupted` '
       + 'share outside a deploy window means leases are expiring while the '
       + 'runtime is still healthy, which points at the timeout, not an outage.',
  },
  'agent.run.refused': {
    kind: 'counter', labels: ['run_refusal'],
    doc: 'A claimed run that did not start at all, by `admitRun`\'s refusal '
       + 'code (§5.3) — the breakdown behind `agent.run{run_outcome:refused}`. '
       + 'A rising `not_a_member` share means agents are being mentioned in '
       + 'rooms they have since left.',
  },
  'agent.run.deferred': {
    kind: 'counter', labels: ['run_defer_reason'],
    doc: 'A claimed run put back in the queue, by reason. Only `runtime_busy` '
       + 'today: the runtime is at capacity. There is deliberately no per-person '
       + 'reason — a person\'s runs in flight never hold back their next mention.',
  },
  'agent.run.queue_wait': {
    kind: 'histogram', unit: 'ms', labels: [],
    doc: 'Time from a run being created to being claimed. Answers whether the '
       + 'poll interval is still short enough, and rises before anyone notices '
       + 'a mention going unanswered for longer than they expect.',
  },
  'agent.dispatcher.sweep_error': {
    kind: 'counter', labels: [],
    doc: 'A run\'s expired-lease notice failed to write, so the run was moved '
       + 'to `interrupted` with no notice in its thread rather than crashing the '
       + 'sweep or failing again on the next one. Any count above zero is a '
       + 'person who mentioned an agent and saw nothing come back — a bug in '
       + 'the reply path, not an outage.',
  },

  // ── the room summariser (DOCUMENTS.md §4) ────────────────────────────────
  'summary.refresh': {
    kind: 'counter', labels: ['result'],
    doc: 'One pass of the room summariser finished. `error` covers both a '
       + 'runtime that failed and one that answered with nothing usable — both '
       + 'leave the previous summary standing and both drive the same backoff, '
       + 'so the panel goes stale silently. A rising error rate is the only '
       + 'signal anyone gets that summaries have stopped.',
  },
  'summary.refresh.messages': {
    kind: 'histogram', unit: 'count', labels: [],
    doc: 'How many readable messages one refresh was given. Answers whether '
       + 'the threshold is tuned: a distribution sitting far above it means '
       + 'rooms are outrunning the loop, and one sitting at it means refreshes '
       + 'are firing on the smallest batch that qualifies.',
  },

  'composio.request': {
    kind: 'counter', labels: ['composio_op', 'result'],
    doc: 'Every call `composio.ts` makes — the only file that imports the SDK '
       + '(the boundary rule `agents/composio-only-here`). Answers whether a '
       + 'failure spike belongs to one operation or to Composio generally, '
       + 'and, paired with `composio.request.duration`, whether a slow '
       + 'connector-store page is Composio or us.',
  },
  'composio.request.duration': {
    kind: 'histogram', unit: 'ms', labels: ['composio_op'],
    doc: 'How long one call to Composio took. The connector store and the '
       + 'broker both wait on it synchronously, so this is latency a person '
       + 'or a run feels directly.',
  },
  'connection.flow': {
    kind: 'counter', labels: ['connect_scheme', 'connect_stage', 'result'],
    doc: 'One outcome at one stage of connecting or disconnecting a toolkit '
       + '(WORKSPACE-AGENTS.md §6.5, §6.10). Answers where people actually '
       + 'drop out of the flow — Composio refusing the link, an expired or '
       + 'reused start token, a missing verification cookie, a session-uri '
       + 'mismatch at complete — which `composio.request` alone cannot show, '
       + 'because most of those stages never call Composio at all.',
  },

  'agent.tool': {
    kind: 'counter', labels: ['tool_effect', 'tool_outcome'],
    doc: 'One tool call reached a terminal outcome (WORKSPACE-AGENTS.md §5.5, '
       + 'step 10 — every outcome from step 6 on). Answers whether an agent is '
       + 'actually able to use what it is configured for: a rising '
       + '`permission_required`/`connection_required` share means people are '
       + 'not finishing the access-card flow, and `refused` MUST be nearly '
       + 'zero — it means our own tool snapshot and the session disagreed, '
       + 'which is a bug in the broker, not a user problem.',
  },

  'genui.render_error': {
    kind: 'counter', labels: ['genui_component'],
    doc: 'A stored, valid block still failed to DRAW — a renderer bug rather '
       + 'than a model mistake. Answers "which of our components breaks", '
       + 'which `genui.error` cannot: that one only sees blocks that never '
       + 'made it past validation.',
  },

  // ── the sync engine, client side ─────────────────────────────────────────
  'sync.cursor.lag': {
    kind: 'histogram', unit: 'count', labels: [],
    doc: 'server_head_rev minus synced_through_rev, sampled per sweep '
       + '(invariant 1). Answers "is the frontier keeping up" — the silent '
       + 'failure this whole design has: a client that stops advancing shows no '
       + 'error and no spinner, it just quietly stops receiving messages.',
  },
  'sync.staged.depth': {
    kind: 'histogram', unit: 'count', labels: [],
    doc: 'Events held out of order awaiting the revision before them. Answers '
       + '"is anything permanently stuck" — expected at or near zero, because '
       + 'staged events collapse the moment the hole is filled. A depth that '
       + 'never falls is a hole nothing is going to fill.',
  },
  'sync.apply.duration': {
    kind: 'histogram', unit: 'ms', labels: [],
    doc: 'Time to apply one batch to the replica. Answers "does catching up '
       + 'make the app unresponsive" — it is the write that competes with the '
       + 'reads in ui.query.duration, and the pair is what says whether '
       + 'chunking the apply is still buying anything.',
  },
  'sync.gap': {
    kind: 'counter', labels: ['stream'],
    doc: 'Gap markers accepted by a client. Answers "how often does somebody '
       + 'fall off the horizon" — the client-side half of sync.catchup, and the '
       + 'only one that counts gaps a client actually acted on rather than ones '
       + 'the server offered.',
  },
  'sync.backfill.page': {
    kind: 'counter', labels: [],
    doc: 'History pages pulled after a gap. Answers "what does a gap actually '
       + 'cost" — pages per gap, read against sync.gap. A gap is cheap if '
       + 'nobody scrolls back and expensive if everybody does, and that ratio '
       + 'is the difference.',
  },
  'outbox.op': {
    kind: 'counter', labels: ['op', 'settled'],
    doc: 'How the user\'s writes left the queue. Answers "did my message send" '
       + 'as an aggregate: acked is the happy path, failed is somebody looking '
       + 'at a red message, and coalesced is a send-then-delete that correctly '
       + 'never touched the network (invariant 6).',
  },
  'outbox.depth': {
    kind: 'histogram', unit: 'count', labels: [],
    doc: 'Ops waiting, sampled at every drain. Answers "is the write path '
       + 'draining" — a depth that grows while a socket is live means acks are '
       + 'not coming back, which is invisible to a user until they notice '
       + 'nothing they typed has a timestamp.',
  },
  'outbox.oldest.age': {
    kind: 'histogram', unit: 'ms', labels: [],
    doc: 'How long the oldest unsent op has been waiting. Answers "how stale '
       + 'is the worst case" — depth alone cannot, because one op stuck for an '
       + 'hour and sixty ops from the last minute are the same depth and very '
       + 'different problems. Unbounded while offline, which is correct.',
  },

  'sync.failed': {
    kind: 'counter', labels: ['stage'],
    doc: 'The engine caught something it could not do and carried on. Answers '
       + '"is anybody stuck, and where" — MUST be 0. Before the error boundary '
       + 'existed this was not a metric at all: a throw inside the apply loop '
       + 'reached a `ws` event handler and killed the process, so the only '
       + 'record was a stack trace on somebody\'s stderr. A caught failure '
       + 'leaves the frontier where it was, so a persistent one becomes '
       + 'sync.cursor.stalled a heartbeat later — read the two together.',
  },
  'client.info': {
    kind: 'gauge', labels: ['version'],
    doc: 'One series per running build, carrying nothing but its version. The '
       + 'shape §5 prescribes for the `client_version` trap: per-version '
       + 'attribution has to come from somewhere, and everywhere is the wrong '
       + 'answer — a version label on every metric multiplies the whole '
       + 'catalogue by the number of releases in the field. Join on it when a '
       + 'regression looks version-shaped.',
  },
  'telemetry.dropped': {
    kind: 'counter', labels: ['signal'],
    doc: 'Records the OTLP buffer refused because it was full. Answers the one '
       + 'question every other number on every dashboard depends on: IS THIS '
       + 'COMPLETE. A load run dropped 86% of its telemetry and said nothing — '
       + 'the shapes still looked right while every count was a twelfth of the '
       + 'truth, which is the most dangerous way for instrumentation to be '
       + 'wrong. MUST be 0; a counter at zero emits nothing, so an empty panel '
       + 'is the healthy state and the alert is `> 0`. Added at FLUSH time so '
       + 'it cannot be dropped by the buffer it reports on.',
  },

  // ── proposed and DECLINED, with the reason ───────────────────────────────
  //
  // Kept here rather than dropped, because "we thought about it and said no" is
  // the part that does not survive in a diff — and the alternative is somebody
  // adding one of these next year with no idea it was already considered.
  // OBSERVABILITY §9 names the first three; they are declined anyway.
  //
  //   ws.heartbeat.missed — a missed beat that recovers is not a condition
  //     anybody acts on, and one that does not recover IS ws.zombie.detected.
  //     Two markers where the second already carries the actionable half.
  //
  //   sync.op.duplicate.rate — a duplicate is the CORRECT outcome of a retry
  //     after a lost ack (invariant 5), so the rate has no healthy value to
  //     compare against. The failure worth catching is a duplicate that was
  //     not idempotent, which production cannot distinguish and tests can. The
  //     per-message view is in the trace: two `op` frames, one op_id.
  //
  //   ws.reconnect.count — the same number as ws.closed with the reason thrown
  //     away. Every reconnect is preceded by a close, and the close says why.
  //
  //   members_per_workspace — a proxy for audience size. sync.fanout.audience
  //     measures the thing itself, including the part membership cannot
  //     predict: how many of those members are connected.
  //
  //   directory.pages per sync — ceil(actors / DIRECTORY_PAGE), a deterministic
  //     function of a number we already hold. The question worth asking is
  //     whether the pager FINISHED, and directory.synced{result} answers it.
} as const satisfies Record<string, MetricSpec>;

export type MetricName = keyof typeof metrics;

/** Exactly the labels a metric declares — passing any other is a type error. */
export type MetricLabelsFor<N extends MetricName> =
  (typeof metrics)[N]['labels'][number] extends never
    ? Record<string, never>
    : { [K in (typeof metrics)[N]['labels'][number]]: LabelValues[K] };
