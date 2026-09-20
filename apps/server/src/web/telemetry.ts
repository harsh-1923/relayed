// Where a desktop client's telemetry enters (OBSERVABILITY.md §3, §8).
//
// WHY THIS EXISTS RATHER THAN THE CLIENT EXPORTING DIRECTLY. §3 gives two
// reasons and both are load-bearing: a distributable binary cannot hold an
// ingest credential, because it is trivially extractable — and direct export
// leaves no place to scrub before data leaves somebody's machine. Routing
// through here reuses the session that already exists and makes redaction and
// rate limiting central.
//
// IDENTITY COMES FROM THE TOKEN, NEVER THE BODY. Every record is attributed to
// the actor and workspace the bearer proves, and anything the client says about
// who it is, is ignored. A client that could name its own actor could attribute
// its telemetry to somebody else — the one thing a validating endpoint must not
// permit, and the reason validation alone would not be enough.
//
// THE CATALOGUE IS ENFORCED AGAIN HERE, at runtime, against the same
// `@relayed/telemetry` the client compiles against. §8: "a catalogue enforced
// only by types is enforced only for callers who ran our compiler." The client
// already drops uncatalogued records in `sync/telemetry-relay.ts`; this is the
// check that still holds when the caller is not the client we built.
import type { FastifyInstance } from 'fastify';
import { events, metrics } from '@relayed/telemetry/catalogue';
import { count, type OtlpSink } from '@relayed/telemetry';
import { caller } from '../auth/caller.ts';

/**
 * What one posted record may be.
 *
 * Deliberately narrow: a name, and either fields or labels. There is no free
 * text anywhere, because `FieldType` has no `'string'` — §8's "absent type",
 * which is what keeps an unbounded value out of the series budget.
 */
interface Incoming {
  kind?: unknown;
  name?: unknown;
  value?: unknown;
  fields?: unknown;
  labels?: unknown;
}

/**
 * Bounds, because this endpoint is reachable by anything holding a session.
 *
 * A batch larger than this is TRUNCATED rather than refused: the honest failure
 * for telemetry is losing some of it, never rejecting a request the client will
 * then retry with the same oversized body.
 */
const MAX_RECORDS = 500;
/** Per record, so one pathological entry cannot carry a payload of its own. */
const MAX_KEYS = 24;
const MAX_VALUE_CHARS = 120;

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};

/**
 * Keep only what the catalogue declares for this name, and clamp what is left.
 *
 * SCRUBBING IS DROPPING, NOT TRUNCATING A NAME. An undeclared field is removed
 * entirely rather than renamed or coerced — the catalogue is the schema, and a
 * field it does not name is a field nobody agreed to store.
 */
function scrub(allowed: readonly string[], supplied: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let kept = 0;
  for (const key of allowed) {
    if (kept >= MAX_KEYS) break;
    if (!(key in supplied)) continue;
    const v = supplied[key];
    if (typeof v === 'number' || typeof v === 'boolean') { out[key] = v; kept++; continue; }
    if (typeof v === 'string') { out[key] = v.slice(0, MAX_VALUE_CHARS); kept++; }
    // Anything else — an object, an array, a function that survived JSON — is
    // not a value this catalogue can express, so it does not become one.
  }
  return out;
}

export interface TelemetryIngestDeps {
  /**
   * Where validated records go. A sink constructed with `service: 'desktop'`,
   * so client records land under their own service name rather than being
   * mistaken for the server's own — the same signal, from a different machine,
   * is a different series.
   */
  sink: OtlpSink | null;
}

export function telemetryRoutes(deps: TelemetryIngestDeps) {
  return async function routes(app: FastifyInstance): Promise<void> {
    app.post<{ Body: { records?: unknown; dropped?: unknown } }>(
      '/telemetry', async (req, reply) => {
        const me = await caller(req.headers.authorization);
        // 401 rather than silent success: an unauthenticated client should stop
        // sending and re-authenticate, not keep posting into the void.
        if (!me) return reply.code(401).send({ error: 'unauthenticated' });

        const body = req.body ?? {};
        const list = Array.isArray(body.records) ? body.records.slice(0, MAX_RECORDS) : [];

        // What the CLIENT already threw away before it got here, counted so a
        // dashboard can say whether the numbers beside it are complete.
        if (typeof body.dropped === 'number' && body.dropped > 0) {
          count('telemetry.dropped', { signal: 'records' }, body.dropped);
        }

        let accepted = 0;
        for (const raw of list) {
          const r = raw as Incoming;
          const name = typeof r?.name === 'string' ? r.name : '';
          if (!name) continue;

          if (r.kind === 'event') {
            const spec = (events as Record<string, { fields: Record<string, string> }>)[name];
            if (!spec) continue;
            deps.sink?.event(
              name as never,
              // Attribution is OURS. Merged last so a client cannot overwrite it.
              { ...scrub(Object.keys(spec.fields), asRecord(r.fields)),
                actor: me.actorId, workspace: me.workspaceId } as never,
            );
            accepted++;
          } else if (r.kind === 'count' || r.kind === 'histogram') {
            const spec = (metrics as Record<string, { labels?: readonly string[] }>)[name];
            if (!spec) continue;
            const labels = scrub(spec.labels ?? [], asRecord(r.labels)) as Record<string, string>;
            if (r.kind === 'count') {
              deps.sink?.count(name, labels as never);
            } else if (typeof r.value === 'number' && Number.isFinite(r.value)) {
              deps.sink?.histogram(name, r.value, labels as never);
            } else {
              continue;
            }
            accepted++;
          }
        }

        // Counted per batch rather than per record: this is the metric that says
        // whether clients are reporting at all, and one series per batch is the
        // shape that answers it.
        count('telemetry.ingested', { signal: 'records' }, accepted);
        // 202, and never an error for a bad record. Telemetry must not be able
        // to make a client retry, back off, or surface a failure to a person.
        return reply.code(202).send({ accepted });
      });
  };
}
