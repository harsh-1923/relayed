// What ingestion may read, against Postgres (docs/MEMORY.md §5.4, §6.1).
//
// The assertions that matter here are all REFUSALS. Whether an episode is cut
// correctly is `episode.test.ts`; this is about what never reaches it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, pool, reachable } from '../db/client.ts';
import { ulid } from '../db/ulid.ts';
import { ROOMKEEPER_HANDLE } from '../provisioning/system-agents.ts';
import { dueChats, claimChat, episodeFor, advanceWatermark, entryFor, type DueChat } from './ingest.ts';
import { firstEpisode } from './episode.ts';
import { bankForSpace, workspaceBank } from './banks.ts';

const up = await reachable();
const opts = up ? {} : { skip: 'postgres not reachable — run `pnpm services`' };

const org = ulid('org');
const workspace = ulid('wsp');
const keeper = ulid('act');     // Relay Roomkeeping — the memory writer
const alice = ulid('act');
const bob = ulid('act');

const watched = ulid('spc');    // a room Roomkeeping is in
const unwatched = ulid('spc');  // a room it is NOT in
const dormant = ulid('spc');    // a room it is in, but not active

const watchedDefault = ulid('cht');
const watchedPrivate = ulid('cht');
const unwatchedDefault = ulid('cht');
const dormantDefault = ulid('cht');

const actor = (id: string, handle: string, type: 'human' | 'agent', system = false) =>
  db.insertInto('actors').values({
    id, org_id: org, workspace_id: workspace, type, handle, display_name: handle,
    avatar_url: null, identity_kind: system ? 'system' : 'workos_user',
    identity_id: system ? null : `wu_${id}`, owner_actor_id: null,
    provisioned_by: system ? 'system' : 'api', state: 'active',
  }).execute();

const room = (id: string, lifecycle: 'active' | 'dormant') =>
  db.insertInto('spaces').values({
    id, org_id: org, workspace_id: workspace, kind: 'room', name: `room-${id.slice(-4)}`,
    slug: null, topic: null, visibility: 'private', membership_policy: 'invite',
    created_by_actor_id: alice, lifecycle,
  }).execute();

const chat = (id: string, spaceId: string, kind: 'default' | 'private' | 'public') =>
  db.insertInto('chats')
    .values({ id, workspace_id: workspace, space_id: spaceId, kind, name: kind === 'private' ? 'hush' : null })
    .execute();

let ord = 0;
const say = (chatId: string, body: string, author = alice, visibleToActors: string[] | null = null) =>
  db.insertInto('messages').values({
    id: ulid('msg'), chat_id: chatId, parent_id: null, ord: ++ord, rev: ord,
    author_id: author, body, visible_to: visibleToActors, deleted: false,
    on_behalf_of_actor_id: null, delegation_id: null,
  }).execute();

before(async () => {
  if (!up) return;
  await db.insertInto('organizations')
    .values({ id: org, workos_org_id: `test_${org}`, name: 'Memory' }).execute();
  await db.insertInto('workspaces')
    .values({ id: workspace, org_id: org, name: 'Memory', slug: `i-${workspace.slice(-8).toLowerCase()}` })
    .execute();

  await actor(keeper, ROOMKEEPER_HANDLE, 'agent', true);
  await actor(alice, `a-${alice.slice(-6).toLowerCase()}`, 'human');
  await actor(bob, `b-${bob.slice(-6).toLowerCase()}`, 'human');

  await room(watched, 'active');
  await room(unwatched, 'active');
  await room(dormant, 'dormant');
  await chat(watchedDefault, watched, 'default');
  await chat(watchedPrivate, watched, 'private');
  await chat(unwatchedDefault, unwatched, 'default');
  await chat(dormantDefault, dormant, 'default');

  // Roomkeeping is in two of the three rooms, and in neither private chat.
  for (const space of [watched, dormant]) {
    await db.insertInto('memberships')
      .values({ scope_type: 'space', scope_id: space, actor_id: keeper, role: 'member' }).execute();
  }

  for (const target of [watchedDefault, watchedPrivate, unwatchedDefault, dormantDefault]) {
    await say(target, 'the index rebuild will not finish before the window');
  }
});

after(async () => {
  // Messages first: `messages.author_id` restricts, so the actors cannot go
  // while anything they wrote is still there.
  if (up) {
    await sql`DELETE FROM messages WHERE chat_id IN
                (SELECT id FROM chats WHERE workspace_id = ${workspace})`.execute(db);
    await sql`DELETE FROM organizations WHERE id = ${org}`.execute(db);
  }
  await pool.end();
});

