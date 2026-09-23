// Round 5: the settled decision flow (flow-scenarios.ts) on every scenario,
// on a simulated clock, with real Jev calls and real drafts on the agent
// runtime — as run.ts does for rounds 1–4.
//
//   cd spikes/ambient && pnpm flow            # every scenario, three times
//   node --env-file=../../.env flow-run.ts T02 F04    # just these, once
//
// THE CLOCK. Person messages arrive at their scripted times. A turn is due 90 s
// after its author's last message in it; a follow-up is looked at as it
// arrives. One look at a time per chat, and none while a mention run is in
// flight — so a look starts at the latest of when it is due, when the last one
// finished, and when the run ends. Every Jev call and draft takes its real
// time on the clock, so what is said while an agent drafts is seen when it
// would be. A mention run is not executed: its act is recorded, and its reply
// is whatever the scenario scripts.
//
// Writes results/flow-v5b.json (flow-v5.json with FLOW_ROUND=5). Needs the server's .env. Never prints a key.
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { env } from '../../apps/server/src/env.ts';
import { pool } from '../../apps/server/src/db/client.ts';
import { jevClient, JevError, type Question } from '../../apps/server/src/agents/ambient/jev.ts';
import * as app from '../../apps/server/src/agents/ambient/gates.ts';
import { AMBIENT_RULES, draftRequest, runtimeDraft } from '../../apps/server/src/agents/ambient/loop.ts';
import { FLOW_AGENTS, FLOW_SCENARIOS, TOOLKITS, type AgentKey, type FlowScenario } from './flow-scenarios.ts';
import {
  FLOW, ROUND, since, addressedAgent, agentCheckFlow, decideAgentFlow, decideOffer, flowRules, offerCheck, offerText, openTurn, readDraft, turnCheck,
} from './flow.ts';

const REPS = Math.max(1, Number(process.env['REPS'] ?? 1));
const CONCURRENCY = 3;
const WINDOW = 20;
const EARLIER = 3;
const DONE_HERE = 5;
/** A mention run with no scripted reply is taken to finish this long after it starts. */
const RUN_SEC = 30;

if (!env.typesafeApiKey) throw new Error('TYPESAFE_API_KEY is not set');
const jev = jevClient({ apiKey: env.typesafeApiKey, baseUrl: env.typesafeBaseUrl });
const BASE = Date.now();
const RULES = flowRules(TOOLKITS);

const PEOPLE: Record<string, { id: string; name: string; handle: string }> = {
  Harsh: { id: 'act_harsh', name: 'Harsh Sharma', handle: 'harsh' },
  Alice: { id: 'act_alice', name: 'Alice Chen', handle: 'alice' },
  Bob: { id: 'act_bob', name: 'Bob Iyer', handle: 'bob' },
  Carol: { id: 'act_carol', name: 'Carol Diaz', handle: 'carol' },
  Dana: { id: 'act_dana', name: 'Dana Okafor', handle: 'dana' },
  triage: { id: 'act_triage', name: 'Triage', handle: 'triage' },
  scribe: { id: 'act_scribe', name: 'Scribe', handle: 'scribe' },
  pixel: { id: 'act_pixel', name: 'Pixel', handle: 'pixel' },
};
const AGENT_KEYS = Object.keys(FLOW_AGENTS) as AgentKey[];
const isAgent = (from: string): from is AgentKey => (AGENT_KEYS as string[]).includes(from);

interface Msg {
  key: string; t: number; from: string; text: string; agent: boolean; live: number | null; posted: boolean;
  /** An agent message answering this person's mention: a follow-up from them continues the run. */
  mentionBy?: string;
  /** Unprompted follow-up answers since the ambient answer this one continues (round 5). */
  chain?: number;
  /** The first agent message of the exchange this one continues (round 5b). */
  root?: string;
}
interface Turn { person: string; msgs: Msg[]; start: number; last: number; closed: boolean }
interface Act { act: 'answer' | 'offer' | 'run'; agent: AgentKey; to: number[]; at: number; via: string; text?: string }
/** What a draft and its check came to. `text` is what would be posted. */
interface Checked { outcome: string; clock: number; draftMs: number; text?: string; because?: string | null; [more: string]: unknown }

type Answered = Record<string, any>;

async function timed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await work();
  return { value, ms: Math.round(performance.now() - start) };
}

