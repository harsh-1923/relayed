// Ambient answers end to end against Postgres, with Jev and the runtime stood
// in for (docs/AMBIENT-RESPONSES.md, tests that must exist §17).
//
// SCOPED TO THIS FILE'S OWN AGENTS. The due queries look across every
// workspace in the database — the dev database included — so every call here
// passes this file's agent handles as the allowlist. Nothing here can find, let
// alone post into, a chat it did not create.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { sql } from 'kysely';
import { db, pool, reachable } from '../../db/client.ts';
import { ulid } from '../../db/ulid.ts';
import { env } from '../../env.ts';
import { createChannel, joinSpace } from '../../sync/spaces.ts';
import { send } from '../../sync/ops.ts';
import Fastify from 'fastify';
import { JevError, type Jev, type JevErrorReason, type Question } from './jev.ts';
import { ambientRoutes } from './routes.ts';
import {
  AMBIENT_RULES, dueFollowUps, dueTurns, groupTurns, look, runtimeDraft, sweepStale,
  type AmbientDeps, type Draft, type Due,
} from './loop.ts';

const up = await reachable();
const opts = up ? {} : { skip: 'postgres not reachable — run `pnpm services`' };

const org = ulid('org');
const wsp = ulid('wsp');
const alice = ulid('act');
const bob = ulid('act');
const triage = ulid('act');
const scribe = ulid('act');
const suffix = triage.slice(-6).toLowerCase();
const handles = { triage: `t-${suffix}`, scribe: `s-${suffix}` };
const allow = [handles.triage, handles.scribe];

before(async () => {
  if (!up) return;
  await db.insertInto('organizations').values({ id: org, workos_org_id: `test_${org}`, name: 'Ambient' }).execute();
  await db.insertInto('workspaces').values({ id: wsp, org_id: org, name: 'Ambient', slug: `a-${suffix}` }).execute();
  const people = [[alice, 'Alice', `alice-${suffix}`], [bob, 'Bob', `bob-${suffix}`]] as const;
  for (const [id, name, handle] of people) {
    await db.insertInto('actors').values({
      id, org_id: org, workspace_id: wsp, type: 'human', handle, display_name: name, avatar_url: null,
      identity_kind: 'workos_user', identity_id: `wu_${id}`, owner_actor_id: null, provisioned_by: 'api', state: 'active',
    }).execute();
    await db.insertInto('memberships').values({ scope_type: 'workspace', scope_id: wsp, actor_id: id, role: 'member' }).execute();
  }
  const agents = [[triage, 'Triage', handles.triage, 'Investigates infrastructure incidents.'],
                  [scribe, 'Scribe', handles.scribe, 'Writes release notes.']] as const;
  for (const [id, name, handle, description] of agents) {
    await db.insertInto('actors').values({
      id, org_id: org, workspace_id: wsp, type: 'agent', handle, display_name: name, avatar_url: null,
      identity_kind: 'system', identity_id: null, owner_actor_id: alice, provisioned_by: 'api', state: 'active',
    }).execute();
    await db.insertInto('memberships').values({ scope_type: 'workspace', scope_id: wsp, actor_id: id, role: 'member' }).execute();
    await db.insertInto('agents').values({ actor_id: id, workspace_id: wsp, description, instructions: `You are ${name}.` }).execute();
  }
});

