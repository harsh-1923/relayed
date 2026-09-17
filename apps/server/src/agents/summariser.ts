// The room summariser (docs/DOCUMENTS.md §4): a job, not a run.
//
// EVERY RUN NEEDS AN INVOKER whose authority it spends — permissions,
// connections, access cards (WORKSPACE-AGENTS.md §5.5). A refresh has none:
// nobody asked for it. Inventing a fake invoker would put a person's name on
// something they did not ask for and their connections behind something they
// cannot see, so this is a job in the shape `catalogue.ts` already uses: claim
// work, do it, write the result.
//
// It still acts AS AN ACTOR — the Roomkeeping agent — and that is what makes
// the privacy rule need no special case: the agent is a member of the room, and
// the ordinary access predicate decides what it may read (§4.3). A system
// writer with no actor would need a second answer to "what may this read", and
// two answers to that question is how leaks happen.
//
// No tools, so nothing outside Relayed can reach the summary: no ticket bodies,
// no pages, nothing somebody in the room cannot already see.
import { sql, type Kysely } from 'kysely';
import { count, histogram } from '@relayed/telemetry';
import type { RunRequest } from '@relayed/protocol';
import type { DB } from '../db/schema.ts';
import { env } from '../env.ts';
import { ulid } from '../db/ulid.ts';
import { fanout } from '../sync/fanout.ts';
import type { Registry } from '../sync/registry.ts';
import { visibleTo } from '../sync/visibility.ts';
import { writeDocumentRevision } from '../sync/documents.ts';
import { callRuntime } from './runtime-client.ts';
import { SIZE_LIMIT_BYTES } from './transcript.ts';
import { PEOPLE_PROMPT, personLabel } from './people.ts';
import { SUMMARY_SHAPE } from './writing.ts';

/** How long a claim is held. A lease in the past means the server that took it is gone (§4.4). */
const LEASE_SEC = 120;
/** Never twice within this for one room: a burst crossing the threshold twice in a second is one refresh. */
const FLOOR_SEC = 60;
/** Every Nth revision ignores the previous body and reads a wide window instead (§4.5). */
const REBUILD_EVERY = 20;
/** The rebuild's window, in messages. */
const REBUILD_WINDOW = 400;
/** A refresh that takes longer than this is not going to produce anything useful. */
const RUNTIME_TIMEOUT_MS = 90_000;
/** Failures double the wait, to here. */
const BACKOFF_CEILING_SEC = 30 * 60;
/** How many rooms one pass will refresh. The rest wait for the next tick rather than a long serial burn. */
const BATCH = 5;
const POLL_MS = 30_000;

// ─── Picking work ───────────────────────────────────────────────────────────

interface DueSummary {
  documentId: string;
  workspaceId: string;
  spaceId: string;
  roomkeeperId: string;
  rev: number;
  body: string;
  coveredThrough: Record<string, number>;
  newMessages: number;
}

/**
 * Rooms whose summary is behind by at least the threshold.
 *
 * The decision needs two numbers — how far the summary has read, and how far
 * the chats have got — and both are already stored, which is why there is no
 * queue table: a queue would be a third copy of the same fact, able to
 * disagree with it.
 *
 * Every conjunct here is a rule from §4.3 or §4.4 rather than an optimisation:
 * Roomkeeping must be an ACTIVE member of the space (its membership IS the
 * privacy boundary), only the room's `default` and `public` chats count (a
 * private chat needs a chat-scoped membership it does not have), a restricted
 * message counts only if the agent is listed on it (it will not be), and a
 * dormant or archived room is skipped — its summary stays exactly as it is.
 */
export async function dueSummaries(db: Kysely<DB>, threshold: number, limit: number): Promise<DueSummary[]> {
  const rows = await sql<{
    id: string; workspace_id: string; space_id: string; roomkeeper_id: string;
    rev: number; body: string; covered_through: unknown; new_messages: number;
  }>`
    SELECT d.id, d.workspace_id, d.space_id, rk.id AS roomkeeper_id,
           d.rev, d.body, d.covered_through, SUM(x.n)::int AS new_messages
      FROM documents d
      JOIN spaces s ON s.id = d.space_id AND s.kind = 'room' AND s.lifecycle = 'active'
      JOIN actors rk ON rk.workspace_id = d.workspace_id AND rk.handle = 'roomkeeping'
                    AND rk.provisioned_by = 'system' AND rk.state = 'active'
      JOIN memberships mem ON mem.scope_type = 'space' AND mem.scope_id = d.space_id
                          AND mem.actor_id = rk.id AND mem.left_at IS NULL
      JOIN chats c ON c.space_id = d.space_id AND c.kind IN ('default', 'public')
      CROSS JOIN LATERAL (
        SELECT count(*)::int AS n
          FROM messages m
         WHERE m.chat_id = c.id
           AND m.deleted = false
           AND m.ord > COALESCE((d.covered_through ->> c.id)::bigint, 0)
           AND (m.visible_to IS NULL OR rk.id = ANY(m.visible_to))
      ) x
     WHERE d.kind = 'room_summary'
       AND (d.refresh_lease_until IS NULL OR d.refresh_lease_until < now())
       AND d.updated_at < now() - (${FLOOR_SEC} * interval '1 second')
     GROUP BY d.id, rk.id
    HAVING SUM(x.n) >= ${threshold}
     ORDER BY SUM(x.n) DESC
     LIMIT ${limit}
  `.execute(db);

  return rows.rows.map(row => ({
    documentId: row.id, workspaceId: row.workspace_id, spaceId: row.space_id,
    roomkeeperId: row.roomkeeper_id, rev: Number(row.rev), body: row.body,
    coveredThrough: watermark(row.covered_through), newMessages: Number(row.new_messages),
  }));
}

