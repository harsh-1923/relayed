// Replays every scenario on a simulated clock and records what each design
// would have done, and what the agent would actually have said.
//
//   cd spikes/ambient && npm run spike
//
// SIMULATED TIME, REAL EVERYTHING ELSE. The loop's rules — the 90-second lull a
// new message restarts, follow-ups checked straight away, the window starting
// after the last agent message, a mention being the mention path — run on a
// clock the spike advances itself, so a reply at t = 40 lands inside the lull
// as it would in a room, without waiting 90 seconds for it. Every Jev call is
// real, every draft is a real run on the agent runtime, and the time each
// takes is added to the clock, so a message that arrives while the agent is
// drafting is seen by gate 2 exactly when it would be.
//
// Needs TYPESAFE_API_KEY, AGENT_RUNTIME_URL, AGENT_S2S_KEY and the rest of the
// server's .env. Never prints a key. Writes results/run.json.
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { env } from '../../apps/server/src/env.ts';
import { pool } from '../../apps/server/src/db/client.ts';
import { jevClient, JevError, type Question } from '../../apps/server/src/agents/ambient/jev.ts';
import {
  THRESHOLDS, candidate, decideFollowUp, decideGate1, decideGate2, followUp, gate1, gate2, plainText,
  type Candidate, type Line,
} from './window-design.ts';
import { cleanDraft, draftRequest, runtimeDraft } from '../../apps/server/src/agents/ambient/loop.ts';
import { AGENTS, SCENARIOS, type Scenario } from './scenarios.ts';
import { D2, ROUND, decide2, decideGate2Split, gate2Split, pick, step1, step2 } from './designs.ts';
import * as app from '../../apps/server/src/agents/ambient/gates.ts';

/** Round 4 runs the app's gates as shipped, in place of this spike's copies. */
const APP = ROUND === 4;
/** Runs of every scenario. Drafts differ run to run; one draft per scenario hid that. */
const REPS = Math.max(1, Number(process.env['REPS'] ?? 1));

const LULL = 90;
const FOLLOW_UP_REACH = 3;
const FOLLOW_UP_SEC = 300;
const RECENT_SEC = 1_800;
const WINDOW = 20;
const EARLIER = 3;
const DONE_HERE = 5;
const CONCURRENCY = 2;

if (!env.typesafeApiKey) throw new Error('TYPESAFE_API_KEY is not set');
const jev = jevClient({ apiKey: env.typesafeApiKey, baseUrl: env.typesafeBaseUrl });
const BASE = Date.now();

const PEOPLE: Record<string, { id: string; name: string; handle: string }> = {
  Harsh: { id: 'act_harsh', name: 'Harsh Sharma', handle: 'harsh' },
  Alice: { id: 'act_alice', name: 'Alice Chen', handle: 'alice' },
  Bob: { id: 'act_bob', name: 'Bob Iyer', handle: 'bob' },
  Carol: { id: 'act_carol', name: 'Carol Diaz', handle: 'carol' },
  triage: { id: 'act_triage', name: 'Triage', handle: 'triage' },
  scribe: { id: 'act_scribe', name: 'Scribe', handle: 'scribe' },
};

interface Msg { key: string; t: number; from: string; text: string; agent: boolean; live: number | null; posted: boolean }

const isAgent = (from: string) => from === 'triage' || from === 'scribe';
const mentionsAgent = (text: string) => /\]\(actor:(triage|scribe)\)/.test(text);
const asLine = (m: Msg): Line => ({ from: PEOPLE[m.from]!.name, at: new Date(BASE + m.t * 1000).toISOString(), text: plainText(m.text) });
const asSaid = (m: Msg, ord: number) => ({
  id: m.key, ord, parentId: null, authorId: PEOPLE[m.from]!.id, authorType: m.agent ? 'agent' : 'human',
  name: PEOPLE[m.from]!.name, handle: PEOPLE[m.from]!.handle, body: m.text, createdAt: new Date(BASE + m.t * 1000),
});

async function timed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await work();
  return { value, ms: Math.round(performance.now() - start) };
}

/**
 * Answers as the spike reads them: by id, any shape. The app's own types are
 * enforced where the app uses them; here the same answers feed three designs.
 */
type Answered = Record<string, any>;

async function ask<Q extends Record<string, Question>>(state: unknown, questions: Q) {
  try {
    const { value, ms } = await timed(() => jev.ask(state, questions));
    return { ok: true as const, answers: value.answers as Answered, ms, stateChars: JSON.stringify(state).length + JSON.stringify(questions).length };
  } catch (error) {
    return { ok: false as const, reason: error instanceof JevError ? error.reason : 'network', ms: 0, stateChars: 0 };
  }
}

