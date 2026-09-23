// Judges round 5c (results/flow-v5c.json), or the round named as an argument,
// against the expectations recorded with it, and writes
// results/flow-audit-<round>.md and .json.
//
//   cd spikes/ambient && pnpm flow:audit        # rounds 5, 5b and 5c
//   node flow-audit.ts 5b
//
// A run is RIGHT when agents did exactly what `expect` says — every expected
// act happened, from the right agent, about the right messages, and nothing
// else was posted or run — on time where `within` says, and within `maxPosts`.
// Wrong runs are told apart, because they are not equally bad:
//
//   spoke     an answer or offer nobody should have had — the costly failure
//   missed    an expected answer, offer or run that did not happen
//   late      right, but after `within`
//   too many  more posts than `maxPosts`
import { readFileSync, writeFileSync } from 'node:fs';

type Json = any;
const ROUND = process.argv[2] ?? '5d';
const round = JSON.parse(readFileSync(new URL(`./results/flow-v${ROUND}.json`, import.meta.url), 'utf8'));

interface Verdict { ok: boolean; failures: string[]; notes: string[] }

function judge(s: Json): Verdict {
  if (s.crashed) return { ok: false, failures: [`crashed: ${s.crashed}`], notes: [] };
  const failures: string[] = [];
  const notes: string[] = [];
  const produced: Json[] = s.acts;
  const used = new Set<number>();
  const posts = produced.filter(a => a.act !== 'run');
  const timeOf = (live: number) => s.events.find((e: Json) => e.live === live)?.t ?? 0;

  if (s.expect !== null) {
    for (const want of s.expect) {
      const index = produced.findIndex((got, i) => !used.has(i) && got.act === want.act
        && (want.agent === 'any' || got.agent === want.agent)
        && (want.anyOf ? want.to.some((n: number) => got.to.includes(n)) : want.to.every((n: number) => got.to.includes(n))));
      if (index < 0) { failures.push(`missed: ${want.act} by @${want.agent} to #${want.to.join(',')}`); continue; }
      used.add(index);
      const got = produced[index];
      if (s.within !== null && got.act !== 'run' && got.at - timeOf(want.to[0]) > s.within) {
        failures.push(`late: ${got.act} at ${got.at}s, ${Math.round(got.at - timeOf(want.to[0]))}s after #${want.to[0]} (within ${s.within}s)`);
      }
    }
    produced.forEach((got, i) => {
      if (!used.has(i)) failures.push(`${got.act === 'run' ? 'extra run' : 'spoke'}: ${got.act} by @${got.agent} to #${got.to.join(',')}`);
    });
  } else notes.push('any outcome is acceptable — read by hand');
  if (s.maxPosts !== null && posts.length > s.maxPosts) failures.push(`too many: ${posts.length} posts, at most ${s.maxPosts}`);
  return { ok: failures.length === 0, failures, notes };
}

/** Why the flow did what it did, one line per look. */
function trail(s: Json): string[] {
  const r = (n: number | undefined) => (typeof n === 'number' ? n.toFixed(2) : '–');
  return (s.looks ?? []).map((l: Json) => {
    const at = `${Math.round(l.at)}s`;
    if (l.kind === 'mention' || l.kind === 'name') return `${at} ${l.kind} → run @${l.agent}`;
    if (l.kind === 'follow_up') {
      const a = l.answers ?? {};
      const draft = l.draft ? ` · draft ${l.draft.outcome}${l.draft.because ? ` (${l.draft.because})` : ''}` : '';
      return `${at} follow-up to @${l.agent}: to agent ${r(a.to_agent?.noul)}, to someone else ${r(a.to_someone_else?.noul)} → ${l.outcome}${l.because ? ` (${l.because})` : ''}${draft}`;
    }
    const parts = [`${at} turn [${l.turn.map((k: string) => k.split('_').pop()).join(',')}]`];
    if (l.step1) {
      const scores = Object.entries(l.step1.scores).map(([k, v]: [string, Json]) =>
        `#${k.split('_').pop()} need ${r(v.need)} ans ${r(v.answered)} person ${r(v.toPerson)} wants ${r(v.wants)} human ${r(v.person)} sens ${r(v.sensitive)}`);
      parts.push(`step 1 ${l.step1.because}: ${scores.join('; ')}`);
    }
    if (l.step2) parts.push(`step 2 ${l.step2.choice} (${l.step2.fits.map((f: Json) => `${f.agent} ${r(f.fit)}`).join(', ')})`);
    if (l.draft) {
      const d = l.draft;
      const sc = d.scores ? Object.entries(d.scores).map(([k, v]: [string, Json]) => `${k} ${r(v.noul)}`).join(', ') : '';
      parts.push(`draft ${d.draft?.kind ?? d.outcome}${sc ? ` (${sc})` : ''}`);
    }
    parts.push(`→ ${l.outcome}${l.because ? ` (${l.because})` : ''}`);
    return parts.join(' · ');
  });
}