/**
 * One room's summary as a refresh candidate, whatever the threshold says.
 *
 * What `Refresh now` uses (§4.4): somebody pressing the button has said the
 * panel is behind, and the count is exactly the thing they are overruling. The
 * lease is not overruled — a refresh already running is the refresh they wanted
 * — and neither are the membership and lifecycle rules, which are about what
 * may be read rather than when.
 */
export async function summaryOf(db: Kysely<DB>, spaceId: string): Promise<DueSummary | null> {
  const rows = await sql<{
    id: string; workspace_id: string; space_id: string; roomkeeper_id: string;
    rev: number; body: string; covered_through: unknown;
  }>`
    SELECT d.id, d.workspace_id, d.space_id, rk.id AS roomkeeper_id, d.rev, d.body, d.covered_through
      FROM documents d
      JOIN spaces s ON s.id = d.space_id AND s.kind = 'room' AND s.lifecycle = 'active'
      JOIN actors rk ON rk.workspace_id = d.workspace_id AND rk.handle = 'roomkeeping'
                    AND rk.provisioned_by = 'system' AND rk.state = 'active'
      JOIN memberships mem ON mem.scope_type = 'space' AND mem.scope_id = d.space_id
                          AND mem.actor_id = rk.id AND mem.left_at IS NULL
     WHERE d.kind = 'room_summary' AND d.space_id = ${spaceId}
  `.execute(db);
  const row = rows.rows[0];
  if (!row) return null;
  return {
    documentId: row.id, workspaceId: row.workspace_id, spaceId: row.space_id,
    roomkeeperId: row.roomkeeper_id, rev: Number(row.rev), body: row.body,
    coveredThrough: watermark(row.covered_through), newMessages: 0,
  };
}

function watermark(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [chatId, ord] of Object.entries(value as Record<string, unknown>)) {
    if (typeof ord === 'number' && Number.isFinite(ord)) out[chatId] = ord;
  }
  return out;
}

/**
 * Take the claim, or discover somebody else has it.
 *
 * One conditional UPDATE, so the check and the claim cannot be separated by
 * another server doing the same thing. `false` means a second server got there
 * between our read and our write, which is ordinary rather than an error.
 */