async function simulate(scenario: Scenario) {
  let live = 0;
  const timeline: Msg[] = scenario.events.map((e, i) => ({
    key: `msg_${scenario.id}_${i}`, t: e.t, from: e.from, text: e.text, agent: isAgent(e.from), live: e.t >= 0 ? live++ : null, posted: false,
  }));
  const scripted = [...timeline];
  const looks: unknown[] = [];
  let watermark = -Infinity;          // the ambient watermark, as a time
  const upTo = (t: number) => timeline.filter(m => m.t <= t).sort((a, b) => a.t - b.t);
  const before = (t: number) => timeline.filter(m => m.t < t).sort((a, b) => a.t - b.t);
  const candidatesAt = (t: number): Candidate[] => scenario.room.agents.map(key => candidate({
    handle: key, name: AGENTS[key].name, instructions: AGENTS[key].instructions, description: AGENTS[key].description,
    recent: before(t).filter(m => m.from === key).slice(-DONE_HERE).map(m => m.text),
  }));
  const place = { space_id: `spc_${scenario.id}`, space_kind: scenario.room.kind, space_name: scenario.room.name,
    chat_kind: scenario.room.kind === 'room' ? 'default' : 'sole', chat_name: null, space_visibility: 'public' as const };

  /** Draft as `agent` for `question` at virtual time `at`, then gate 2. Returns what happened and the new clock. */
  async function draftAndCheck(agentKey: 'triage' | 'scribe', question: Msg, at: number, forDesign: string) {
    const conversation = before(question.t).slice(-WINDOW).map((m, i) => asSaid(m, i + 1));
    const request = draftRequest({
      agent: { instructions: AGENTS[agentKey].instructions, model: null }, place, summary: scenario.room.summary,
      conversation: conversation as never, question: asSaid(question, conversation.length + 1) as never, facts: [],
    });
    const drafted = await timed(() => runtimeDraft(request));
    let clock = at + drafted.ms / 1000;
    if (!drafted.value.ok) return { forDesign, agent: agentKey, question: question.key, outcome: 'failed', draftMs: drafted.ms, clock };
    const text = cleanDraft(drafted.value.text);
    if (text === null) return { forDesign, agent: agentKey, question: question.key, outcome: 'declined', raw: drafted.value.text, draftMs: drafted.ms, clock };
    const since = timeline.filter(m => m.t > question.t && m.t <= clock).sort((a, b) => a.t - b.t);
    if (D2.gate2 === 'split') {
      // The draft on its own, and "answered meanwhile" apart — in parallel, so no slower.
      const split = APP
        ? { draft: app.draftCheck(asLine(question), plainText(text)), handled: app.answeredMeanwhile(asLine(question), since.map(asLine)) }
        : gate2Split(asLine(question), since.map(asLine), plainText(text));
      const [onDraft, onSince] = await Promise.all([
        ask(split.draft.state, split.draft.questions),
        since.length > 0 ? ask(split.handled.state, split.handled.questions) : Promise.resolve(null),
      ]);
      clock += Math.max(onDraft.ms, onSince?.ms ?? 0) / 1000;
      if (!onDraft.ok || (onSince && !onSince.ok)) return { forDesign, agent: agentKey, question: question.key, outcome: 'gate_error', text, draftMs: drafted.ms, clock };
      const verdict = APP
        ? app.decideDraft(onDraft.answers, onSince?.ok ? onSince.answers : null)
        : decideGate2Split(onDraft.answers, onSince?.ok ? onSince.answers : null);
      return {
        forDesign, agent: agentKey, question: question.key, text, draftMs: drafted.ms, gate2Ms: Math.max(onDraft.ms, onSince?.ms ?? 0), clock,
        gate2: { ...onDraft.answers, ...(onSince?.ok ? onSince.answers : {}) }, seenDuringDraft: since.map(m => m.key),
        outcome: verdict.post ? 'posted' : 'suppressed', because: verdict.post ? null : verdict.because,
      };
    }
    const second = gate2({ question: asLine(question), since: since.map(asLine), draft: plainText(text) });
    const asked = await ask(second.state, second.questions);
    clock += asked.ms / 1000;
    if (!asked.ok) return { forDesign, agent: agentKey, question: question.key, outcome: 'gate_error', text, draftMs: drafted.ms, clock };
    const verdict = decideGate2(asked.answers);
    return {
      forDesign, agent: agentKey, question: question.key, text, draftMs: drafted.ms, gate2Ms: asked.ms, clock,
      gate2: asked.answers, seenDuringDraft: since.map(m => m.key),
      outcome: verdict.post ? 'posted' : 'suppressed', because: verdict.post ? null : verdict.because,
    };
  }

  function post(agentKey: string, at: number, text: string) {
    timeline.push({ key: `msg_${scenario.id}_posted_${timeline.length}`, t: at, from: agentKey, text, agent: true, live: null, posted: true });
  }

  for (let n = 0; n < scripted.length; n++) {
    const message = scripted[n]!;
    const next = scripted[n + 1];
    if (message.agent) continue;

    // ── A mention is the mention path: a run answers it, and ambient stands aside. ──
    if (mentionsAgent(message.text)) {
      looks.push({ kind: 'mention', at: message.t, message: message.key });
      watermark = message.t;
      continue;
    }

    // ── Follow-up: an agent spoke in the few messages before this one, recently. ──
    const prior = before(message.t).slice(-FOLLOW_UP_REACH);
    const spoke = [...prior].reverse().find(m => m.agent && m.t > message.t - FOLLOW_UP_SEC);
    if (spoke) {
      const between = timeline.filter(m => m.t > spoke.t && m.t < message.t);
      const check = followUp({ agentMessage: asLine(spoke), between: between.map(asLine), latest: asLine(message) });
      const asked = await ask(check.state, check.questions);
      const look: Record<string, unknown> = { kind: 'follow_up', at: message.t, message: message.key, agent: spoke.from, jevMs: asked.ms };
      if (asked.ok) {
        look['answers'] = asked.answers;
        // Round 2 moves only the "to someone else" bar; `decideFollowUp` is the built rule.
        look['forAgent'] = APP ? app.decideFollowUp(asked.answers) : ROUND === 1 ? decideFollowUp(asked.answers)
          : asked.answers['to_agent'].noul > 0.8 && asked.answers['to_someone_else'].noul < D2.toSomeoneElse;
        if (look['forAgent']) {
          const drafted = await draftAndCheck(spoke.from as 'triage' | 'scribe', message, message.t + asked.ms / 1000, 'follow_up');
          look['draft'] = drafted;
          if (drafted.outcome === 'posted') post(spoke.from, drafted.clock, (drafted as { text: string }).text);
        }
      } else look['error'] = asked.reason;
      looks.push(look);
      if (look['forAgent']) watermark = message.t;
    }

    // ── Ambient: does the chat go quiet on this person's message? ──
    const fireAt = message.t + LULL;
    if (next && next.t <= fireAt) continue;                       // someone spoke inside the lull
    const newest = upTo(fireAt).at(-1)!;
    if (newest.agent) continue;                                   // an agent spoke last
    const lastAgent = upTo(fireAt).filter(m => m.agent).at(-1)?.t ?? -Infinity;
    const after = Math.max(watermark, lastAgent, fireAt - RECENT_SEC);
    const window = upTo(fireAt).filter(m => m.t > after).slice(-WINDOW);
    if (!window.some(m => !m.agent)) continue;
    if (window.some(m => mentionsAgent(m.text))) continue;
    watermark = newest.t;
    const earlier = upTo(fireAt).filter(m => m.t <= after).slice(-EARLIER);
    const candidates = candidatesAt(fireAt);
    const look: Record<string, unknown> = { kind: 'ambient', at: fireAt, window: window.map(m => m.key) };

    // CURRENT: the window at once.
    const input1 = { room: scenario.room.name, roomSummary: scenario.room.summary, earlier: earlier.map(asLine),
                     recent: window.map(asLine), candidates };
    const g1 = gate1(input1);
    const asked1 = await ask(g1.state, g1.questions);
    const current: Record<string, unknown> = { jevMs: asked1.ms, chars: asked1.stateChars };
    if (asked1.ok) {
      const decision = decideGate1(asked1.answers, input1, () => THRESHOLDS.fits);
      Object.assign(current, { answers: asked1.answers, decision: decision.speak
        ? { speak: true, agent: scenario.room.agents[decision.candidateIndex], question: window[decision.needIndex]!.key }
        : decision });
    } else current['error'] = asked1.reason;
    look['current'] = current;

    // PER-MESSAGE: each person's message on its own, then which agent.
    const judged = window.map((m, i) => ({ m, i })).filter(({ m }) => !m.agent).slice(-D2.perMessage).map(({ i }) => i);
    const s1 = APP ? app.messageCheck(window.map(asLine), judged) : step1(window.map(asLine), judged);
    const asked2a = await ask(s1.state, s1.questions);
    const proposed: Record<string, unknown> = { jevMs: asked2a.ms, chars: asked2a.stateChars };
    if (asked2a.ok) {
      // Round 4 ran the app's `pickQuestion` — the newest open question. The app
      // has since moved to turns (`judgeTurn`, rounds 5–5c), so this reads the
      // same thing from it: round 4 is no longer an exact rerun of that code.
      const pickNewest = (answers: Answered) => {
        const turn = app.judgeTurn(answers, judged);
        return { index: turn.open.at(-1) ?? null, because: turn.because };
      };
      const picked = APP
        ? { ...pickNewest(asked2a.answers), scores: Object.fromEntries(judged.map(i => [i, {
            need: asked2a.answers[`need_${i}`].noul, answered: asked2a.answers[`answered_${i}`].noul,
            toPerson: asked2a.answers[`to_person_${i}`].noul, wants: asked2a.answers[`wants_${i}`].noul }])) }
        : pick(asked2a.answers, judged);
      proposed['step1'] = picked;
      if (picked.index !== null) {
        const question = window[picked.index]!;
        const s2 = (APP ? app.agentCheck : step2)({
          room: scenario.room.name, roomSummary: scenario.room.summary,
          earlier: before(question.t).slice(-EARLIER).map(asLine), question: asLine(question),
          after: window.filter(m => m.t > question.t).map(asLine), candidates,
        });
        const asked2b = await ask(s2.state, s2.questions);
        proposed['jevMs2'] = asked2b.ms;
        proposed['chars2'] = asked2b.stateChars;
        if (asked2b.ok) {
          const d = APP
            ? (({ speak, fit, ...rest }) => ({ speak, fit, confidence: asked2b.answers['best_agent'].confidence, ...rest }))(
                app.decideAgent(asked2b.answers, candidates)) as ReturnType<typeof decide2>
            : decide2(asked2b.answers, candidates);
          proposed['step2'] = { answers: asked2b.answers, ...d };
          proposed['decision'] = d.speak
            ? { speak: true, agent: scenario.room.agents[d.candidateIndex], question: question.key }
            : { speak: false, because: d.because };
        } else proposed['error'] = asked2b.reason;
      } else proposed['decision'] = { speak: false, because: picked.because };
    } else proposed['error'] = asked2a.reason;
    look['proposed'] = proposed;

    // Draft for what the per-message design chose — that branch is the one the
    // simulated room follows. And for what the current design chose, when it
    // differs, so its would-be answer can be read too; that one is never posted.
    const clockStart = fireAt + ((asked1.ms + asked2a.ms + ((proposed['jevMs2'] as number) ?? 0)) / 1000);
    const d2 = proposed['decision'] as { speak: boolean; agent?: 'triage' | 'scribe'; question?: string } | undefined;
    const d1 = current['decision'] as { speak: boolean; agent?: 'triage' | 'scribe'; question?: string } | undefined;
    if (d2?.speak) {
      const drafted = await draftAndCheck(d2.agent!, timeline.find(m => m.key === d2.question)!, clockStart, 'per-message');
      look['draft'] = drafted;
      if (drafted.outcome === 'posted') post(d2.agent!, drafted.clock, (drafted as { text: string }).text);
    }
    if (d1?.speak && !(d2?.speak && d2.agent === d1.agent && d2.question === d1.question)) {
      look['currentDraft'] = await draftAndCheck(d1.agent!, timeline.find(m => m.key === d1.question)!, clockStart, 'current');
    }
    looks.push(look);
  }

  return {
    id: scenario.id, category: scenario.category, title: scenario.title, room: scenario.room.name, agents: scenario.room.agents,
    expected: scenario.expected,
    events: timeline.sort((a, b) => a.t - b.t).map(m => ({ key: m.key, t: Math.round(m.t * 10) / 10, from: m.from, text: m.text, live: m.live, posted: m.posted })),
    looks,
  };
}