const due = async (): Promise<DueChat[]> =>
  (await dueChats(db, 50)).filter((row) => row.workspaceId === workspace);

test('a chat in a room the writer is in is due', opts, async () => {
  const chats = await due();
  assert.ok(chats.some((row) => row.chatId === watchedDefault));
});

test('a room the writer is NOT in is never due — no reader, no memory', opts, async () => {
  // Rule 1, and the reason there is no second rule about what may be read: the
  // writer's membership IS the privacy boundary.
  const chats = await due();
  assert.ok(!chats.some((row) => row.chatId === unwatchedDefault));
});

test('a room’s PRIVATE chat is never due, even though the writer is in the room', opts, async () => {
  // It reads the room's memory and contributes nothing to it: the room's
  // default chat could otherwise recall it, and its members are not in here.
  const chats = await due();
  assert.ok(!chats.some((row) => row.chatId === watchedPrivate));
});

test('a dormant room is not due — it keeps what it has and accrues nothing', opts, async () => {
  const chats = await due();
  assert.ok(!chats.some((row) => row.chatId === dormantDefault));
});

test('the writer actor on a due chat is Roomkeeping, not the author', opts, async () => {
  const row = (await due()).find((candidate) => candidate.chatId === watchedDefault);
  assert.equal(row?.writerActorId, keeper);
});

test('two servers cannot claim one chat', opts, async () => {
  const row = (await due()).find((candidate) => candidate.chatId === watchedDefault)!;
  assert.equal(await claimChat(db, row), true);
  assert.equal(await claimChat(db, row), false, 'the second claim took a held lease');
});

test('a claimed chat is not offered again', opts, async () => {
  assert.ok(!(await due()).some((row) => row.chatId === watchedDefault));
});

test('advancing the watermark releases the lease and clears the failures', opts, async () => {
  await advanceWatermark(db, watchedDefault, 1);
  const row = await db.selectFrom('memory_watermarks').selectAll()
    .where('chat_id', '=', watchedDefault).executeTakeFirstOrThrow();
  assert.equal(row.ingested_through_ord, 1);
  assert.equal(row.lease_until, null);
  assert.equal(row.failures, 0);
});

// ─── What the episode itself may contain ────────────────────────────────────

const watchedChat = (watermark: number): DueChat => ({
  chatId: watchedDefault, spaceId: watched, workspaceId: workspace,
  spaceName: 'cutover', spaceKind: 'room', workspaceName: 'Memory',
  visibility: 'private', writerActorId: keeper, watermark,
});

test('only messages after the watermark are read', opts, async () => {
  await say(watchedDefault, 'rolling back the rebuild first');
  const episode = await episodeFor(db, watchedChat(1));
  assert.ok(episode.every((message) => message.ord > 1));
  assert.ok(episode.some((message) => message.body.includes('rolling back')));
});

test('a deleted message is never ingested', opts, async () => {
  const doomed = ulid('msg');
  await db.insertInto('messages').values({
    id: doomed, chat_id: watchedDefault, parent_id: null, ord: ++ord, rev: ord,
    author_id: alice, body: 'said and then unsaid', visible_to: null, deleted: true,
    on_behalf_of_actor_id: null, delegation_id: null,
  }).execute();
  const episode = await episodeFor(db, watchedChat(1));
  assert.ok(!episode.some((message) => message.id === doomed));
});

test('a restricted message the writer is not listed on is never ingested', opts, async () => {
  // Narrower than its chat, so it would surface to people it excludes. Decided
  // by the same `visibleTo` every other reader uses, not by a rule here.
  await say(watchedDefault, 'for alice and bob only', alice, [alice, bob]);
  const episode = await episodeFor(db, watchedChat(1));
  assert.ok(!episode.some((message) => message.body.includes('alice and bob only')));
});

test('a restricted message the writer IS listed on is ingested', opts, async () => {
  await say(watchedDefault, 'visible to the keeper too', alice, [alice, keeper]);
  const episode = await episodeFor(db, watchedChat(1));
  assert.ok(episode.some((message) => message.body.includes('visible to the keeper')));
});

test('an episode read carries the author’s handle and type for labelling', opts, async () => {
  const episode = await episodeFor(db, watchedChat(1));
  assert.ok(episode.every((message) => message.authorHandle.length > 0));
  assert.ok(episode.every((message) => ['human', 'agent'].includes(message.authorType)));
});

