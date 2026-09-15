// A room's shared panels (docs/PANELS.md), against Postgres.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, pool, reachable } from '../db/client.ts';
import { ulid } from '../db/ulid.ts';
import { createChannel, createRoom, addToSpace } from './spaces.ts';
import { openRoomPanel, roomPanels, roomPanelUrl, NotARoomError, PrivateChatError } from './panels.ts';
import { welcome } from './feed.ts';

const up = await reachable();
const opts = up ? {} : { skip: 'postgres not reachable — run `pnpm services`' };

const org = ulid('org');
const wsp = ulid('wsp');
const alice = ulid('act');
const carol = ulid('act');
const agent = ulid('act');

before(async () => {
  if (!up) return;
  await db.insertInto('organizations').values({ id: org, workos_org_id: `test_${org}`, name: 'Panels' }).execute();
  await db.insertInto('workspaces').values({ id: wsp, org_id: org, name: 'Panels', slug: `p-${wsp.slice(-6).toLowerCase()}` }).execute();
  for (const [id, type] of [[alice, 'human'], [carol, 'human'], [agent, 'agent']] as const) {
    await db.insertInto('actors').values({
      id, org_id: org, workspace_id: wsp, type, handle: `p-${id.slice(-6).toLowerCase()}`,
      display_name: type === 'agent' ? 'Triage' : 'Person', avatar_url: null,
      identity_kind: type === 'agent' ? 'system' : 'workos_user', identity_id: type === 'agent' ? null : `wu_${id}`,
      owner_actor_id: type === 'agent' ? alice : null, provisioned_by: 'api', state: 'active',
    }).execute();
    await db.insertInto('memberships').values({ scope_type: 'workspace', scope_id: wsp, actor_id: id, role: 'member' }).execute();
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

const open = (chatId: string, url: string, title: string | null = null) =>
  openRoomPanel(db, { chatId, url, title, createdBy: agent, onBehalfOf: alice });

test('only an https page on a public name may be opened for a whole room', () => {
  assert.deepEqual(roomPanelUrl('https://linear.app/acme/issue/LIN-42'), { ok: true, url: 'https://linear.app/acme/issue/LIN-42' });
  const refused = (raw: string) => { const checked = roomPanelUrl(raw); return checked.ok ? 'ok' : checked.reason; };
  assert.equal(refused('http://linear.app/acme'), 'not_https');
  assert.equal(refused('javascript:alert(1)'), 'not_https');
  assert.equal(refused('file:///etc/passwd'), 'not_https');
  assert.equal(refused('not a url'), 'not_a_url');
  assert.equal(refused('https://localhost:5173'), 'private_address');
  assert.equal(refused('https://127.0.0.1/admin'), 'private_address');
  assert.equal(refused('https://192.168.1.1'), 'private_address');
  assert.equal(refused('https://[::1]/'), 'private_address');
  assert.equal(refused('https://grafana/d/abc'), 'private_address', 'a single-label name is a local network name');
  assert.equal(refused('https://printer.local'), 'private_address');
  assert.equal(refused('https://user:pass@linear.app'), 'credentials');
  assert.equal(refused(`https://linear.app/${'x'.repeat(2100)}`), 'too_long');
});

test('opening a page in a room writes the panel and announces it on the room\'s stream', opts, async () => {
  const room = await createRoom(db, { workspaceId: wsp, name: `r-${ulid('x')}`, createdBy: alice });
  const { panel, event } = await open(room.chatId, 'https://linear.app/acme/issue/LIN-42', 'LIN-42');

  assert.equal(event.type, 'panel.opened');
  assert.deepEqual(event.stream, { kind: 'space', id: room.spaceId });
  assert.deepEqual(event.audience, { kind: 'stream' });
  assert.equal(panel.space_id, room.spaceId);
  assert.deepEqual(panel.payload, { url: 'https://linear.app/acme/issue/LIN-42' });
  assert.equal(panel.title, 'LIN-42');
  assert.equal(panel.created_by_actor_id, agent);
  assert.equal(panel.on_behalf_of_actor_id, alice);
  assert.equal(panel.opened_from_chat_id, room.chatId);

  const logged = await db.selectFrom('sync_events').select(['event_type', 'stream_kind', 'stream_id'])
    .where('event_id', '=', event.eventId).executeTakeFirstOrThrow();
  assert.deepEqual(logged, { event_type: 'panel.opened', stream_kind: 'space', stream_id: room.spaceId });
});

test('opening the same page again brings the room\'s panel forward instead of adding a second', opts, async () => {
  const room = await createRoom(db, { workspaceId: wsp, name: `r-${ulid('x')}`, createdBy: alice });
  const first = await open(room.chatId, 'https://grafana.example.com/d/checkout', 'Checkout errors');
  const second = await open(room.chatId, 'https://grafana.example.com/d/checkout', null);

  assert.equal(second.panel.id, first.panel.id);
  assert.ok(second.panel.opened_at > first.panel.opened_at, 'opened again, so it moves forward');
  assert.equal(second.panel.title, 'Checkout errors', 'an open without a title keeps the one it had');
  assert.ok(second.event.rev > first.event.rev, 'and everyone is told again');
  assert.equal((await roomPanels(db, [room.spaceId])).length, 1);
});

test('a channel has no panels, and a private chat cannot announce a page to the room', opts, async () => {
  const channel = await createChannel(db, { workspaceId: wsp, name: `c-${ulid('x')}`, createdBy: alice });
  await assert.rejects(() => open(channel.chatId, 'https://linear.app/acme'), NotARoomError);

  const room = await createRoom(db, { workspaceId: wsp, name: `r-${ulid('x')}`, createdBy: alice });
  const privateChat = ulid('cht');
  await db.insertInto('chats').values({
    id: privateChat, workspace_id: wsp, space_id: room.spaceId, kind: 'private', name: 'side', created_by_actor_id: alice,
  } as never).execute();
  await assert.rejects(() => open(privateChat, 'https://linear.app/acme'), PrivateChatError);
  assert.equal((await roomPanels(db, [room.spaceId])).length, 0);
});

test('welcome carries every joined room\'s panels, most recently opened first', opts, async () => {
  const room = await createRoom(db, { workspaceId: wsp, name: `r-${ulid('x')}`, createdBy: alice });
  const older = await open(room.chatId, 'https://linear.app/acme/issue/LIN-1', 'LIN-1');
  const newer = await open(room.chatId, 'https://linear.app/acme/issue/LIN-2', 'LIN-2');

  const payload = await welcome(db, wsp, alice);
  const mine = payload.panels.filter(panel => panel.space_id === room.spaceId).map(panel => panel.id);
  assert.deepEqual(mine, [newer.panel.id, older.panel.id]);

  const outsider = await welcome(db, wsp, carol);
  assert.equal(outsider.panels.some(panel => panel.space_id === room.spaceId), false, 'not a member, so none of its panels');
});

test('someone added to the room receives its open panels with the room itself', opts, async () => {
  const room = await createRoom(db, { workspaceId: wsp, name: `r-${ulid('x')}`, createdBy: alice });
  const { panel } = await open(room.chatId, 'https://docs.google.com/document/d/rca', 'RCA doc');

  const added = await addToSpace(db, room.spaceId, carol, alice, ulid('msg'));
  assert.equal(added.status, 'added');
  const memberAdded = await db.selectFrom('sync_events').select('payload')
    .where('stream_kind', '=', 'space').where('stream_id', '=', room.spaceId)
    .where('event_type', '=', 'space.member_added')
    .orderBy('stream_rev', 'desc').executeTakeFirstOrThrow();
  const hydration = (memberAdded.payload as { actor_id: string; hydration: { panels?: { id: string }[] } });
  assert.equal(hydration.actor_id, carol);
  assert.deepEqual(hydration.hydration.panels?.map(p => p.id), [panel.id]);
});
