// Reads both rounds and writes results/audit.md: every scenario judged end to
// end — did the right agent actually post an answer to the right message, or
// did nothing post when nothing should have — under three designs:
//
//   built       the window-at-once gate 1 and the literal gate 2 (round 1)
//   msg · r1    per-message, with the built bars (round 1)
//   msg · r2    per-message, with the bars round 1's numbers supported (round 2)
//   shipped     the app's own gates, SDK client and drafting rules (round 4),
//               every scenario run three times
//
// EVERY ROUND IS JUDGED AGAINST TODAY'S EXPECTATIONS — those in round 4's
// results, which carry decision 4 (stay quiet on live-state questions: S04,
// S22). Judged against their own, rounds 1 and 2 missed those two more.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

type Json = any;
const load = (name: string): Json => JSON.parse(readFileSync(new URL(`./results/${name}`, import.meta.url), 'utf8'));
const v1 = load('run-v1.json');
const v2 = load('run-v2.json');
const v4 = existsSync(new URL('./results/run-v4.json', import.meta.url)) ? load('run-v4.json') : null;
const current: Record<string, Json> = Object.fromEntries((v4 ?? v2).scenarios.map((s: Json) => [s.id, s.expected]));
for (const run of [v1, v2, v4].filter(Boolean)) for (const s of run.scenarios) s.expected = current[s.id] ?? s.expected;

type Verdict = { ok: boolean; what: string; draftsSpent: number; postedAfter: number | null };

function liveIndexOf(s: Json, key: string): number | null {
  return s.events.find((e: Json) => e.key === key)?.live ?? null;
}

/** What one design did in one scenario, end to end. */
function judge(s: Json, design: 'built' | 'msg'): Verdict {
  const ex = s.expected;
  const posts: { agent: string; question: string; at: number; via: string }[] = [];
  const notes: string[] = [];
  let drafts = 0;
  for (const look of s.looks) {
    if (look.kind === 'mention') { notes.push('mention path'); continue; }
    if (look.kind === 'follow_up') {
      if (look.draft) {
        drafts += 1;
        if (look.draft.outcome === 'posted') posts.push({ agent: look.agent, question: look.draft.question, at: look.draft.clock, via: 'follow-up' });
        else notes.push(`follow-up ${look.draft.outcome}${look.draft.because ? ` (${look.draft.because})` : ''}`);
      } else notes.push(look.forAgent ? 'follow-up' : 'follow-up: not for the agent');
      continue;
    }
    const decision = design === 'built' ? look.current.decision : look.proposed.decision;
    if (!decision) { notes.push('gate error'); continue; }
    if (!decision.speak) { notes.push(`quiet: ${decision.because}`); continue; }
    // The built design's draft is `currentDraft` when it chose differently,
    // otherwise the shared `draft` — which in round 1 went through the literal gate 2.
    const draft = design === 'built'
      ? (look.currentDraft ?? (look.draft && look.draft.question === decision.question && look.draft.agent === decision.agent ? look.draft : null))
      : look.draft;
    if (!draft) { notes.push('spoke, no draft'); continue; }
    drafts += 1;
    if (draft.outcome === 'posted') posts.push({ agent: decision.agent, question: decision.question, at: draft.clock, via: 'lull' });
    else notes.push(`${decision.agent} drafted → ${draft.outcome}${draft.because ? ` (${draft.because})` : ''}`);
  }
  const first = posts[0];
  const postedAfter = first ? Math.round(first.at - (s.events.find((e: Json) => e.key === first.question)?.t ?? 0)) : null;
  const said = first ? `@${first.agent} answered m${liveIndexOf(s, first.question)} via ${first.via}, ${postedAfter}s after it` : notes.join('; ') || 'nothing';

  if (ex.kind === 'answer') {
    const wanted = Array.isArray(ex.message) ? ex.message : [ex.message];
    const right = posts.find(p => p.agent === ex.agent && wanted.includes(liveIndexOf(s, p.question)));
    return { ok: Boolean(right), what: right ? said : posts.length ? `WRONG: ${said}` : `MISSED — ${said}`, draftsSpent: drafts, postedAfter };
  }
  if (ex.kind === 'silent' || ex.kind === 'mention') {
    return { ok: posts.length === 0, what: posts.length ? `SPOKE: ${said}` : `quiet — ${notes.join('; ')}`, draftsSpent: drafts, postedAfter };
  }
  return { ok: true, what: said, draftsSpent: drafts, postedAfter };
}