async function main() {
  const only = process.argv.slice(2);
  const queue = Array.from({ length: REPS }, (_r, rep) => SCENARIOS.filter(s => only.length === 0 || only.includes(s.id))
    .map(s => ({ ...s, rep }))).flat();
  const results: unknown[] = new Array(queue.length);
  const started = performance.now();
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < queue.length) {
      const index = next++;
      const scenario = queue[index]!;
      const t0 = performance.now();
      results[index] = { ...(await simulate(scenario)), rep: scenario.rep };
      process.stdout.write(`${scenario.id}${REPS > 1 ? ` #${scenario.rep + 1}` : ''} ${scenario.title} — ${Math.round((performance.now() - t0) / 1000)}s\n`);
    }
  }));
  const out = { round: ROUND, reps: REPS, ranAt: new Date(BASE).toISOString(), model: 'jev-1.13.0', lullSec: LULL, thresholds: { current: THRESHOLDS, perMessage: D2 },
    wallSec: Math.round((performance.now() - started) / 1000), scenarios: results };
  writeFileSync(new URL(`./results/run-v${ROUND}${only.length ? '-partial' : ''}.json`, import.meta.url), JSON.stringify(out, null, 2) + '\n');
  process.stdout.write(`done in ${out.wallSec}s\n`);
  await pool.end();
}

await main();
