// The tuning harness (docs/AMBIENT-RESPONSES.md, rollout and tuning §10.1).
//
//   pnpm --filter @relayed/server run ambient-gate <chat-id> [messages]
//
// Runs both steps over a chat's newest messages — 20 unless told otherwise —
// every person's message judged as if it were one turn, and prints every
// probability beside the bar it is compared with, and what the loop would
// decide. Writes nothing and posts nothing: it is how the thresholds get moved
// against real rooms rather than argued about.
//
// Every agent in the chat is a candidate here, whatever AMBIENT_AGENTS says —
// the question is what Jev thinks, not who is switched on.
import { db, pool } from '../src/db/client.ts';
import { env } from '../src/env.ts';
import { jevClient, JevError } from '../src/agents/ambient/jev.ts';
import { THRESHOLDS } from '../src/agents/ambient/gates.ts';
import { probe } from '../src/agents/ambient/loop.ts';

const [chatId, count] = process.argv.slice(2);
if (!chatId) { console.error('usage: ambient-gate <chat-id> [messages]'); process.exit(1); }
if (!env.typesafeApiKey) { console.error('TYPESAFE_API_KEY is not set.'); process.exit(1); }

const jev = jevClient({ apiKey: env.typesafeApiKey, baseUrl: env.typesafeBaseUrl });
const n = (value: number | undefined) => (value ?? NaN).toFixed(2);
const mark = (ok: boolean) => (ok ? '✓' : '✗');
try {
  const found = await probe(db, jev, chatId, null, count ? Number(count) : undefined);
  if (!found) { console.error(`no such chat: ${chatId}`); process.exit(1); }
  const T = THRESHOLDS;

  console.log(`\n${found.room} · ${found.message.model}`);
  console.log(`\nstep 1 — each person's message (bars: asks > ${T.need}, answered < ${T.answered}, to a person < ${T.toPerson}, `
    + `meant > ${T.wants}, needs a person < ${T.needsPerson}, sensitive < ${T.sensitive}, a plan < ${T.plan})`);
  found.recent.forEach((line, index) => {
    const text = `${line.from}: ${line.text.replace(/\s+/g, ' ').slice(0, 70)}`;
    const s = found.turn.scores[index];
    if (!s) { console.log(`       m${index}  ${text}`); return; }
    const open = found.turn.open.includes(index);
    console.log(`   ${open ? '→' : ' '} ${mark(open)} m${index}  ${text}`);
    console.log(`            asks ${n(s.need)}  answered ${n(s.answered)}  to a person ${n(s.toPerson)}  meant ${n(s.wants)}`
      + `  needs a person ${n(s.person)}  sensitive ${n(s.sensitive)}  a plan ${n(s.plan)}`);
  });
  console.log(`\n   open: ${found.turn.open.length === 0 ? `none — ${found.turn.because}` : found.turn.open.map(i => `m${i}`).join(', ')}`);

  if (found.agent && found.decision) {
    const agent = found.agent.answers as Record<string, { noul?: number; choice?: string; probabilities?: Record<string, number> }>;
    console.log(`\nstep 2 — which agent (bar: the best fit > ${T.fits}; Jev's pick breaks a tie within ${T.fitTie})`);
    console.log(`   pick: ${agent['best_agent']?.choice}  ${JSON.stringify(agent['best_agent']?.probabilities)}`);
    found.candidates.forEach((candidate, index) => {
      const role = agent[`fits_role_${index}`]!.noul!;
      const here = agent[`fits_here_${index}`]!.noul!;
      console.log(`   ${mark(Math.max(role, here) > T.fits)} ${candidate.key}  by setup ${n(role)}  by what it did here ${n(here)}`
        + `   (set up as "${candidate.setUpAs.replace(/\s+/g, ' ').slice(0, 50)}", ${candidate.doneHere.length} of its messages here)`);
    });
    const decision = found.decision;
    console.log(`\ndecision: ${decision.speak
      ? `speak — ${found.candidates[decision.candidateIndex]!.key} answers m${found.turn.open.at(-1)}, then the draft check decides what posts`
      : `silent — ${decision.because}`}\n`);
  } else {
    console.log(`\ndecision: silent — ${found.turn.because}\n`);
  }
} catch (error) {
  console.error(error instanceof JevError ? `Jev failed: ${error.reason}` : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
