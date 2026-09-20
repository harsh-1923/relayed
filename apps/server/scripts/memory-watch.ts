// One line per agent run as it finishes, saying whether memory was cited
// (docs/MEMORY.md §7.2).
//
//   pnpm --filter @relayed/server run memory-watch
//
// The question this answers is not "did recall run" but "did the reply DRAW ON
// anything" — which is the `memory` part's whole point, and the same number
// §14.6 calls the consequential one. A run that recalled six facts and cited
// none reads as `memory: offered, none cited`, which is honest and is the
// common case.
//
// Polls rather than listens: a run finishing is a row changing state, and there
// is no event stream for that outside the socket a client holds.
import { sql } from 'kysely';
import { db, pool } from '../src/db/client.ts';
import { env } from '../src/env.ts';

const POLL_MS = 3_000;

interface Row {
  id: string; state: string; finished_at: Date | null; agent: string;
  space_kind: string; space_name: string | null; parts: unknown;
}

const kindOf = (part: unknown): string => {
  const kind = (part as { kind?: unknown }).kind;
  return typeof kind === 'string' ? kind : '?';
};

const partKinds = (parts: unknown): string[] =>
  Array.isArray(parts) ? parts.map(kindOf) : [];

/**
 * What the `memory` part holds: every fact the run was offered, each marked
 * `used` or not (`MemoryPart`, packages/protocol/src/parts.ts). Both numbers
 * matter — offered-but-never-cited is §14.6's noise signal, and a script that
 * printed only the citations could not tell it from no recall at all.
 */
const recalled = (parts: unknown): { text: string; label: string; used: boolean }[] => {
  if (!Array.isArray(parts)) return [];
  const memory = parts.find((part) => kindOf(part) === 'memory') as
    { recalled?: { text?: string; label?: string; used?: boolean }[] } | undefined;
  return (memory?.recalled ?? []).map((one) => ({
    text: one.text ?? '', label: one.label ?? '?', used: one.used === true,
  }));
};

// Everything already finished is history; this reports what happens from now.
const startedAt = new Date();
console.log(`watching agent runs from ${startedAt.toISOString().slice(11, 19)} · ` +
            `MEMORY_RECALL=${env.memoryRecall ? 'on' : 'OFF — no run can cite anything'}`);

const seen = new Set<string>();
let stopped = false;
process.on('SIGINT', () => { stopped = true; });

while (!stopped) {
  const rows = await sql<Row>`
    SELECT r.id, r.state, r.finished_at, a.handle AS agent,
           s.kind AS space_kind, s.name AS space_name, m.parts
      FROM agent_runs r
      JOIN chats ch  ON ch.id = r.chat_id
      JOIN spaces s  ON s.id = ch.space_id
      JOIN actors a  ON a.id = r.agent_actor_id
      LEFT JOIN messages m ON m.id = r.reply_message_id
     WHERE r.finished_at IS NOT NULL AND r.finished_at > ${startedAt}
     ORDER BY r.finished_at`.execute(db).catch(() => ({ rows: [] as Row[] }));

  for (const row of rows.rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const where = row.space_kind === 'dm' ? 'dm' : `${row.space_kind} ${row.space_name ?? ''}`.trim();
    const facts = recalled(row.parts);
    const cited = facts.filter((fact) => fact.used);
    const kinds = partKinds(row.parts);
    const summary = facts.length === 0 ? 'nothing recalled'
      : `recalled ${facts.length}, cited ${cited.length}`;
    console.log(`${(row.finished_at ?? new Date()).toISOString().slice(11, 19)} ` +
                `@${row.agent} in ${where} — ${row.state} · parts[${kinds.join(',') || '-'}] · memory: ${summary}`);
    // The unused ones too: a fact offered every run and never cited is the one
    // worth looking at.
    for (const fact of facts) console.log(`    ${fact.used ? '·' : ' '} ${fact.text} [${fact.label}]`);
  }
  await new Promise((resolve) => setTimeout(resolve, POLL_MS));
}
await pool.end();
