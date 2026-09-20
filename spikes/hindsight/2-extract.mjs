// Spike B — what is the right ingestion unit? (docs/MEMORY.md §6.1)
//
// Three granularities over ONE corpus, scored against ground truth written
// before any of them ran:
//
//   per-message   one retain per message                 45 calls
//   window-20     fixed 20-message windows                3 calls
//   episode       cut where the room went quiet           4 calls
//
// THE PREDICTION, recorded so it can be wrong: per-message keeps the
// self-contained facts and loses the cross-turn ones, because a fact that lives
// between two turns is in neither of them. Window and episode land close, with
// episode ahead wherever an exchange crosses a window boundary.
//
// Through REAL RETAIN rather than dry-run extract: it is the code path we will
// ship, and it lets the same question be asked of each bank afterwards, which
// is closer to what we actually care about than a fact count.
import { client, bankId, save, check, observe, report } from './lib.mjs';
import { MESSAGES, GROUND_TRUTH, found, line } from './corpus.mjs';

const QUIET_MINUTES = 10;
const WINDOW = 20;
const CONTEXT = 'A conversation in the #db-cutover room. The speakers are people working in ' +
                'this room. None of them is the owner of this memory bank.';
const MISSION = [
  'Extract: decisions and who made them; who owns what work; blockers and their causes;',
  'root causes and fixes; commitments with dates; references to systems, tickets and documents.',
  'Do not extract: greetings, thanks, reactions, scheduling chatter, opinions stated in passing,',
  'or anything obvious from the room name.',
  'If nothing here is worth remembering, extract nothing.',
].join(' ');

// ─── Cutting the corpus three ways ──────────────────────────────────────────

/** The episode rule from §6.1, run as the algorithm rather than hardcoded. */
function episodes(messages, quietMinutes) {
  const cut = [[]];
  for (const [index, message] of messages.entries()) {
    const previous = messages[index - 1];
    const gapMinutes = previous ? (Date.parse(message.t) - Date.parse(previous.t)) / 60_000 : 0;
    if (previous && gapMinutes > quietMinutes) cut.push([]);
    cut.at(-1).push(message);
  }
  return cut;
}

function windows(messages, size) {
  const cut = [];
  for (let index = 0; index < messages.length; index += size) cut.push(messages.slice(index, index + size));
  return cut;
}

const GRANULARITIES = [
  { name: 'per-message', groups: MESSAGES.map((message) => [message]) },
  { name: 'window-20', groups: windows(MESSAGES, WINDOW) },
  { name: 'episode', groups: episodes(MESSAGES, QUIET_MINUTES) },
];

for (const granularity of GRANULARITIES) {
  observe(`${granularity.name} groups`, granularity.groups.map((group) => group.length));
}

// ─── Run each one into its own bank ─────────────────────────────────────────

const outcomes = [];

for (const granularity of GRANULARITIES) {
  const bank = bankId(granularity.name);
  console.log(`\n${granularity.name} → ${bank}`);
  await client.createBank(bank);
  await client.updateBankConfig(bank, {
    retainExtractionMode: 'custom',
    retainCustomInstructions: MISSION,
    enableObservations: false,        // production setting (§6.4)
  });

  let charsSent = 0;
  const started = Date.now();
  for (const [index, group] of granularity.groups.entries()) {
    const content = group.map(line).join('\n');
    charsSent += content.length + CONTEXT.length;
    await client.retain(bank, content, {
      context: CONTEXT,
      documentId: `g-${index}`,
      timestamp: group[0].t,
      tags: ['space:spc_test'],
      async: false,
    });
    if ((index + 1) % 10 === 0) console.log(`  …${index + 1}/${granularity.groups.length}`);
  }
  const retainSeconds = Math.round((Date.now() - started) / 1000);

  // Extraction is bounded by async:false; let anything trailing settle.
  await new Promise((resolve) => setTimeout(resolve, 15_000));
  const facts = (await client.listMemories(bank, { limit: 500 }))?.items ?? [];

  const hits = GROUND_TRUTH.filter((item) => found(item, facts));
  const missed = GROUND_TRUTH.filter((item) => !found(item, facts));
  const outcome = {
    name: granularity.name,
    bank,
    calls: granularity.groups.length,
    retainSeconds,
    tokensApprox: Math.round(charsSent / 4),
    costApproxUsd: +((charsSent / 4) * (10 / 1_000_000)).toFixed(4),
    factsExtracted: facts.length,
    groundTruthFound: hits.length,
    crossTurnFound: hits.filter((item) => item.crossTurn).length,
    selfContainedFound: hits.filter((item) => !item.crossTurn).length,
    missed: missed.map((item) => item.id),
  };
  outcomes.push(outcome);
  save(`extract-${granularity.name}`, { outcome, facts: facts.map((fact) => fact.text) });
  console.log(`  ${outcome.factsExtracted} facts · ground truth ${outcome.groundTruthFound}/14 ` +
              `(cross-turn ${outcome.crossTurnFound}/7, self-contained ${outcome.selfContainedFound}/7) ` +
              `· ~${outcome.tokensApprox} tok · ~$${outcome.costApproxUsd} · ${retainSeconds}s`);
}

save('extract-comparison', outcomes);

// ─── What it means ──────────────────────────────────────────────────────────

console.log('\nComparison');
console.table(outcomes.map(({ name, calls, factsExtracted, groundTruthFound, crossTurnFound,
                              selfContainedFound, tokensApprox, costApproxUsd, retainSeconds }) =>
  ({ name, calls, facts: factsExtracted, truth: `${groundTruthFound}/14`,
     crossTurn: `${crossTurnFound}/7`, selfContained: `${selfContainedFound}/7`,
     tokens: tokensApprox, usd: costApproxUsd, seconds: retainSeconds })));

const byName = Object.fromEntries(outcomes.map((outcome) => [outcome.name, outcome]));

check('per-message loses cross-turn facts that a larger unit keeps',
      byName['per-message'].crossTurnFound <
      Math.max(byName['window-20'].crossTurnFound, byName['episode'].crossTurnFound),
      `per-message ${byName['per-message'].crossTurnFound}/7 vs window ` +
      `${byName['window-20'].crossTurnFound}/7, episode ${byName['episode'].crossTurnFound}/7 — ` +
      'if per-message matches them, §6.1 is wrong and the simplest unit wins');

check('per-message is not cheaper',
      byName['per-message'].tokensApprox >= byName['episode'].tokensApprox,
      'the per-call context repeats, so it should cost more for less');

observe('episode vs window on cross-turn facts',
        `${byName['episode'].crossTurnFound}/7 vs ${byName['window-20'].crossTurnFound}/7`);
observe('facts missed by the episode run', byName['episode'].missed);
observe('facts missed by the per-message run', byName['per-message'].missed);
observe('banks left in place', outcomes.map((outcome) => outcome.bank));

report('2-extract');