async function ask(state: unknown, questions: Record<string, Question>) {
  try {
    const { value, ms } = await timed(() => jev.ask(state, questions));
    return { ok: true as const, answers: value.answers as Answered, ms };
  } catch (error) {
    return { ok: false as const, reason: error instanceof JevError ? error.reason : 'network', ms: 0 };
  }
}

const mentionedAgent = (text: string): AgentKey | null =>
  (/\]\(actor:(triage|scribe|pixel)\)/.exec(text)?.[1] as AgentKey | undefined) ?? null;

async function simulate(scenario: FlowScenario) {
  let live = 0;
  const timeline: Msg[] = scenario.events.map((e, i) => ({
    key: `msg_${scenario.id}_${i}`, t: e.t, from: e.from, text: e.text, agent: isAgent(e.from),
    live: e.t >= 0 ? live++ : null, posted: false,
  }));
  const incoming = timeline.filter(m => m.t >= 0 && !m.agent).sort((a, b) => a.t - b.t);
  const acts: Act[] = [];
  const looks: Record<string, unknown>[] = [];
  const turns: Turn[] = [];
  const ambientPosts: number[] = [];
  /** Round 5b: follow-ups judged for the agent, per exchange — declined ones count too. */
  const followUps = new Map<string, number>();
  let busyUntil = -Infinity;
  let runUntil = -Infinity;

  const byTime = (a: Msg, b: Msg) => a.t - b.t;
  const visibleAt = (t: number) => timeline.filter(m => m.t <= t).sort(byTime);
  const before = (t: number) => timeline.filter(m => m.t < t).sort(byTime);
  const asLine = (m: Msg): app.Line => ({ from: PEOPLE[m.from]!.name, at: new Date(BASE + m.t * 1000).toISOString(), text: app.plainText(m.text) });
  const asSaid = (m: Msg, ord: number) => ({
    id: m.key, ord, parentId: null, authorId: PEOPLE[m.from]!.id, authorType: m.agent ? 'agent' : 'human',
    name: PEOPLE[m.from]!.name, handle: PEOPLE[m.from]!.handle, body: m.text, createdAt: new Date(BASE + m.t * 1000),
  });
  /** A turn read as one question: its author's lines, in order. */
  const turnLine = (msgs: Msg[]): app.Line => ({ ...asLine(msgs[0]!), text: msgs.map(m => app.plainText(m.text)).join('\n') });
  const candidatesAt = (t: number) => scenario.room.agents.map(key => app.candidate({
    handle: key, name: FLOW_AGENTS[key].name, instructions: FLOW_AGENTS[key].instructions, description: FLOW_AGENTS[key].description,
    recent: before(t).filter(m => m.from === key).slice(-DONE_HERE).map(m => m.text),
  }));
  const place = { space_id: `spc_${scenario.id}`, space_kind: scenario.room.kind, space_name: scenario.room.name,
    chat_kind: scenario.room.kind === 'room' ? 'default' : 'sole', chat_name: null, space_visibility: 'public' as const };
  const due = (turn: Turn) => Math.min(turn.last + FLOW.lullSec, turn.start + FLOW.turnMaxSec);
  const liveOf = (msgs: Msg[]) => msgs.map(m => m.live).filter((n): n is number => n !== null);

  function post(agent: AgentKey, at: number, text: string, extra: Partial<Msg> = {}): Msg {
    const message: Msg = { key: `msg_${scenario.id}_posted_${timeline.length}`, t: at, from: agent, text, agent: true, live: null, posted: true, ...extra };
    timeline.push(message);
    return message;
  }

  /** The draft for `msgs` by `agent`, from `at`, and the draft check. */
  async function draftAndCheck(agent: AgentKey, msgs: Msg[], at: number): Promise<Checked> {
    const first = msgs[0]!;
    const last = msgs.at(-1)!;
    const conversation = before(first.t).slice(-WINDOW).map((m, i) => asSaid(m, i + 1));
    const question = { ...asSaid(last, conversation.length + 1), body: msgs.map(m => m.text).join('\n'), createdAt: new Date(BASE + first.t * 1000) };
    // The release gate drafts with the app's own rules and toolkits; the rounds before it with theirs.
    const request = draftRequest({
      agent: { instructions: FLOW_AGENTS[agent].instructions, model: null }, place, summary: scenario.room.summary,
      conversation: conversation as never, question: question as never, facts: [], ...(since('gate') ? { toolkits: TOOLKITS } : {}),
    });
    if (!since('gate')) {
      if (!request.systemPrompt?.includes(AMBIENT_RULES)) throw new Error('the drafting rules moved; flow.ts cannot replace them');
      request.systemPrompt = request.systemPrompt.replace(AMBIENT_RULES, RULES);
    }
    const drafted = await timed(() => runtimeDraft(request));
    let clock = at + drafted.ms / 1000;
    if (!drafted.value.ok) return { outcome: 'failed', clock, draftMs: drafted.ms };
    const read = readDraft(drafted.value.text);
    if (read.kind === 'nothing') return { outcome: 'declined', raw: drafted.value.text.slice(0, 200), clock, draftMs: drafted.ms };
    const q = turnLine(msgs);
    const sinceThen = timeline.filter(m => m.t > last.t && m.t <= clock).sort(byTime);
    // The answer and the offer are checked on their own, and "answered meanwhile" beside them — in parallel.
    const answerPart = read.kind === 'answer' || read.kind === 'answer_offer' ? app.draftCheck(q, app.plainText(read.text)) : null;
    const offerPart = read.kind === 'offer' || read.kind === 'answer_offer' ? offerCheck(q, read.what, read.toolkit) : null;
    const meanwhile = sinceThen.length > 0 ? app.answeredMeanwhile(q, sinceThen.map(asLine)) : null;
    const [onAnswer, onOffer, onSince] = await Promise.all([
      answerPart ? ask(answerPart.state, answerPart.questions) : Promise.resolve(null),
      offerPart ? ask(offerPart.state, offerPart.questions) : Promise.resolve(null),
      meanwhile ? ask(meanwhile.state, meanwhile.questions) : Promise.resolve(null),
    ]);
    clock += Math.max(onAnswer?.ms ?? 0, onOffer?.ms ?? 0, onSince?.ms ?? 0) / 1000;
    const common = { draft: read, clock, draftMs: drafted.ms, seenDuringDraft: sinceThen.map(m => m.key) };
    if ((onAnswer && !onAnswer.ok) || (onOffer && !onOffer.ok) || (onSince && !onSince.ok)) return { ...common, outcome: 'gate_error' };
    const answered = (x: typeof onAnswer) => (x?.ok ? x.answers : null);
    const scores = { ...answered(onAnswer), ...(answered(onOffer) ? Object.fromEntries(Object.entries(answered(onOffer)!).map(([k, v]) => [`offer_${k}`, v])) : {}), ...answered(onSince) };
    const handled = onSince?.ok ? onSince.answers['handled'].noul >= FLOW.bars.answeredMeanwhile : false;
    const answerVerdict = onAnswer?.ok ? app.decideDraft(onAnswer.answers, onSince?.ok ? onSince.answers : null) : null;
    const offerBecause = onOffer?.ok && offerPart ? decideOffer(onOffer.answers, (read as { toolkit: string }).toolkit, TOOLKITS, handled) : null;
    const offerPasses = onOffer?.ok === true && offerBecause === null;
    const sentence = offerPasses ? offerText((read as { what: string }).what, (read as { toolkit: string }).toolkit) : null;
    if (answerVerdict?.post) {
      const text = (read as { text: string }).text;
      return { ...common, scores, outcome: 'answer', because: null, offered: offerPasses, text: sentence ? `${text}\n\n${sentence}` : text };
    }
    // The release gate: an offer alone only when the model wrote nothing but the offer.
    if (offerPasses && (read.kind === 'offer' || !since('gate'))) return { ...common, scores, outcome: 'offer', because: null, text: sentence! };
    return { ...common, scores, outcome: 'suppressed',
      because: [answerVerdict && !answerVerdict.post ? answerVerdict.because : null, offerBecause].filter(Boolean).join('+') || null };
  }

  /** A mention, a name used as an address, or a follow-up continuing one: a normal run. */
  function startRun(agent: AgentKey, message: Msg, at: number, via: string) {
    acts.push({ act: 'run', agent, to: liveOf([message]), at, via });
    const reply = timeline.find(m => m.from === agent && m.t > message.t && !m.posted);
    if (reply) reply.mentionBy = message.from;
    runUntil = Math.max(runUntil, reply ? reply.t : at + RUN_SEC);
  }

  async function arrive(message: Msg) {
    // ── Asked of an agent directly: a normal run, and nothing below. ──
    const mentioned = mentionedAgent(message.text);
    const named = mentioned ? null : addressedAgent(message.text, scenario.room.agents.map(key => ({ key, name: FLOW_AGENTS[key].name })));
    if (mentioned || named) {
      startRun((mentioned ?? named)!, message, message.t, mentioned ? 'mention' : 'name');
      looks.push({ kind: mentioned ? 'mention' : 'name', at: message.t, message: message.key, agent: mentioned ?? named });
      return;
    }

    // ── A reply to an agent: judged as it arrives. ──
    const prior = before(message.t).slice(-FLOW.followUpReach);
    const spoke = [...prior].reverse().find(m => m.agent && m.t > message.t - FLOW.followUpSec);
    if (spoke) {
      const at = Math.max(message.t + FLOW.pollSec, busyUntil, runUntil);
      const between = timeline.filter(m => m.t > spoke.t && m.t < message.t).sort(byTime);
      const check = app.followUp({ agentMessage: asLine(spoke), between: between.map(asLine), latest: asLine(message) });
      const asked = await ask(check.state, check.questions);
      let clock = at + asked.ms / 1000;
      const look: Record<string, unknown> = { kind: 'follow_up', at, message: message.key, agent: spoke.from, answers: asked.ok ? asked.answers : null };
      looks.push(look);
      if (asked.ok && app.decideFollowUp(asked.answers)) {
        const agent = spoke.from as AgentKey;
        if (spoke.mentionBy === message.from) {
          look['outcome'] = 'continues_run';
          busyUntil = clock;
          startRun(agent, message, clock, 'continue');
          return;
        }
        const root = spoke.root ?? spoke.key;
        const count = since('5b') ? followUps.get(root) ?? 0 : spoke.chain ?? 0;
        if (count >= FLOW.followUpCap) {
          Object.assign(look, { outcome: 'silent', because: 'follow_up_cap' });
          busyUntil = clock;
          return;
        }
        followUps.set(root, (followUps.get(root) ?? 0) + 1);
        const result = await draftAndCheck(agent, [message], clock);
        clock = result.clock;
        look['draft'] = result;
        const stale = clock > message.t + FLOW.staleSec;
        if ((result.outcome === 'answer' || result.outcome === 'offer') && !stale) {
          post(agent, clock, result.text!, { chain: (spoke.chain ?? 0) + 1, root });
          acts.push({ act: result.outcome, agent, to: liveOf([message]), at: clock, via: 'follow_up', text: result.text! });
          look['outcome'] = result.outcome;
        } else look['outcome'] = stale ? 'stale' : result.outcome;
        busyUntil = clock;
        return;
      }
      look['outcome'] = asked.ok ? 'not_for_agent' : `gate_error:${asked.reason}`;
      busyUntil = clock;
      // Not for the agent: an ordinary message, into its author's turn.
    }

    // ── Anything else: its author's turn. ──
    const open = turns.find(turn => turn.person === message.from && !turn.closed);
    if (open && message.t - open.last <= FLOW.lullSec && message.t - open.start < FLOW.turnMaxSec) {
      open.msgs.push(message);
      open.last = message.t;
      if (open.msgs.length >= FLOW.turnMaxMessages) open.closed = true;
    } else {
      if (open) open.closed = true;
      turns.push({ person: message.from, msgs: [message], start: message.t, last: message.t, closed: false });
    }
  }

  async function lookAt(turn: Turn, at: number) {
    const look: Record<string, unknown> = { kind: 'turn', at, due: due(turn), turn: turn.msgs.map(m => m.key) };
    looks.push(look);
    if (ambientPosts.filter(p => p > at - FLOW.rateWindowSec).length >= FLOW.ratePosts) {
      Object.assign(look, { outcome: 'silent', because: 'rate_limited' });
      return;
    }
    const visible = visibleAt(at);
    const from = Math.max(0, visible.indexOf(turn.msgs[0]!) - EARLIER);
    const recent = visible.slice(from, from + WINDOW);
    const judged = turn.msgs.map(m => recent.indexOf(m)).filter(i => i >= 0);
    const first = turnCheck(recent.map(asLine), judged);
    const asked1 = await ask(first.state, first.questions);
    let clock = at + asked1.ms / 1000;
    if (!asked1.ok) { Object.assign(look, { outcome: 'gate_error', because: asked1.reason }); busyUntil = clock; return; }
    const opened = openTurn(asked1.answers, judged);
    look['step1'] = { ...opened, scores: Object.fromEntries(Object.entries(opened.scores).map(([i, s]) => [recent[Number(i)]!.key, s])) };
    if (opened.open.length === 0) { Object.assign(look, { outcome: 'silent', because: opened.because }); busyUntil = clock; return; }

    const candidates = candidatesAt(at);
    const second = agentCheckFlow({
      room: scenario.room.name, roomSummary: scenario.room.summary,
      earlier: before(turn.start).slice(-EARLIER).map(asLine), question: turnLine(turn.msgs),
      after: visible.filter(m => m.t > turn.last).map(asLine), candidates,
    });
    const asked2 = await ask(second.state, second.questions);
    clock += asked2.ms / 1000;
    if (!asked2.ok) { Object.assign(look, { outcome: 'gate_error', because: asked2.reason }); busyUntil = clock; return; }
    const decision = decideAgentFlow(asked2.answers, candidates);
    look['step2'] = { choice: asked2.answers['best_agent'].choice, confidence: asked2.answers['best_agent'].confidence,
      fits: candidates.map((c, i) => ({ agent: c.key, fit: app.fitOf(asked2.answers, i) })), decision };
    if (!decision.speak) { Object.assign(look, { outcome: 'silent', because: decision.because }); busyUntil = clock; return; }

    const agent = scenario.room.agents[decision.candidateIndex]!;
    const result = await draftAndCheck(agent, turn.msgs, clock);
    clock = result.clock;
    look['draft'] = result;
    const stale = clock > due(turn) + FLOW.staleSec;
    if ((result.outcome === 'answer' || result.outcome === 'offer') && !stale) {
      post(agent, clock, result.text!, { chain: 0 });
      ambientPosts.push(clock);
      acts.push({ act: result.outcome, agent, to: liveOf(turn.msgs), at: clock, via: 'turn', text: result.text! });
      look['outcome'] = result.outcome;
    } else look['outcome'] = stale ? 'stale' : result.outcome;
    busyUntil = clock;
  }

  // ── The clock: the next arrival, or the next turn that can be looked at. ──
  let next = 0;
  for (;;) {
    const arrival = incoming[next];
    const ready = turns.map(turn => ({ turn, at: Math.max(due(turn), busyUntil, runUntil) })).sort((a, b) => a.at - b.at)[0];
    if (!arrival && !ready) break;
    if (arrival && (!ready || arrival.t <= ready.at)) { await arrive(arrival); next += 1; continue; }
    turns.splice(turns.indexOf(ready!.turn), 1);
    await lookAt(ready!.turn, ready!.at);
  }

  return {
    id: scenario.id, group: scenario.group, title: scenario.title, room: scenario.room.name, agents: scenario.room.agents,
    expect: scenario.expect, within: scenario.within ?? null, maxPosts: scenario.maxPosts ?? null, why: scenario.why,
    events: timeline.sort(byTime).map(m => ({ key: m.key, t: Math.round(m.t * 10) / 10, from: m.from, text: m.text, live: m.live, posted: m.posted })),
    acts: acts.map(a => ({ ...a, at: Math.round(a.at * 10) / 10 })),
    looks,
  };
}

