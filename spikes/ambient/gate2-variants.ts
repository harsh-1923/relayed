// Gate 2 wordings, tried on every draft the spike produced, each labelled by
// hand before this ran: is it worth posting unprompted? No new drafts — the
// same texts, three ways of asking about them.
import { readFileSync, writeFileSync } from 'node:fs';
import { env } from '../../apps/server/src/env.ts';
import { pool } from '../../apps/server/src/db/client.ts';
import { jevClient } from '../../apps/server/src/agents/ambient/jev.ts';
import { plainText } from '../../apps/server/src/agents/ambient/gates.ts';

const LABELS: Record<string, 'post' | 'hold' | 'either'> = {
  S01: 'post', S02: 'post', S03: 'post', S05: 'post', S06: 'post', S07: 'post', S21: 'post', S24: 'post',
  S08: 'either', S22: 'hold', S27: 'hold',
};
export const WORDINGS = {
  literal: '`draft` directly and materially answers `question`.',
  useful: '`draft` would help the person who wrote `question`: it answers it, or tells them something specific they need to answer it.',
  deflects: '`draft` mostly says it cannot see, check or know what was asked.',
};

const jev = jevClient({ apiKey: env.typesafeApiKey!, baseUrl: env.typesafeBaseUrl });
const run = JSON.parse(readFileSync(new URL('./results/run-v1.json', import.meta.url), 'utf8'));
const rows: unknown[] = [];
for (const s of run.scenarios) {
  for (const look of s.looks) {
    for (const key of ['draft', 'currentDraft']) {
      const draft = look[key];
      if (!draft?.text || !LABELS[s.id]) continue;
      const question = s.events.find((e: { key: string }) => e.key === draft.question);
      const state = { question: { from: 'someone', text: plainText(question.text) }, draft: plainText(draft.text) };
      const scores: Record<string, number[]> = { literal: [], useful: [], deflects: [] };
      for (let rep = 0; rep < 2; rep++) {
        const judged = await jev.ask(state, Object.fromEntries(Object.entries(WORDINGS).map(([k, v]) => [k, { type: 'noul' as const, instructions: v }])));
        for (const k of Object.keys(WORDINGS)) scores[k]!.push((judged.answers as Record<string, { noul: number }>)[k]!.noul);
      }
      rows.push({ id: s.id, label: LABELS[s.id], scores });
      const f = (xs: number[]) => xs.map(x => x.toFixed(2)).join('/');
      console.log(`${s.id} ${LABELS[s.id]!.padEnd(6)} literal ${f(scores.literal!)}  useful ${f(scores.useful!)}  deflects ${f(scores.deflects!)}`);
    }
  }
}
writeFileSync(new URL('./results/gate2-variants.json', import.meta.url), JSON.stringify({ wordings: WORDINGS, rows }, null, 2) + '\n');
await pool.end();