const byId = (run: Json) => Object.fromEntries(run.scenarios.map((s: Json) => [s.id, s]));
const r1 = byId(v1);
const r2 = byId(v2);
const ids: string[] = v2.scenarios.map((s: Json) => s.id);

/** Round 4, three runs of each scenario, folded into one verdict: right only if right every time. */
function shipped(id: string): (Verdict & { runs: number; right: number }) | null {
  if (!v4) return null;
  const runs = v4.scenarios.filter((s: Json) => s.id === id).map((s: Json) => judge(s, 'msg'));
  if (runs.length === 0) return null;
  const right = runs.filter((v: Verdict) => v.ok).length;
  const failing = runs.find((v: Verdict) => !v.ok);
  return {
    ok: right === runs.length, runs: runs.length, right,
    what: `${right}/${runs.length} runs · ${(failing ?? runs[0]).what}`,
    draftsSpent: runs.reduce((n: number, v: Verdict) => n + v.draftsSpent, 0), postedAfter: runs[0].postedAfter,
  };
}

const rows = ids.map(id => {
  const s = r2[id];
  const built = r1[id] ? judge(r1[id], 'built') : null;
  const m1 = r1[id] ? judge(r1[id], 'msg') : null;
  const m2 = judge(s, 'msg');
  return { id, s, built, m1, m2, m4: shipped(id) };
});

function totals(pick: (r: typeof rows[number]) => Verdict | null) {
  const judged = rows.map(r => ({ r, v: pick(r) })).filter(x => x.v);
  const wrong = judged.filter(x => !x.v!.ok);
  const falseSpeak = wrong.filter(x => ['silent', 'mention'].includes(x.r.s.expected.kind));
  const missed = wrong.filter(x => x.r.s.expected.kind === 'answer');
  const drafts = judged.reduce((n, x) => n + x.v!.draftsSpent, 0);
  return { n: judged.length, right: judged.length - wrong.length, falseSpeak: falseSpeak.map(x => x.r.id), missed: missed.map(x => x.r.id), drafts };
}
const T = { built: totals(r => r.built), m1: totals(r => r.m1), m2: totals(r => r.m2), m4: totals(r => r.m4) };
const runsRight = rows.reduce((n, r) => n + (r.m4?.right ?? 0), 0);
const runsTotal = rows.reduce((n, r) => n + (r.m4?.runs ?? 0), 0);

// ── Latency and size, from round 2 ──
const ms = { gate1: [] as number[], step1: [] as number[], step2: [] as number[], gate2: [] as number[], draft: [] as number[], chars1: [] as number[], chars2: [] as number[] };
for (const s of v2.scenarios) for (const look of s.looks) {
  if (look.kind !== 'ambient') continue;
  if (look.current.jevMs) ms.gate1.push(look.current.jevMs);
  if (look.proposed.jevMs) { ms.step1.push(look.proposed.jevMs); ms.chars1.push(look.proposed.chars); }
  if (look.proposed.jevMs2) { ms.step2.push(look.proposed.jevMs2); ms.chars2.push(look.proposed.chars2); }
  if (look.draft?.draftMs) ms.draft.push(look.draft.draftMs);
  if (look.draft?.gate2Ms) ms.gate2.push(look.draft.gate2Ms);
}
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : 0; };
const lat = (xs: number[]) => xs.length ? `${pct(xs, 0.5)} / ${pct(xs, 0.95)} ms` : '—';