test('two conversations separated by a long gap go as two episodes, not one', opts, async () => {
  // The case that decides the cutting rule: a chat that talked in the morning
  // and again in the afternoon has had two conversations, and merging them
  // would ask extraction to relate things that have no relation. They go as
  // separate retains — in the same pass, rather than a tick apart.
  // A `public` chat, not a second `default` one: a room has exactly one of
  // those and `chat_singleton` enforces it (DESIGN.md §7.2).
  const chatId = ulid('cht');
  await db.insertInto('chats')
    .values({ id: chatId, workspace_id: workspace, space_id: watched, kind: 'public', name: 'two-talks' })
    .execute();

  const morning = Date.parse('2026-09-15T09:00:00Z');
  const afternoon = Date.parse('2026-09-15T14:00:00Z');
  const lines: [number, string][] = [
    [morning, 'the index rebuild will not finish before the window'],
    [morning + 120_000, 'then we roll it back first and retry after'],
    [afternoon, 'found why the rebuild is slow — stale statistics table'],
    [afternoon + 120_000, 'the nightly job exits 0 on a lock timeout'],
  ];
  for (const [at, body] of lines) {
    // Raw, because `created_at` is a Generated column: the point of this test
    // is messages that arrived hours apart, which a default cannot express.
    await sql`INSERT INTO messages (id, chat_id, parent_id, ord, rev, author_id, body,
                                    visible_to, deleted, created_at)
              VALUES (${ulid('msg')}, ${chatId}, NULL, ${++ord}, ${ord}, ${alice}, ${body},
                      NULL, false, ${new Date(at).toISOString()})`.execute(db);
  }

  const due: DueChat = {
    chatId, spaceId: watched, workspaceId: workspace, spaceName: 'cutover', spaceKind: 'room',
    workspaceName: 'Memory',
    visibility: 'private', writerActorId: keeper, watermark: 0,
  };

  const first = firstEpisode(await episodeFor(db, due));
  assert.equal(first.length, 2, 'the morning conversation alone');
  assert.match(first[0]!.body, /index rebuild/);

  // What the next iteration of the pass sees, once the watermark has moved.
  const second = firstEpisode(await episodeFor(db, { ...due, watermark: first.at(-1)!.ord }));
  assert.equal(second.length, 2, 'the afternoon conversation alone');
  assert.match(second[0]!.body, /stale statistics/);
});

test('a system message is never ingested — it is bookkeeping, not conversation', opts, async () => {
  // "Alice was added by Bob" is the server recording its own command. Found by
  // reading a real recall, where one of these ranked first.
  // `message_kind_shape` requires a subject on a system row — the marker is
  // about somebody, which is what makes it bookkeeping rather than speech.
  await sql`INSERT INTO messages (id, chat_id, parent_id, ord, rev, author_id, body,
                                  visible_to, deleted, message_kind, system_kind, subject_actor_id)
            VALUES (${ulid('msg')}, ${watchedDefault}, NULL, ${++ord}, ${ord}, ${alice},
                    'Bob was added by Alice', NULL, false, 'system', 'space.member_added', ${bob})`.execute(db);
  const episode = await episodeFor(db, watchedChat(1));
  assert.ok(!episode.some((message) => message.body.includes('was added by')));
});

test('a public channel with the writer in it is due, and routes to the workspace bank', opts, async () => {
  // The mechanism is not room-specific — `dueChats` asks about the WRITER'S
  // MEMBERSHIP and the chat's kind, never the space's kind. What keeps channels
  // out today is provisioning: Roomkeeping is added to rooms and not to
  // channels, which is Rule 1 working rather than a gap in this query.
  const channel = ulid('spc');
  const sole = ulid('cht');
  await db.insertInto('spaces').values({
    id: channel, org_id: org, workspace_id: workspace, kind: 'channel', name: 'eng',
    slug: `eng-${channel.slice(-6).toLowerCase()}`, topic: null, visibility: 'public',
    membership_policy: 'open', created_by_actor_id: alice,
  }).execute();
  await db.insertInto('chats')
    .values({ id: sole, workspace_id: workspace, space_id: channel, kind: 'sole', name: null })
    .execute();
  await db.insertInto('memberships')
    .values({ scope_type: 'space', scope_id: channel, actor_id: keeper, role: 'member' }).execute();
  await say(sole, 'the checkout 500s trace back to a stale statistics table');

  const found = (await due()).find((row) => row.chatId === sole);
  assert.ok(found, 'a public channel with the writer in it is due');
  assert.equal(found?.visibility, 'public');
  // Public means the workspace bank, which is what makes it recallable from
  // every other space in the workspace (§5.2).
  assert.equal(bankForSpace({ id: channel, workspaceId: workspace, visibility: found!.visibility }),
               workspaceBank(workspace));
});