async function claim(db: Kysely<DB>, documentId: string): Promise<boolean> {
  const result = await db.updateTable('documents')
    .set({ refresh_lease_until: sql`now() + (${LEASE_SEC} * interval '1 second')` })
    .where('id', '=', documentId)
    .where(eb => eb.or([
      eb('refresh_lease_until', 'is', null),
      eb(sql`refresh_lease_until`, '<', sql`now()`),
    ]))
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

/**
 * A failed refresh: the previous body stays, the watermark does not move, and
 * the same messages are read again next time (§4.7).
 *
 * The backoff is written into the LEASE, which is the same column the claim
 * already respects — a lease in the future means "not yours" whether it is held
 * by a working server or by a room that keeps failing. `refresh_failures` is
 * what tells the two apart, and a success resets it.
 */
async function fail(db: Kysely<DB>, documentId: string): Promise<void> {
  await db.updateTable('documents')
    .set({
      refresh_failures: sql`refresh_failures + 1`,
      refresh_lease_until: sql`now() + (LEAST(${BACKOFF_CEILING_SEC},
        60 * POWER(2, LEAST(refresh_failures, 10))) * interval '1 second')`,
    })
    .where('id', '=', documentId)
    .execute();
}

// ─── What it reads ──────────────────────────────────────────────────────────

interface Line {
  chatId: string;
  ord: number;
  text: string;
}

/**
 * The messages this refresh is given, oldest first, under the same byte budget
 * an agent transcript uses.
 *
 * Read with the AGENT's access and nobody else's — `visibleTo` is the clause
 * every other read path uses, so a restricted message is invisible here for the
 * same reason it is invisible everywhere (invariant 79: the clause goes in the
 * query, before the limit).
 */
async function readMessages(
  db: Kysely<DB>, input: { spaceId: string; roomkeeperId: string;
    coveredThrough: Record<string, number>; rebuild: boolean },
): Promise<Line[]> {
  const chats = await db.selectFrom('chats').select('id')
    .where('space_id', '=', input.spaceId)
    .where('kind', 'in', ['default', 'public'])
    .execute();
  if (chats.length === 0) return [];
  const chatIds = chats.map(chat => chat.id);

  const rows = await db.selectFrom('messages as m')
    .innerJoin('actors as a', 'a.id', 'm.author_id')
    .select(['m.id', 'm.chat_id', 'm.ord', 'm.body', 'm.created_at', 'm.author_id',
             'a.display_name as author_name', 'a.handle as author_handle'])
    .where('m.chat_id', 'in', chatIds)
    .where('m.deleted', '=', false)
    .where(visibleTo('m', input.roomkeeperId))
    // A rebuild deliberately ignores the watermark: it is the cure for a
    // summary of a summary of a summary, and reading only the delta would be
    // the disease (§4.5).
    .$if(!input.rebuild, qb => qb.where(eb => eb.or(chatIds.map(chatId =>
      eb.and([eb('m.chat_id', '=', chatId), eb('m.ord', '>', input.coveredThrough[chatId] ?? 0)])))))
    .orderBy('m.created_at', 'desc')
    .limit(input.rebuild ? REBUILD_WINDOW : 2000)
    .execute();

  return rows.reverse().map(row => ({
    chatId: row.chat_id, ord: Number(row.ord),
    text: `${personLabel({ id: row.author_id, displayName: row.author_name, handle: row.author_handle })}: ${row.body}`,
  }));
}

/** How far this pass read, per chat — what the next one starts after. */
function reached(lines: readonly Line[], from: Record<string, number>): Record<string, number> {
  const out = { ...from };
  for (const line of lines) out[line.chatId] = Math.max(out[line.chatId] ?? 0, line.ord);
  return out;
}

/** Oldest dropped first: what somebody said an hour ago matters less than what they said now. */
function withinBudget(lines: readonly Line[]): Line[] {
  const kept: Line[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    const size = Buffer.byteLength(line.text, 'utf8') + 1;
    if (bytes + size > SIZE_LIMIT_BYTES) break;
    kept.unshift(line);
    bytes += size;
  }
  return kept;
}

// ─── What it is asked ───────────────────────────────────────────────────────

/**
 * The standing rules (§4.6). Suggestions, not a template: a room with nothing
 * decided yet must not render four empty headings, which is what a fixed
 * skeleton would produce on its first pass.
 */
export const RULES = [
  'You are writing the running summary of one room, for the people in it.',
  'It answers "what is going on here right now?" for somebody who has just arrived — the present first, the past',
  'only as much as it still explains the present.',
  '',
  SUMMARY_SHAPE,
  '',
  'Rules:',
  '- Describe the STATE. Do not narrate the transcript: no "Alice said, then Bob said".',
  '- Say nothing you cannot support from the messages you were given.',
  '- Prefer dropping a section to padding it. A short true summary beats a full one.',
  '- Markdown, no top-level heading, no preamble, no sign-off. Output the summary and nothing else.',
  '',
  PEOPLE_PROMPT,
  // A summary is read, not sent: it names people and never pings them. The
  // model still writes the link itself (see the note in `people.ts`).
  'In the summary, only ever refer to people — never mention them.',
].join('\n');

export function buildPrompt(input: { previous: string; lines: readonly Line[]; rebuild: boolean }): string {
  const messages = input.lines.map(line => line.text).join('\n');
  if (input.rebuild || input.previous.trim().length === 0) {
    return `Recent messages in this room:\n\n${messages}\n\nWrite the room's summary.`;
  }
  return [
    'The room’s summary as it currently stands:', '', input.previous, '',
    'Messages since it was last written:', '', messages, '',
    // NOT "keep what is true and fold in what is new": that is an instruction
    // to append, and the summary only ever grew under it.
    'Write the summary again, in the shape above. Put what is new at the top of its section; move what is no longer',
    'current into Earlier as one line; shorten what is there if it is past the length limits. It must not be longer',
    'than it needs to be just because the previous one was.',
  ].join('\n');
}

// ─── One refresh ────────────────────────────────────────────────────────────

export type RefreshOutcome = 'written' | 'nothing_to_say' | 'claimed_elsewhere' | 'failed';

/**
 * One pass over one room: read what is new, ask for the next summary, write it.
 *
 * Exported so `Refresh now` and the tests can do exactly what the loop does —
 * one code path, so a refresh somebody asked for cannot behave differently from
 * one the threshold triggered.
 */
export async function refreshSummary(
  db: Kysely<DB>, registry: Registry | null, due: DueSummary,
): Promise<RefreshOutcome> {
  if (!await claim(db, due.documentId)) return 'claimed_elsewhere';

  const rebuild = due.rev > 0 && (due.rev + 1) % REBUILD_EVERY === 0;
  try {
    const all = await readMessages(db, {
      spaceId: due.spaceId, roomkeeperId: due.roomkeeperId,
      coveredThrough: due.coveredThrough, rebuild,
    });
    if (all.length === 0) {
      // Nothing readable after all — every new message was one this agent may
      // not see. Not a failure, and the watermark still moves, or the same
      // invisible messages are recounted for ever.
      await writeWatermarkOnly(db, due, reached(all, due.coveredThrough));
      return 'nothing_to_say';
    }

    const agent = await db.selectFrom('agents')
      .select(['instructions', 'model', 'thinking_level'])
      .where('actor_id', '=', due.roomkeeperId).executeTakeFirstOrThrow();

    const body: RunRequest = {
      runId: ulid('job'),
      prompt: buildPrompt({ previous: due.body, lines: withinBudget(all), rebuild }),
      systemPrompt: `${agent.instructions}\n\n${RULES}`,
      palette: 'none',
      // No tools, and so no grant: `RunRequest.grant` is already optional for a
      // toolless run, which is what lets a job call the runtime at all (§4.2).
      tools: [],
      ...(agent.model ? { model: agent.model } : {}),
    };

    const text = await runToCompletion(body);
    if (!text) {
      await fail(db, due.documentId);
      count('summary.refresh', { result: 'error' });
      return 'failed';
    }

    if (text === due.body.trim()) {
      // The new messages changed nothing worth saying. A revision here would be
      // a duplicate in the history and an event telling every client to
      // re-render text it already has — so only the watermark moves, and the
      // panel keeps the `updated_at` it honestly earned.
      await writeWatermarkOnly(db, due, reached(all, due.coveredThrough));
      count('summary.refresh', { result: 'ok' });
      return 'nothing_to_say';
    }

    const written = await writeDocumentRevision(db, {
      documentId: due.documentId, body: text, authorActorId: due.roomkeeperId,
      coveredThrough: reached(all, due.coveredThrough),
    });
    if (registry) await fanout(db, registry, written.event);
    count('summary.refresh', { result: 'ok' });
    histogram('summary.refresh.messages', all.length);
    return 'written';
  } catch {
    // Nothing here may throw into the loop: one room that cannot be summarised
    // must not stop every other room, and the backoff is what stops it burning
    // budget on the next tick.
    await fail(db, due.documentId).catch(() => {});
    count('summary.refresh', { result: 'error' });
    return 'failed';
  }
}

/**
 * Move the watermark without writing a revision.
 *
 * For a pass that found nothing to say: the body is unchanged, so a revision
 * would be a duplicate in the history and an event that tells every client
 * nothing. The lease is released and the failure count reset, because nothing
 * failed.
 */
async function writeWatermarkOnly(
  db: Kysely<DB>, due: DueSummary, coveredThrough: Record<string, number>,
): Promise<void> {
  await db.updateTable('documents')
    .set({
      covered_through: sql`${JSON.stringify(coveredThrough)}::jsonb`,
      refresh_failures: 0, refresh_lease_until: null,
    })
    .where('id', '=', due.documentId)
    .execute();
}

/** The runtime's answer, or null for anything that is not a completed run with text in it. */
async function runToCompletion(body: RunRequest): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RUNTIME_TIMEOUT_MS);
  try {
    for await (const frame of callRuntime(body, controller.signal)) {
      if (frame.kind !== 'done') continue;
      const text = frame.result.text.trim();
      return frame.result.status === 'completed' && text.length > 0 ? text : null;
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── The loop ───────────────────────────────────────────────────────────────

export interface Summariser {
  /** Run a pass now — used at startup and by a test; never awaited by a request. */
  tick: () => void;
  stop: () => void;
}

/** One pass: the rooms furthest behind, up to `BATCH`, in order. */
export async function refreshDue(db: Kysely<DB>, registry: Registry | null): Promise<number> {
  const due = await dueSummaries(db, env.summaryThreshold, BATCH);
  let written = 0;
  for (const room of due) {
    if (await refreshSummary(db, registry, room) === 'written') written += 1;
  }
  return written;
}

export function startSummariser(db: Kysely<DB>, registry: Registry, intervalMs = POLL_MS): Summariser {
  let stopped = false;
  let running = false;
  const tick = (): void => {
    if (stopped || running) return;   // one pass at a time: a slow runtime must not stack ticks
    running = true;
    void refreshDue(db, registry)
      .catch(() => { /* the next tick tries again; nothing here is on a request path */ })
      .finally(() => { running = false; });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();
  return { tick, stop: () => { stopped = true; clearInterval(timer); } };
}