// ── Write ──
const cell = (v: Verdict | null) => (v ? `${v.ok ? '✅' : '❌'} ${v.what}` : '—');
const expected = (ex: Json) => ex.kind === 'answer' ? `answer · @${ex.agent} · m${Array.isArray(ex.message) ? ex.message.join('/') : ex.message}` : ex.kind;
const lines: string[] = [];
lines.push(`# Ambient answers — spike audit`, '');
lines.push(`Round 1 ${v1.ranAt}, round 2 ${v2.ranAt}${v4 ? `, round 4 ${v4.ranAt} (${v4.reps} runs each)` : ''}. ${ids.length} scenarios, ${v2.model}, simulated ${v2.lullSec}s lull, real Jev and real drafts.`, '');
lines.push('Every round is judged against today\'s expectations, which carry decision 4: S04 and S22 — live-state questions — are to stay quiet. Against their own expectations rounds 1 and 2 each missed those two more.', '');
lines.push('## Headline', '');
lines.push('| | Right | Spoke when it should not | Missed an answer | Drafts spent |', '|---|---|---|---|---|');
for (const [name, t] of [['Built (window at once, literal gate 2)', T.built], ['Per-message, built bars (round 1)', T.m1], ['Per-message, adjusted (round 2)', T.m2], [`Shipped code (round 4, ${runsRight}/${runsTotal} runs right)`, T.m4]] as const) {
  lines.push(`| ${name} | **${t.right} / ${t.n}** | ${t.falseSpeak.length ? t.falseSpeak.join(', ') : 'none'} | ${t.missed.length ? t.missed.join(', ') : 'none'} | ${t.drafts} |`);
}
lines.push('', '## Every scenario', '');
lines.push('| | Scenario | Should | Built | Per-message r1 | Per-message r2 | Shipped (r4, ×3) |', '|---|---|---|---|---|---|---|');
for (const r of rows) lines.push(`| ${r.id} | ${r.s.title} | ${expected(r.s.expected)} | ${cell(r.built)} | ${cell(r.m1)} | ${cell(r.m2)} | ${cell(r.m4)} |`);

lines.push('', '## What round 2 posted, and what it held back', '');
for (const s of v2.scenarios) for (const look of s.looks) {
  const draft = look.draft;
  if (!draft?.text && draft?.outcome !== 'declined') continue;
  const q = s.events.find((e: Json) => e.key === draft.question);
  const g = draft.gate2 ? Object.entries(draft.gate2).map(([k, v]: [string, Json]) => `${k} ${v.noul.toFixed(2)}`).join(', ') : '';
  lines.push(`**${s.id} — ${draft.outcome}${draft.because ? ` (${draft.because})` : ''}** · @${draft.agent} · draft ${draft.draftMs} ms${g ? ` · ${g}` : ''}`, '');
  lines.push(`> **Q:** ${q?.text}`, '>');
  lines.push(`> **A:** ${(draft.text ?? draft.raw ?? '').replace(/\n+/g, ' ')}`, '');
}

lines.push('## Speed and size (round 2)', '');
lines.push('| | p50 / p95 |', '|---|---|');
lines.push(`| Built gate 1 (one call over the window) | ${lat(ms.gate1)} |`);
lines.push(`| Per-message step 1 (four questions per message) | ${lat(ms.step1)} |`);
lines.push(`| Per-message step 2 (which agent) | ${lat(ms.step2)} |`);
lines.push(`| Gate 2 (split, two calls in parallel) | ${lat(ms.gate2)} |`);
lines.push(`| Draft (agent runtime) | ${lat(ms.draft)} |`);
const avg = (xs: number[]) => xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0;
lines.push('', `State + questions per look: step 1 ≈ ${avg(ms.chars1)} characters, step 2 ≈ ${avg(ms.chars2)} — roughly ${Math.round((avg(ms.chars1) + avg(ms.chars2)) / 4)} tokens, or about $${((avg(ms.chars1) + avg(ms.chars2)) / 4 * 0.042 / 1e6 * 1e4).toFixed(4)} per ten thousand looks at $0.042 per million.`);

writeFileSync(new URL('./results/audit.md', import.meta.url), lines.join('\n') + '\n');
// The same verdicts as data, for anything that wants to draw them.
writeFileSync(new URL('./results/audit.json', import.meta.url), JSON.stringify({
  totals: T, runsRight, runsTotal, latency: { gate1: ms.gate1, step1: ms.step1, step2: ms.step2, gate2: ms.gate2, draft: ms.draft },
  chars: { step1: avg(ms.chars1), step2: avg(ms.chars2) },
  rows: rows.map(r => ({ id: r.id, title: r.s.title, category: r.s.category, room: r.s.room, expected: r.s.expected,
    built: r.built, m1: r.m1, m2: r.m2, m4: r.m4 })),
}, null, 2) + '\n');
console.log(lines.slice(0, 8).join('\n'));