test('the shared bank is named for the WORKSPACE, not for the room that last wrote to it', opts, async () => {
  // `ensureBank` applies the name on every ingest, so passing the space name
  // unconditionally renamed the shared bank after whichever public room went
  // last — which showed one room's name over facts from several in the
  // Hindsight console, and told extraction the bank belonged to a room.
  const channel = ulid('spc');
  const sole = ulid('cht');
  await db.insertInto('spaces').values({
    id: channel, org_id: org, workspace_id: workspace, kind: 'channel', name: 'launch',
    slug: `l-${channel.slice(-6).toLowerCase()}`, topic: null, visibility: 'public',
    membership_policy: 'open', created_by_actor_id: alice,
  }).execute();
  await db.insertInto('chats')
    .values({ id: sole, workspace_id: workspace, space_id: channel, kind: 'sole', name: null })
    .execute();
  await db.insertInto('memberships')
    .values({ scope_type: 'space', scope_id: channel, actor_id: keeper, role: 'member' }).execute();
  await say(sole, 'the launch is confirmed for Thursday the 24th');

  const row = (await due()).find((candidate) => candidate.chatId === sole);
  assert.equal(row?.workspaceName, 'Memory', 'the workspace name rides on the row');
  assert.equal(row?.spaceName, 'launch');
});

// ── what an episode becomes on the timeline (§14.3) ─────────────────────────

const someone = (id: string, name: string, ord: number, at: string) => ({
  id: `msg_${ord}`, ord, rev: ord, body: 'said something', createdAt: new Date(at),
  authorId: id, authorDisplayName: name, authorHandle: name.toLowerCase(), authorType: 'human',
});

const place: DueChat = {
  chatId: 'cht_x', spaceId: 'spc_x', workspaceId: 'wsp_x', spaceName: '#db-cutover', spaceKind: 'room',
  workspaceName: 'Acme', visibility: 'private', writerActorId: 'act_keeper', watermark: 0,
};

test('an entry is stamped with the MESSAGES\' time and anchored to where the conversation starts', () => {
  // Never the ingest time: ingestion is allowed to lag, and a timeline that
  // reorders itself after a backfill is not a timeline.
  const entry = entryFor(place, [
    someone('act_a', 'Alice', 14, '2026-09-18T14:31:00Z'),
    someone('act_b', 'Bob', 15, '2026-09-18T14:49:00Z'),
  ], [{ text: 'Rolled back first', message_id: null, kind: null }],
    { title: 'Rollback before retry', summary: 'They rolled back.' });

  assert.equal(entry.occurredStart.toISOString(), '2026-09-18T14:31:00.000Z');
  assert.equal(entry.occurredEnd.toISOString(), '2026-09-18T14:49:00.000Z');
  assert.equal(entry.anchorMessageId, 'msg_14', 'the first message, so a click needs no lookup');
  assert.equal(entry.ordStart, 14);
  assert.equal(entry.ordEnd, 15);
});

test('participants are each person once, in the order they spoke', () => {
  const entry = entryFor(place, [
    someone('act_b', 'Bob', 1, '2026-09-18T10:00:00Z'),
    someone('act_a', 'Alice', 2, '2026-09-18T10:01:00Z'),
    someone('act_b', 'Bob', 3, '2026-09-18T10:02:00Z'),
  ], [{ text: 'a fact', message_id: null, kind: null }], { title: 'T', summary: 'S' });

  assert.deepEqual(entry.participants, ['act_b', 'act_a'], 'the faces, not a message count');
});

test('significance is how much was established, and nothing pretends otherwise', () => {
  // §14.5 ranks on fact kind first — but nothing classifies a fact, and recall
  // hits need the pipeline to have been used. Breadth is what is honest today.
  const facts = [1, 2, 3].map(n => ({ text: `fact ${n}`, message_id: null, kind: null }));
  const entry = entryFor(place, [someone('act_a', 'Alice', 1, '2026-09-18T10:00:00Z')],
    facts, { title: 'T', summary: 'S' });
  assert.equal(entry.significance, 3);
  assert.equal(entry.facts.length, 3);
});

test('a fact carries no per-message anchor, because there is no such thing', () => {
  // Hindsight extracts from a conversation, not from a line of it. The jump
  // target is the entry's own anchor; a per-fact id would claim a precision
  // nothing has.
  const entry = entryFor(place, [someone('act_a', 'Alice', 1, '2026-09-18T10:00:00Z')],
    [{ text: 'a fact', message_id: null, kind: null }], { title: 'T', summary: 'S' });
  assert.equal(entry.facts[0]?.message_id, null);
  assert.ok(entry.anchorMessageId);
});