const byId = new Map<string, Json[]>();
for (const s of round.scenarios) byId.set(s.id, [...(byId.get(s.id) ?? []), s]);

const rows = [...byId.entries()].map(([id, runs]) => {
  const verdicts = runs.map(judge);
  const first = runs.find((s: Json) => !s.crashed) ?? runs[0];
  return {
    id, group: first.group, title: first.title, why: first.why, expect: first.expect,
    quiet: Array.isArray(first.expect) && first.expect.length === 0,
    runs: runs.length, right: verdicts.filter(v => v.ok).length,
    spoke: verdicts.filter(v => v.failures.some(f => f.startsWith('spoke') || f.startsWith('too many'))).length,
    failures: [...new Set(verdicts.flatMap(v => v.failures))],
    notes: [...new Set(verdicts.flatMap(v => v.notes))],
    samples: runs.map((s: Json, i: number) => ({ rep: s.rep, ok: verdicts[i]!.ok, acts: s.acts ?? [], trail: s.crashed ? [] : trail(s) })),
  };
});

const groups = [...new Set(rows.map(r => r.group))];
const total = rows.reduce((n, r) => n + r.runs, 0);
const right = rows.reduce((n, r) => n + r.right, 0);
const quietRows = rows.filter(r => r.quiet);
const spokeOutOfTurn = rows.reduce((n, r) => n + r.spoke, 0);

const lines: string[] = [];
lines.push(`# Round ${ROUND} — the settled decision flow`, '');
lines.push(`Ran ${round.ranAt}, ${round.reps} run(s) of ${rows.length} scenarios, ${round.model}. Wall time ${round.wallSec}s.`, '');
lines.push(`**${right} of ${total} runs right.** Scenarios right every run: ${rows.filter(r => r.right === r.runs).length} of ${rows.length}.`);
lines.push(`Spoke when it should not have (an extra answer or offer, or too many): **${spokeOutOfTurn}** run(s).`);
lines.push(`Should-stay-quiet scenarios: ${quietRows.length}, quiet in ${quietRows.reduce((n, r) => n + r.right, 0)} of ${quietRows.reduce((n, r) => n + r.runs, 0)} runs.`, '');
lines.push('| Group | Scenarios | Runs right |', '|---|---|---|');
for (const g of groups) {
  const gr = rows.filter(r => r.group === g);
  lines.push(`| ${g} | ${gr.length} | ${gr.reduce((n, r) => n + r.right, 0)} / ${gr.reduce((n, r) => n + r.runs, 0)} |`);
}
lines.push('', '## Every scenario', '');
for (const g of groups) {
  lines.push(`### ${g}`, '');
  for (const r of rows.filter(row => row.group === g)) {
    const mark = r.right === r.runs ? '✅' : r.spoke > 0 ? '🔴' : '🟠';
    const want = r.expect === null ? 'any' : r.expect.length === 0 ? 'quiet'
      : r.expect.map((a: Json) => `${a.act} @${a.agent} #${a.to.join(',')}`).join(' + ');
    lines.push(`**${mark} ${r.id} — ${r.title}** · ${r.right}/${r.runs} · expected: ${want}`, '');
    lines.push(`> ${r.why}`, '');
    for (const f of r.failures) lines.push(`- ${f}`);
    for (const n of r.notes) lines.push(`- ${n}`);
    const shown = r.samples.find(x => !x.ok) ?? r.samples[0];
    if (shown) {
      lines.push('', '```', ...shown.trail, '```');
      for (const a of shown.acts.filter((x: Json) => x.text)) lines.push(`> **@${a.agent} ${a.act}** at ${a.at}s: ${String(a.text).replace(/\n+/g, ' ')}`);
    }
    lines.push('');
  }
}
writeFileSync(new URL(`./results/flow-audit-${ROUND}.md`, import.meta.url), lines.join('\n') + '\n');
writeFileSync(new URL(`./results/flow-audit-${ROUND}.json`, import.meta.url), JSON.stringify({
  ranAt: round.ranAt, reps: round.reps, total, right, spokeOutOfTurn, rows,
}, null, 2) + '\n');

process.stdout.write(`${right}/${total} runs right; spoke out of turn in ${spokeOutOfTurn}\n`);
for (const r of rows.filter(row => row.right < row.runs)) {
  process.stdout.write(`  ${r.id} ${r.right}/${r.runs} ${r.title}: ${r.failures.join('; ')}\n`);
}
