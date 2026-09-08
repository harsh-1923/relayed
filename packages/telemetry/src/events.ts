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
    fields: { chat_id: 'id', head_rev: 'int', cursor_rev: 'int' },
    doc: 'Server returned a gap marker instead of a replay (DESIGN §9.3).',
  },
  'sync.event.unknown': {
    fields: { rev: 'int' },
    doc: 'An unrecognised op advanced the cursor without being applied '
       + '(invariant 32). Rising means old clients are meeting new op types.',
  },
  'sync.cursor.stalled': {
    fields: { chat_id: 'id', cursor_rev: 'int', head_rev: 'int', lag: 'int' },
    doc: 'Contiguity frontier behind the server head beyond threshold (invariant 1).',
  },
  'sync.backfill.page': {
    fields: { chat_id: 'id', rows: 'int', duration: 'ms' },
    doc: 'One keyset backfill page fetched (DESIGN §9.4).',
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

  // ── lifecycle ────────────────────────────────────────────────────────────
  'app.boot':            { fields: { to_first_render: 'ms', from_local: 'bool' },
                           doc: 'Boot completed. from_local=false would violate R3.' },
  'db.migrated':         { fields: { from: 'int', to: 'int', duration: 'ms' },
                           doc: 'Schema migration applied at boot.' },
  'sync.port.attached':  { fields: { live_ports: 'int' },
                           doc: 'A renderer attached a MessagePort (DESIGN §13.2).' },
} as const satisfies Record<string, EventSpec>;

export type EventName = keyof typeof events;

type FieldTs<T> =
  T extends 'id' ? string : T extends 'bool' ? boolean : T extends 'enum' ? string : number;

/** Payload type for an event, derived from its spec. */
export type EventFields<N extends EventName> = {
  [K in keyof (typeof events)[N]['fields']]: FieldTs<(typeof events)[N]['fields'][K]>
};