async function main() {
  const only = process.argv.slice(2);
  const chosen = FLOW_SCENARIOS.filter(s => only.length === 0 || only.includes(s.id));
  const queue = Array.from({ length: REPS }, (_r, rep) => chosen.map(s => ({ s, rep }))).flat();
  const results: unknown[] = new Array(queue.length);
  const started = performance.now();
  let cursor = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (cursor < queue.length) {
      const index = cursor++;
      const { s, rep } = queue[index]!;
      const t0 = performance.now();
      try {
        results[index] = { ...(await simulate(s)), rep };
      } catch (error) {
        results[index] = { id: s.id, rep, crashed: (error as Error).message };
      }
      process.stdout.write(`${s.id}${REPS > 1 ? ` #${rep + 1}` : ''} ${s.title} — ${Math.round((performance.now() - t0) / 1000)}s\n`);
    }
  }));
  const out = { round: ROUND, reps: REPS, ranAt: new Date(BASE).toISOString(), model: 'jev-1.13.0', flow: FLOW, toolkits: TOOLKITS,
    wallSec: Math.round((performance.now() - started) / 1000), scenarios: results };
  writeFileSync(new URL(`./results/flow-v${ROUND}${only.length ? '-partial' : ''}.json`, import.meta.url), JSON.stringify(out, null, 2) + '\n');
  process.stdout.write(`done in ${out.wallSec}s\n`);
  await pool.end();
}

await main();