after(async () => {
  if (!up) return;
  await db.deleteFrom('sync_events').where('workspace_id', '=', wsp).execute();
  await db.deleteFrom('spaces').where('workspace_id', '=', wsp).execute();
  await db.deleteFrom('memberships').where('scope_id', '=', wsp).execute();
  await db.deleteFrom('organizations').where('id', '=', org).execute();
  await pool.end();
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** A channel with Alice, Bob and the given agents in it. */
async function channel(...agents: string[]): Promise<{ chatId: string; spaceId: string }> {
  const made = await createChannel(db, { workspaceId: wsp, name: `a-${ulid('x').slice(-8).toLowerCase()}`, createdBy: alice });
  for (const id of [bob, ...agents]) await joinSpace(db, made.spaceId, id);
  return { chatId: made.chatId, spaceId: made.spaceId };
}

async function speak(chatId: string, actorId: string, body: string): Promise<string> {
  const messageId = ulid('msg');
  await send(db, { opId: ulid('op'), chatId, actorId, messageId, body });
  return messageId;
}

type Gate = 'message' | 'agent' | 'draft' | 'offer' | 'meanwhile' | 'follow_up';
type Answers = Record<string, unknown>;
type Scripted = (state: Record<string, unknown>, questions: Record<string, Question>) => Answers;
interface Script {
  message?: Scripted;
  agent?: Scripted;
  draft?: Scripted;
  offer?: Scripted;
  meanwhile?: Scripted;
  follow_up?: Scripted;
  fail?: Partial<Record<Gate, JevErrorReason>>;
}

/** Which call this is, told apart by the questions it asks. */
const gateOf = (questions: Record<string, Question>): Gate =>
  'best_agent' in questions ? 'agent' : 'useful' in questions ? 'draft' : 'kept_there' in questions ? 'offer'
    : 'handled' in questions ? 'meanwhile' : 'to_agent' in questions ? 'follow_up' : 'message';

/** A Jev that answers from `script`. */
function stubJev(script: Script): Jev & { calls: { gate: Gate; state: Record<string, unknown> }[] } {
  const calls: { gate: Gate; state: Record<string, unknown> }[] = [];
  return {
    calls,
    async ask(state, questions) {
      const gate = gateOf(questions);
      calls.push({ gate, state: state as Record<string, unknown> });
      const failure = script.fail?.[gate];
      if (failure) throw new JevError(failure, 'stub');
      const answers = script[gate]?.(state as Record<string, unknown>, questions);
      if (!answers) throw new Error(`the script has no answer for ${gate}`);
      return { model: 'jev-1.13.0', answers: answers as never, inputTokens: 100 };
    },
  };
}

const noul = (value: number) => ({ noul: value });

type Score = 'need' | 'answered' | 'to_person' | 'wants' | 'person' | 'sensitive' | 'plan';

/** Step 1: every judged message is an open question, the newest with `newest`'s scores. */
const openAll = (newest: Partial<Record<Score, number>> = {}, others: Partial<Record<Score, number>> = {}): Scripted =>
  (_state, questions) => {
    const judged = Object.keys(questions).filter(key => key.startsWith('need_')).map(key => Number(key.slice(5)));
    const last = Math.max(...judged);
    const answers: Answers = {};
    for (const i of judged) {
      const s = i === last ? newest : others;
      answers[`need_${i}`] = noul(s.need ?? 0.97);
      answers[`answered_${i}`] = noul(s.answered ?? 0.06);
      answers[`to_person_${i}`] = noul(s.to_person ?? 0.05);
      answers[`wants_${i}`] = noul(s.wants ?? 0.85);
      answers[`person_${i}`] = noul(s.person ?? 0.05);
      answers[`sensitive_${i}`] = noul(s.sensitive ?? 0.02);
      answers[`plan_${i}`] = noul(s.plan ?? 0.03);
    }
    return answers;
  };
/** Step 1: the newest judged message is an open question; every other one asks nothing. */
const openNewest = (newest: Partial<Record<Score, number>> = {}): Scripted => openAll(newest, { need: 0.03, wants: 0.2 });

/** Step 2: `handle` fits by its setup; everyone else fits nothing. */
const choose = (handle: string): Scripted => state => {
  const agents = state['agents'] as { handle: string }[];
  const answers: Answers = { best_agent: { choice: `@${handle}`, probabilities: { [`@${handle}`]: 0.94 }, confidence: 0.9 } };
  agents.forEach((agent, index) => {
    answers[`fits_role_${index}`] = noul(agent.handle === `@${handle}` ? 0.9 : 0.1);
    answers[`fits_here_${index}`] = noul(0.1);
  });
  return answers;
};

const helps: Scripted = () => ({ useful: noul(0.9), deflects: noul(0.05) });
const keptThere: Scripted = () => ({ kept_there: noul(0.8), asks_info: noul(0.9), fits: noul(0.8) });
const nobodyAnswered: Scripted = () => ({ handled: noul(0.03) });

/** Every check passes for `handle`. */
const passAll = (handle: string): Script => ({ message: openNewest(), agent: choose(handle), draft: helps, offer: keptThere, meanwhile: nobodyAnswered });

function deps(jev: Jev, draft: (request: Parameters<AmbientDeps['draft']>[0]) => Promise<Draft>, patch: Partial<AmbientDeps> = {}): AmbientDeps {
  return { db, registry: null, jev, mode: 'live', lullSec: 0, handles: allow, recall: false, draft, toolkits: async () => [], ...patch };
}

const drafting = (text: string) => async (): Promise<Draft> => ({ ok: true, text });

/** The oldest due turn in `chatId`, if any. */
async function dueIn(chatId: string, lullSec = 0): Promise<Due | undefined> {
  return (await dueTurns(db, allow, lullSec, 50)).find(due => due.chatId === chatId);
}
const followUpIn = async (chatId: string) => (await dueFollowUps(db, allow, 50)).find(due => due.chatId === chatId);

const agentMessages = (chatId: string) => db.selectFrom('messages')
  .select(['id', 'author_id', 'parent_id', 'body', 'parts', 'on_behalf_of_actor_id', 'delegation_id'])
  .where('chat_id', '=', chatId).where('author_id', 'in', [triage, scribe]).orderBy('ord').execute();

const decisionsIn = (chatId: string) => db.selectFrom('ambient_decisions').selectAll()
  .where('chat_id', '=', chatId).orderBy('created_at').execute();

/** Ask, and have the agent answer it: the fixture most tests start from. */
async function answered(chatId: string, question = 'anyone know why the rebuild is slow?', text = 'Partitions.') {
  const questionId = await speak(chatId, alice, question);
  const due = await dueIn(chatId);
  assert.ok(due);
  assert.equal(await look(deps(stubJev(passAll(handles.triage)), drafting(text)), due), 'posted');
  const [answer] = await agentMessages(chatId);
  assert.ok(answer);
  return { questionId, answerId: answer.id };
}

// ─── The tables ─────────────────────────────────────────────────────────────

test('each constraint on ambient_decisions refuses what it names', opts, async () => {
  const { chatId } = await channel(triage);
  const row = (patch: Record<string, unknown>) => db.insertInto('ambient_decisions').values({
    id: ulid('amb'), workspace_id: wsp, chat_id: chatId, kind: 'ambient', from_ord: 1, through_ord: 1, outcome: 'silent', ...patch,
  } as never).execute();

  await assert.rejects(row({ kind: 'mention' }), /ambient_kind/);
  await assert.rejects(row({ outcome: 'maybe' }), /ambient_outcome/);
  await assert.rejects(row({ from_ord: 5, through_ord: 4 }), /ambient_window/);
  await row({ through_ord: 7, from_ord: 7 });
  await assert.rejects(row({ through_ord: 7, from_ord: 7 }), /ambient_once/, 'the same window, twice');
  await row({ kind: 'follow_up', through_ord: 7, from_ord: 7 });   // the other kind may look at it
  await row({ outcome: 'pending', through_ord: 8, from_ord: 8 });
  await assert.rejects(row({ outcome: 'pending', through_ord: 9, from_ord: 9 }), /ambient_one_look/, 'one look at a time per chat');
});

// ─── Turns ──────────────────────────────────────────────────────────────────

test('what one person said in a row is a turn; other people\'s messages are context, never a delay', () => {
  const at = (s: number) => 1_000_000 + s * 1_000;
  const m = (id: string, authorId: string, s: number) => ({ id, ord: s, authorId, at: at(s) });
  const turns = groupTurns([m('a1', 'alice', 0), m('a2', 'alice', 3), m('b1', 'bob', 40), m('c1', 'carol', 70), m('a3', 'alice', 200)], 90);
  assert.deepEqual(turns.map(turn => [turn.authorId, turn.messages.map(x => x.id), turn.closed]), [
    ['alice', ['a1', 'a2'], true],      // closed by her later message, past the lull
    ['bob', ['b1'], false],
    ['carol', ['c1'], false],
    ['alice', ['a3'], false],
  ]);
  const long = groupTurns(Array.from({ length: 7 }, (_x, i) => m(`a${i}`, 'alice', i * 20)), 90);
  assert.deepEqual(long.map(turn => turn.messages.length), [5, 2], 'a turn closes at five messages');
  const slow = groupTurns(Array.from({ length: 4 }, (_x, i) => m(`a${i}`, 'alice', i * 80)), 90);
  assert.deepEqual(slow.map(turn => turn.messages.length), [3, 1], 'or three minutes after it began');
});

test('a turn is due once its author has been quiet for the lull, whatever others say', opts, async () => {
  const { chatId } = await channel(triage);
  const question = await speak(chatId, alice, 'anyone know why the rebuild is slow?');
  assert.ok(await dueIn(chatId, 0), 'quiet long enough');
  assert.equal(await dueIn(chatId, 3_600), undefined, 'not yet quiet for an hour');
  await db.updateTable('messages').set({ created_at: sql`now() - interval '2 minutes'` }).where('id', '=', question).execute();
  await speak(chatId, bob, 'lol did you see standup');
  const due = await dueIn(chatId, 90);
  assert.deepEqual(due?.messageIds, [question], 'Alice\'s turn is due at 90 s; Bob\'s chatter is not a new message of hers');
});

test('two questions back to back from one person are one turn, and one answer', opts, async () => {
  const { chatId } = await channel(triage);
  const first = await speak(chatId, alice, 'are we on track for the Oct 14 cutover?');
  const second = await speak(chatId, alice, 'who is working on it?');
  await age(chatId, 2);
  const due = await dueIn(chatId, 90);
  assert.deepEqual(due?.messageIds, [first, second], 'within 90 s of each other, and quiet since');
  const requests: Parameters<AmbientDeps['draft']>[0][] = [];
  const jev = stubJev({ ...passAll(handles.triage), message: openAll() });
  assert.equal(await look(deps(jev, async request => { requests.push(request); return { ok: true, text: 'Yes; Harsh is on HAR-24.' }; }), due!), 'posted');
  assert.equal((await agentMessages(chatId)).length, 1, 'one answer covering both');
  assert.match(requests[0]?.prompt ?? '', /The request:\n\nAlice .*cutover\?\nwho is working on it\?/, 'drafted from the whole turn');
  const step1 = jev.calls.find(call => call.gate === 'message')!.state['recent'] as unknown[];
  assert.equal(step1.length, 2, 'both judged');
  const [decision] = await decisionsIn(chatId);
  assert.equal(decision?.trigger_message_id, first, 'the marker points at the first open question');
  assert.equal(await dueIn(chatId, 90), undefined, 'both judged');
});

test('a newer question from someone else does not bury an older one: two turns, oldest first', opts, async () => {
  const { chatId } = await channel(triage);
  const older = await speak(chatId, alice, 'when is the cutover planned?');
  const newer = await speak(chatId, bob, 'anyone up for lunch at 1?');
  const first = await dueIn(chatId);
  assert.deepEqual(first?.messageIds, [older], 'Alice\'s turn first');
  assert.equal(await look(deps(stubJev(passAll(handles.triage)), drafting('Oct 14.')), first!), 'posted');
  const second = await dueIn(chatId);
  assert.deepEqual(second?.messageIds, [newer], 'then Bob\'s, on its own');
  const unfit: Script = { ...passAll(handles.triage), agent: state => ({ ...choose(handles.triage)(state, {}), fits_role_0: noul(0.2) }) };
  assert.equal(await look(deps(stubJev(unfit), drafting('x')), second!), 'silent');
  assert.equal((await decisionsIn(chatId))[1]?.because, 'unfit');
  assert.equal(await dueIn(chatId), undefined);
});

test('one look at a time per chat: while one is pending, nothing else there is due', opts, async () => {
  const { chatId } = await channel(triage);
  await speak(chatId, alice, 'when is the cutover?');
  await speak(chatId, bob, 'yeah when is it?');
  await db.insertInto('ambient_decisions').values({
    id: ulid('amb'), workspace_id: wsp, chat_id: chatId, kind: 'ambient', from_ord: 1, through_ord: 1,
    lease_until: sql`now() + interval '1 minute'`,
  } as never).execute();
  assert.equal(await dueIn(chatId), undefined);
  assert.equal(await followUpIn(chatId), undefined);
});

test('an agent\'s message is never a turn, and a mention is the mention path', opts, async () => {
  const { chatId } = await channel(triage);
  await speak(chatId, triage, 'here');
  assert.equal(await dueIn(chatId), undefined, 'only a person\'s message is judged');
  const mention = await speak(chatId, alice, `[Triage](actor:${triage}) why is staging down?`);
  await db.updateTable('agent_runs').set({ state: 'completed' }).where('trigger_message_id', '=', mention).execute();
  assert.equal(await dueIn(chatId), undefined, 'a run answers it; ambient stands aside');
});

test('an agent\'s name used as an address is a mention: a run, and nothing for the loop', opts, async () => {
  const { chatId } = await channel(triage);
  const named = await speak(chatId, alice, 'Triage, who owns the rollback script?');
  const runs = await db.selectFrom('agent_runs').select(['agent_actor_id', 'invoker_actor_id']).where('trigger_message_id', '=', named).execute();
  assert.deepEqual(runs, [{ agent_actor_id: triage, invoker_actor_id: alice }]);
  await db.updateTable('agent_runs').set({ state: 'completed' }).where('trigger_message_id', '=', named).execute();
  assert.equal(await dueIn(chatId), undefined, 'the run answers it');
  const verb = await speak(chatId, bob, 'triage the flaky tests before standup');
  assert.equal((await db.selectFrom('agent_runs').select('id').where('trigger_message_id', '=', verb).execute()).length, 0, 'the word, not the agent');
  assert.deepEqual((await dueIn(chatId))?.messageIds, [verb], 'a turn like any other');
});

test('a chat with a run in flight is not due: an agent is already answering there', opts, async () => {
  const { chatId } = await channel(triage);
  await speak(chatId, alice, 'anyone?');
  const other = await speak(chatId, bob, 'deploying now');
  await db.insertInto('agent_runs').values({
    id: ulid('run'), workspace_id: wsp, agent_actor_id: triage, invoker_actor_id: bob, chat_id: chatId,
    trigger_message_id: other, state: 'running',
  } as never).execute();
  assert.equal(await dueIn(chatId), undefined, 'Alice\'s turn waits for the run');
});

/** Move a chat's messages into the past, as if they were sent `minutes` ago. */
const age = (chatId: string, minutes: number) => db.updateTable('messages')
  .set({ created_at: sql`now() - (${minutes} * interval '1 minute')` }).where('chat_id', '=', chatId).execute();

test('a question from long ago is not due when its room wakes up, and neither is an old follow-up', opts, async () => {
  const { chatId } = await channel(triage);
  await speak(chatId, alice, 'anyone know why the rebuild is slow?');
  await age(chatId, 120);
  assert.equal(await dueIn(chatId), undefined, 'two hours old: nobody is waiting on an answer now');
  await speak(chatId, triage, 'Partitions.');
  await speak(chatId, alice, 'can it be faster?');
  await age(chatId, 120);
  assert.equal(await followUpIn(chatId), undefined);
});

test('the system\'s own agents may answer unprompted too — Relay among them', opts, async () => {
  const relay = ulid('act');
  const handle = `relay-${suffix}`;
  await db.insertInto('actors').values({
    id: relay, org_id: org, workspace_id: wsp, type: 'agent', handle, display_name: 'Relay', avatar_url: null,
    identity_kind: 'system', identity_id: null, owner_actor_id: null, provisioned_by: 'system', state: 'active',
  }).execute();
  await db.insertInto('memberships').values({ scope_type: 'workspace', scope_id: wsp, actor_id: relay, role: 'member' }).execute();
  await db.insertInto('agents').values({ actor_id: relay, workspace_id: wsp, description: 'The workspace assistant.', instructions: 'You are Relay.' }).execute();
  const { chatId } = await channel(relay);
  await speak(chatId, alice, 'what did I miss here?');
  const due = (await dueTurns(db, [handle], 0, 50)).find(d => d.chatId === chatId);
  assert.ok(due, 'a room whose only agent is a system agent is looked at');
  assert.equal(await look(deps(stubJev(passAll(handle)), drafting('The team fixed the SSO stall.'), { handles: [handle] }), due), 'posted');
  assert.equal((await db.selectFrom('messages').select('author_id').where('chat_id', '=', chatId).where('author_id', '=', relay).execute()).length, 1);
});

test('a chat with no agent in the allowlist is never due', opts, async () => {
  const { chatId } = await channel(triage);
  await speak(chatId, alice, 'anyone?');
  assert.equal((await dueTurns(db, [handles.scribe], 0, 50)).find(due => due.chatId === chatId), undefined);
});

// ─── Speaking ───────────────────────────────────────────────────────────────

test('an ambient answer is the agent speaking with nobody\'s authority, and it starts nothing', opts, async () => {
  const { chatId } = await channel(triage, scribe);
  await speak(chatId, bob, 'morning');
  const chatter = await dueIn(chatId);
  assert.equal(await look(deps(stubJev({ message: openNewest({ need: 0.03 }) }), drafting('x')), chatter!), 'silent');
  const question = await speak(chatId, alice, 'anyone know why the index rebuild takes 3x longer than the runbook?');
  const requests: Parameters<AmbientDeps['draft']>[0][] = [];
  const jev = stubJev(passAll(handles.triage));
  const draft = async (request: Parameters<AmbientDeps['draft']>[0]): Promise<Draft> => {
    requests.push(request);
    return { ok: true, text: `It was switched to one partition at a time. [Scribe](actor:${scribe}) has the notes.` };
  };

  const due = await dueIn(chatId);
  assert.deepEqual(due?.messageIds, [question]);
  assert.equal(await look(deps(jev, draft), due!), 'posted');

  const [answer] = await agentMessages(chatId);
  assert.ok(answer);
  assert.equal(answer.author_id, triage);
  assert.equal(answer.on_behalf_of_actor_id, null, 'nobody\'s authority was spent (invariant 89)');
  assert.equal(answer.delegation_id, null);
  assert.equal(answer.parent_id, question, 'where a mention\'s reply to that message would go');
  const parts = (typeof answer.parts === 'string' ? JSON.parse(answer.parts) : answer.parts) as { kind: string; answering?: string; asker?: string }[];
  assert.deepEqual(parts[0], { kind: 'ambient', answering: question, asker: 'Alice' });
  assert.match(answer.body, /actor-ref:/, 'an unprompted answer gets nobody\'s attention');
  assert.doesNotMatch(answer.body, /\]\(actor:/);

  const runs = await db.selectFrom('agent_runs').select('id').where('chat_id', '=', chatId).execute();
  assert.equal(runs.length, 0, 'a mention inside it starts no run (invariant 90)');

  const decision = (await decisionsIn(chatId))[1];
  assert.equal(decision?.outcome, 'posted');
  assert.equal(decision?.reply_message_id, answer.id);
  assert.equal(decision?.trigger_message_id, question);
  assert.equal(decision?.agent_actor_id, triage);
  assert.equal(decision?.exchange_message_id, answer.id, 'the exchange it starts');
  assert.equal(decision?.model, 'jev-1.13.0');
  assert.ok(decision?.gate1 && decision?.gate2, 'every probability is kept for tuning');
  assert.deepEqual(Object.keys(decision.gate1 as object).sort(), ['agent', 'message'], 'both steps');
  assert.deepEqual(Object.keys(decision.gate2 as object).sort(), ['answer', 'kind'], 'the draft check; nothing was said meanwhile');
  const judged = await db.selectFrom('ambient_judged').select('decision_id').where('message_id', '=', question).executeTakeFirst();
  assert.equal(judged?.decision_id, decision?.id, 'the question is judged');

  const [request] = requests;
  assert.deepEqual(request?.tools, [], 'no tools, so no grant');
  assert.ok(request?.systemPrompt?.includes(AMBIENT_RULES), 'told it was not asked');
  assert.match(request?.prompt ?? '', /The request:\n\nAlice .*3x longer/);
  assert.match(request?.prompt ?? '', /Bob .*morning/, 'the conversation before it is read');

  assert.equal(await dueIn(chatId), undefined, 'everything is judged, so nothing is due');
});

test('every ending but a good answer posts nothing', opts, async () => {
  const cases: [string, Script, (() => Promise<Draft>), string, string | null][] = [
    ['no question', { ...passAll(handles.triage), message: openNewest({ need: 0.3 }) }, drafting('x'), 'silent', 'no_need'],
    ['a person answered it', { ...passAll(handles.triage), message: openNewest({ answered: 0.97 }) }, drafting('x'), 'silent', 'handled'],
    ['venting', { ...passAll(handles.triage), message: openNewest({ wants: 0.22 }) }, drafting('x'), 'silent', 'rhetorical'],
    ['asking for a review', { ...passAll(handles.triage), message: openNewest({ person: 0.95 }) }, drafting('x'), 'silent', 'needs_person'],
    ['personal or sensitive', { ...passAll(handles.triage), message: openNewest({ sensitive: 0.92 }) }, drafting('x'), 'silent', 'sensitive'],
    ['a plan for the team', { ...passAll(handles.triage), message: openNewest({ plan: 0.97 }) }, drafting('x'), 'silent', 'plan'],
    ['no agent fits', { ...passAll(handles.triage), agent: state => ({ ...choose(handles.triage)(state, {}), fits_role_0: noul(0.2) }) },
      drafting('x'), 'silent', 'unfit'],
    ['the model declines', passAll(handles.triage), drafting('NOTHING'), 'declined', null],
    ['the model declines in its own words', passAll(handles.triage), drafting('NO_CONTENT'), 'declined', null],
    ['the draft does not help', { ...passAll(handles.triage), draft: () => ({ useful: noul(0.4), deflects: noul(0.05) }) },
      drafting('Unrelated.'), 'suppressed', 'not_useful'],
    ['the draft is a deflection', { ...passAll(handles.triage), draft: () => ({ useful: noul(0.81), deflects: noul(0.87) }) },
      drafting('I can\'t see the logs from here.'), 'suppressed', 'deflects'],
    ['the offer names nothing connected', passAll(handles.triage), drafting('OFFER: the error rate | Grafana'), 'suppressed', 'unknown_toolkit'],
    ['Jev is rate limited', { fail: { message: 'rate_limited' } }, drafting('x'), 'gate_error', 'rate_limited'],
    ['the runtime fails', passAll(handles.triage), async () => ({ ok: false }), 'failed', 'runtime'],
  ];
  for (const [name, script, draft, outcome, because] of cases) {
    const { chatId } = await channel(triage);
    await speak(chatId, alice, 'anyone know why the rebuild is slow?');
    const due = await dueIn(chatId);
    assert.ok(due, name);
    assert.equal(await look(deps(stubJev(script), draft), due), outcome, name);
    assert.equal((await agentMessages(chatId)).length, 0, `${name}: nothing posted`);
    const [decision] = await decisionsIn(chatId);
    assert.equal(decision?.outcome, outcome, name);
    assert.equal(decision?.because, because, name);
  }
});

test('three unprompted answers in a chat in ten minutes, then quiet', opts, async () => {
  const { chatId } = await channel(triage);
  for (let i = 0; i < 3; i++) {
    await db.insertInto('ambient_decisions').values({
      id: ulid('amb'), workspace_id: wsp, chat_id: chatId, kind: 'ambient', from_ord: -i - 1, through_ord: -i - 1,
      outcome: 'posted', finished_at: sql`now() - interval '1 minute'`,
    } as never).execute();
  }
  await speak(chatId, alice, 'and which runbook section covers rollback?');
  const due = await dueIn(chatId);
  assert.ok(due);
  const jev = stubJev(passAll(handles.triage));
  assert.equal(await look(deps(jev, drafting('Section 4.')), due), 'silent');
  assert.equal((await decisionsIn(chatId)).at(-1)?.because, 'rate_limited');
  assert.equal(jev.calls.length, 0, 'decided before any Jev call');
});

test('in shadow, a good answer is kept for a person to read and never posted', opts, async () => {
  const { chatId } = await channel(triage);
  await speak(chatId, alice, 'anyone know why the rebuild is slow?');
  const due = await dueIn(chatId);
  assert.ok(due);
  const outcome = await look(deps(stubJev(passAll(handles.triage)), drafting('Partitions.'), { mode: 'shadow' }), due);
  assert.equal(outcome, 'shadow');
  assert.equal((await agentMessages(chatId)).length, 0);
  const [decision] = await decisionsIn(chatId);
  assert.equal(decision?.draft, 'Partitions.');
});

test('the draft check reads the chat again: a person answering while the agent works suppresses the draft', opts, async () => {
  const { chatId } = await channel(triage);
  await speak(chatId, alice, 'anyone know why the rebuild is slow?');
  const jev = stubJev({
    ...passAll(handles.triage),
    meanwhile: state => {
      const since = state['since'] as { text: string }[];
      return { handled: noul(since.some(line => line.text.includes('vacuum')) ? 0.91 : 0) };
    },
  });
  const draft = async (): Promise<Draft> => {
    await speak(chatId, bob, "it's the autovacuum, I'm on it");
    return { ok: true, text: 'Partitions.' };
  };
  const due = await dueIn(chatId);
  assert.ok(due);
  assert.equal(await look(deps(jev, draft), due), 'suppressed');
  assert.equal((await decisionsIn(chatId))[0]?.because, 'handled');
});

test('the same turn is never acted on twice', opts, async () => {
  const { chatId } = await channel(triage);
  await speak(chatId, alice, 'anyone know why the rebuild is slow?');
  const due = await dueIn(chatId);
  assert.ok(due);
  const both = await Promise.all([
    look(deps(stubJev(passAll(handles.triage)), drafting('One.')), due),
    look(deps(stubJev(passAll(handles.triage)), drafting('Two.')), due),
  ]);
  assert.deepEqual(both.sort(), ['claimed_elsewhere', 'posted']);
  assert.equal((await agentMessages(chatId)).length, 1);
});

test('an agent that loses access to the chat mid-job does not post', opts, async () => {
  const { chatId, spaceId } = await channel(triage);
  await speak(chatId, alice, 'anyone know why the rebuild is slow?');
  const draft = async (): Promise<Draft> => {
    await db.updateTable('memberships').set({ left_at: sql`now()` })
      .where('scope_type', '=', 'space').where('scope_id', '=', spaceId).where('actor_id', '=', triage).execute();
    return { ok: true, text: 'Partitions.' };
  };
  const due = await dueIn(chatId);
  assert.ok(due);
  assert.equal(await look(deps(stubJev(passAll(handles.triage)), draft), due), 'withdrawn');
  assert.equal((await agentMessages(chatId)).length, 0);
});

test('a question deleted mid-job is not answered, and an answer ready too late is dropped', opts, async () => {
  const { chatId } = await channel(triage);
  const question = await speak(chatId, alice, 'anyone know why the rebuild is slow?');
  const draft = async (): Promise<Draft> => {
    await db.updateTable('messages').set({ deleted: true }).where('id', '=', question).execute();
    return { ok: true, text: 'Partitions.' };
  };
  const due = await dueIn(chatId);
  assert.ok(due);
  assert.equal(await look(deps(stubJev(passAll(handles.triage)), draft), due), 'withdrawn');

  const other = await channel(triage);
  await speak(other.chatId, alice, 'anyone know why the rebuild is slow?');
  const late = await dueIn(other.chatId);
  assert.ok(late);
  late.dueAt = new Date(Date.now() - 10 * 60_000);
  assert.equal(await look(deps(stubJev(passAll(handles.triage)), drafting('Partitions.')), late), 'stale');
  assert.equal((await decisionsIn(other.chatId))[0]?.because, 'too_late');
});

// ─── Offers ─────────────────────────────────────────────────────────────────

test('an answer may end with an offer; the offer\'s sentence is the server\'s, and it may stand alone', opts, async () => {
  const { chatId } = await channel(triage);
  await speak(chatId, alice, 'how many open bugs are tagged sync in Linear right now?');
  const due = await dueIn(chatId);
  assert.ok(due);
  const jev = stubJev(passAll(handles.triage));
  const toolkits = async () => ['Linear', 'GitHub'];
  assert.equal(await look(deps(jev, drafting('OFFER: the open bugs tagged sync | Linear'), { toolkits }), due), 'posted');
  const [offer] = await agentMessages(chatId);
  assert.equal(offer?.body, 'I can look up the open bugs tagged sync in Linear for you. Mention me if you want me to.');
  assert.deepEqual(jev.calls.map(call => call.gate), ['message', 'agent', 'offer'], 'no draft check for an offer alone');
  assert.equal(((await decisionsIn(chatId))[0]?.gate2 as { kind: string }).kind, 'offer');

  await speak(chatId, bob, 'and are we on track for the cutover?');
  const next = await dueIn(chatId);
  assert.ok(next);
  const both = stubJev(passAll(handles.triage));
  assert.equal(await look(deps(both, drafting('Yes — Oct 14.\n\nOFFER: the open cutover tickets | Linear'), { toolkits }), next), 'posted');
  const [, answer] = await agentMessages(chatId);
  assert.equal(answer?.body, 'Yes — Oct 14.\n\nI can look up the open cutover tickets in Linear for you. Mention me if you want me to.');
  assert.deepEqual(both.calls.map(call => call.gate).sort(), ['agent', 'draft', 'message', 'offer'], 'both parts checked; nothing was said since');
});

test('an offer never stands in for an answer that failed its check', opts, async () => {
  const { chatId } = await channel(triage);
  await speak(chatId, alice, 'are we on track for the Oct 14 cutover?');
  const due = await dueIn(chatId);
  assert.ok(due);
  const hedged: Script = { ...passAll(handles.triage), draft: () => ({ useful: noul(0.51), deflects: noul(0.57) }) };
  const outcome = await look(deps(stubJev(hedged), drafting('I don\'t have the current status.\n\nOFFER: the cutover plan | Jira'),
    { toolkits: async () => ['Jira'] }), due);
  assert.equal(outcome, 'suppressed', 'the offer passed; the answer did not; nothing posts');
  assert.equal((await agentMessages(chatId)).length, 0);
  assert.equal((await decisionsIn(chatId))[0]?.because, 'deflects');
});

test('an offer for the wrong tool is dropped, and the answer beside it still posts', opts, async () => {
  const { chatId } = await channel(triage);
  await speak(chatId, alice, 'is staging down right now?');
  const due = await dueIn(chatId);
  assert.ok(due);
  const slack: Script = { ...passAll(handles.triage), offer: () => ({ kept_there: noul(0.23), asks_info: noul(0.97), fits: noul(0.82) }) };
  const toolkits = async () => ['Slack'];
  assert.equal(await look(deps(stubJev(slack), drafting('OFFER: staging availability | Slack'), { toolkits }), due), 'suppressed');
  assert.equal((await decisionsIn(chatId))[0]?.because, 'not_kept_there');

  await speak(chatId, bob, 'and why was it slow yesterday?');
  const next = await dueIn(chatId);
  assert.ok(next);
  assert.equal(await look(deps(stubJev(slack), drafting('The autovacuum.\n\nOFFER: recent incidents | Slack'), { toolkits }), next), 'posted');
  assert.equal((await agentMessages(chatId))[0]?.body, 'The autovacuum.', 'the offer line is gone, the answer stands');
});

// ─── Follow-ups ─────────────────────────────────────────────────────────────

test('a person answering the agent is a follow-up, judged straight away without a lull', opts, async () => {
  const { chatId } = await channel(triage);
  await answered(chatId);

  const reply = await speak(chatId, alice, 'can it be made faster?');
  assert.equal(await dueIn(chatId, 3_600), undefined, 'not quiet — but a follow-up does not wait for that');
  const follow = await followUpIn(chatId);
  assert.equal(follow?.agentId, triage);
  assert.deepEqual(follow?.messageIds, [reply]);

  const jev = stubJev({ follow_up: () => ({ to_agent: noul(0.95), to_someone_else: noul(0.24) }), draft: helps, meanwhile: nobodyAnswered });
  assert.equal(await look(deps(jev, drafting('Run them in parallel.')), follow!), 'posted',
    'to someone else at 0.24 — the score the old bar of 0.2 turned away');
  assert.deepEqual(jev.calls.map(call => call.gate), ['follow_up', 'draft'], 'neither step is asked about a follow-up');
  const [first, second] = await agentMessages(chatId);
  assert.equal((await agentMessages(chatId)).length, 2);
  const decision = (await decisionsIn(chatId))[1];
  assert.equal(decision?.exchange_message_id, first?.id, 'the exchange the first answer started');
  assert.equal(decision?.reply_message_id, second?.id);
  assert.equal(await dueIn(chatId), undefined, 'judged: not a turn for the room');
});

test('a follow-up judged not to be for the agent leaves the room\'s question for its own turn', opts, async () => {
  const { chatId } = await channel(triage);
  await answered(chatId, 'anyone?', 'Here.');

  await speak(chatId, bob, 'does anyone know the deploy schedule?');
  const follow = await followUpIn(chatId);
  assert.ok(follow);
  const outcome = await look(deps(stubJev({ follow_up: () => ({ to_agent: noul(0.1), to_someone_else: noul(0.1) }) }), drafting('x')), follow);
  assert.equal(outcome, 'silent');
  assert.ok(await dueIn(chatId), 'still due as a turn');
  assert.equal(await followUpIn(chatId), undefined, 'judged once as a follow-up');
});

test('a follow-up to the asker\'s own mention continues their run, with their tools', opts, async () => {
  const { chatId } = await channel(triage);
  const mention = await speak(chatId, alice, `[Triage](actor:${triage}) how many sync bugs are open?`);
  const reply = ulid('msg');
  await db.updateTable('agent_runs').set({ state: 'completed', reply_message_id: reply }).where('trigger_message_id', '=', mention).execute();
  await send(db, { opId: ulid('op'), chatId, actorId: triage, messageId: reply, body: 'Seven, two of them urgent.' });

  const hers = await speak(chatId, alice, 'which of them are assigned to Bob?');
  const follow = await followUpIn(chatId);
  assert.deepEqual(follow?.messageIds, [hers]);
  const jev = stubJev({ follow_up: () => ({ to_agent: noul(0.97), to_someone_else: noul(0.27) }) });
  assert.equal(await look(deps(jev, drafting('x')), follow!), 'run');
  assert.deepEqual(jev.calls.map(call => call.gate), ['follow_up'], 'no draft: her run goes on');
  const runs = await db.selectFrom('agent_runs').select(['invoker_actor_id', 'agent_actor_id', 'state', 'chain_depth'])
    .where('trigger_message_id', '=', hers).execute();
  assert.deepEqual(runs, [{ invoker_actor_id: alice, agent_actor_id: triage, state: 'queued', chain_depth: 1 }], 'queued for Alice (invariant 94)');
  assert.equal((await decisionsIn(chatId)).at(-1)?.outcome, 'run');
  assert.equal(await dueIn(chatId), undefined);

  // Bob did not ask the agent: for him it drafts with no tools, as for any follow-up.
  await db.updateTable('agent_runs').set({ state: 'completed' }).where('trigger_message_id', '=', hers).execute();
  await speak(chatId, bob, 'and which are assigned to me?');
  const his = await followUpIn(chatId);
  assert.ok(his);
  const bobs = stubJev({ follow_up: () => ({ to_agent: noul(0.97), to_someone_else: noul(0.3) }), offer: keptThere });
  assert.equal(await look(deps(bobs, drafting('OFFER: the open sync bugs assigned to Bob | Linear'), { toolkits: async () => ['Linear'] }), his), 'posted');
  assert.equal((await db.selectFrom('agent_runs').select('id').where('chat_id', '=', chatId).execute()).length, 2, 'no run for Bob');
});

test('three follow-ups on one exchange, then quiet', opts, async () => {
  const { chatId } = await channel(triage);
  const { answerId } = await answered(chatId);
  const forAgent = () => stubJev({ follow_up: () => ({ to_agent: noul(0.95), to_someone_else: noul(0.24) }), draft: helps, meanwhile: nobodyAnswered });
  for (const text of ['and who owns it?', 'when was that decided?', 'why one at a time?']) {
    await speak(chatId, alice, text);
    const follow = await followUpIn(chatId);
    assert.ok(follow, text);
    assert.equal(await look(deps(forAgent(), drafting('Because.')), follow), 'posted', text);
  }
  await speak(chatId, alice, 'and does that make rollback slower?');
  const fourth = await followUpIn(chatId);
  assert.ok(fourth);
  assert.equal(await look(deps(forAgent(), drafting('Yes.')), fourth), 'silent');
  const last = (await decisionsIn(chatId)).at(-1);
  assert.equal(last?.because, 'follow_up_cap');
  assert.equal(last?.exchange_message_id, answerId);
  assert.equal((await agentMessages(chatId)).length, 4);
  assert.equal(await dueIn(chatId), undefined, 'judged, not left for a turn');
});

// ─── Not helpful here ───────────────────────────────────────────────────────

test('anyone in the chat may mark an answer not helpful, once each; nobody else learns it exists', opts, async () => {
  const { chatId } = await channel(triage);
  const { answerId } = await answered(chatId);

  const as = (actorId: string | null, workspaceId = wsp) =>
    async () => actorId ? { actorId, workspaceId, orgId: org, workosUserId: null } : null;
  const press = async (who: () => Promise<unknown>, messageId = answerId) => {
    const app = Fastify();
    await app.register(ambientRoutes({ db, caller: who as never }));
    const response = await app.inject({ method: 'POST', url: `/ambient/${messageId}/dismiss` });
    await app.close();
    return response.statusCode;
  };
  const feedback = async () => (await db.selectFrom('agent_feedback').select(['actor_id', 'kind', 'created_at'])
    .where('message_id', '=', answerId).orderBy('created_at').execute());

  assert.equal(await press(as(null)), 401);
  assert.equal(await press(as(alice, ulid('wsp'))), 404, 'another workspace');
  assert.equal(await press(as(alice), ulid('msg')), 404, 'not an ambient answer');
  assert.deepEqual(await feedback(), []);

  assert.equal(await press(as(bob)), 200);
  const [first] = await feedback();
  assert.equal(first?.actor_id, bob);
  assert.equal(first?.kind, 'not_helpful');
  assert.equal(await press(as(bob)), 200);
  assert.deepEqual((await feedback())[0], first, 'counted once per person: the first press is kept');
  assert.equal(await press(as(alice)), 200);
  assert.deepEqual((await feedback()).map(row => row.actor_id), [bob, alice], 'each person counts');
});

test('marking an answer not helpful changes nothing about when the agent answers', opts, async () => {
  const { chatId } = await channel(triage);
  const { answerId } = await answered(chatId);
  for (const who of [alice, bob]) {
    await db.insertInto('agent_feedback').values({ message_id: answerId, actor_id: who, kind: 'not_helpful' }).execute();
  }
  await speak(chatId, bob, 'and why is the index rebuild slow too?');
  const follow = await followUpIn(chatId);
  assert.ok(follow);
  await look(deps(stubJev({ follow_up: () => ({ to_agent: noul(0.1), to_someone_else: noul(0.1) }) }), drafting('x')), follow);
  const next = await dueIn(chatId);
  assert.ok(next);
  assert.equal(await look(deps(stubJev(passAll(handles.triage)), drafting('Same cause.')), next), 'posted');
});

// ─── Housekeeping ───────────────────────────────────────────────────────────

test('a claim past its lease is swept to stale, and the turn is not retried', opts, async () => {
  const { chatId } = await channel(triage);
  await db.insertInto('ambient_decisions').values({
    id: ulid('amb'), workspace_id: wsp, chat_id: chatId, kind: 'ambient', from_ord: 1, through_ord: 1,
    lease_until: sql`now() - interval '1 minute'`,
  } as never).execute();
  assert.ok(await sweepStale(db) >= 1);
  const [row] = await decisionsIn(chatId);
  assert.equal(row?.outcome, 'stale');
  assert.equal(row?.because, 'lease_expired');
});

// ─── The runtime ────────────────────────────────────────────────────────────

const RUNTIME_ENV = env as unknown as { agentRuntimeUrl: string | null; agentS2sKey: string | null };

test('a completed run is a draft; anything else is not', async () => {
  const restore = { url: RUNTIME_ENV.agentRuntimeUrl, key: RUNTIME_ENV.agentS2sKey };
  let status: 'completed' | 'failed' = 'completed';
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const { runId } = JSON.parse(raw) as { runId: string };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const result = { runId, status, text: status === 'completed' ? 'Partitions.' : '', toolCalls: [],
        usage: { input: 1, output: 1, cacheRead: 0 }, turns: 1, provider: 'test', durationMs: 1,
        ...(status === 'failed' ? { error: 'boom' } : {}) };
      res.end(`event: done\ndata: ${JSON.stringify({ seq: 0, result })}\n\n`);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  RUNTIME_ENV.agentRuntimeUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  RUNTIME_ENV.agentS2sKey = 'test-s2s-key';
  try {
    const request = { runId: ulid('job'), prompt: 'p', systemPrompt: 's', palette: 'none' as const, tools: [] };
    assert.deepEqual(await runtimeDraft(request), { ok: true, text: 'Partitions.' });
    status = 'failed';
    assert.deepEqual(await runtimeDraft(request), { ok: false });
  } finally {
    RUNTIME_ENV.agentRuntimeUrl = restore.url;
    RUNTIME_ENV.agentS2sKey = restore.key;
    await new Promise(resolve => server.close(resolve));
  }
});
