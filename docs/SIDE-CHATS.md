# Side chats in synced rooms

> **Status: public side chats built (steps 1–3); private ones not yet.** Local
> rooms already had side chats. This is the same thing for rooms synced through
> the server.

---

## 1. What this decides

1. **A side chat always starts with people in it.** Whoever creates one picks
   at least one other room member — a person or an agent. A side chat with
   nobody else in it is pointless in a synced room, and it is how rooms fill up
   with empty chats made by mistake.
2. **It is created when the creator confirms, and not before.** Cancelling the
   form leaves nothing behind, on the device or the server.
3. **Public or private is chosen at creation.**
   - **Public:** everyone in the room can see and join it. The people picked
     are named in its first message.
   - **Private:** only the people picked (and the creator) can see it, or know
     it exists.
4. **It opens only for the person who made it.** Everyone else who can see it
   finds it under "In this room" on the new-panel screen. Nobody's tabs move
   because someone else started a conversation.
5. **Creating one needs a connection.** The form says so when offline, rather
   than queuing a chat the server may refuse.
6. **Local rooms are unchanged.** Claude is always in them, so a side chat
   there needs nobody picked.

Not decided here: notifying the people picked (beyond the first message
naming them), adding people to a side chat later, and making a private one
public (PANELS.md §4.3).

---

## 2. The flow

1. On the new-panel screen, the creator chooses **Side chat**. The choice opens
   in place (no dialog), as it does in local rooms today.
2. They pick people and agents from the room's members
   (`useSpaceMembers`, SPACE-MEMBERSHIP-MARKERS.md "Rosters"). Themselves and
   anyone who has left are not offered.
3. They choose public or private, and a name. The name is **pre-filled** from
   the people picked ("Bob, Reviewer") and can be edited; it is what the tab
   and "In this room" show.
4. **Create** is enabled once at least one person is picked. On confirm the
   chat is created on the server, and its tab opens for the creator.

---

## 3. What is stored and sent

- **One request creates everything**, in one transaction: the chat, its panel
  (PANELS.md §4.1), the chat memberships (private only), and a first system
  message naming who it was started with. The client makes the chat, panel and
  message ids, so a retry creates nothing twice.
- **Who hears about it** follows the access rule the server already has
  (DESIGN.md §7): a public chat is announced on the room's stream, to everyone
  in the room; a private one on its own chat stream, to its members only. A
  private chat's existence never reaches anyone outside it.
- **Agents picked into a private chat become members of it**, so a mention
  there can start them — an agent runs only in a chat it may read.
- **The people picked are named, not notified**, in the first message, as
  references (`actor-ref:`) rather than mentions. Notifying them is a later
  decision.

---

## 4. Implementation plan

Each step is usable on its own. Public chats first: they need nothing the
server lacks beyond the create request. **Steps 1–3 are built.**

As built, step 1 announces a public chat's panel as `panel.opened` on the room
stream (PANELS.md §7.1 has the note), and the first row is a new system kind,
`chat.started` (migration `023_side_chats.sql`), subject the creator, with the
people named as `actor-ref:` links. The client waits, briefly, for the panel to
land before opening its tab: a panel id the room does not know is dropped from
the URL.

| Step | What | Where | Done when |
|---|---|---|---|
| 1 | **Create request, public only.** `POST /spaces/:id/chats` — checks `space:create_chat`, that the room is a room, and that everyone picked is in it; idempotent on the chat id; writes chat, panel and first message; announces on the room stream. | `apps/server/src/sync/spaces.ts`, `routes.ts` | Tested against Postgres: created, refused for a non-member, a retry is one chat. |
| 2 | **Client apply.** `chat.created` stores the chat and its panel (today it only invalidates). Chat panels never open by themselves for anyone (`panelArrivals`). | `apps/desktop/src/sync/effects.ts`, `shared/panels.ts` | A second client sees the chat under "In this room", with no tab opened. |
| 3 | **The form.** People picker from `useSpaceMembers`, public/private, pre-filled name, Create; offline and refusal states. Offered in synced rooms as well as local ones. | `renderer/features/panels/PanelContainer.tsx`, a `spaces.createChat` command in `sync/index.ts` | By hand: create a public side chat with one person; it opens for the creator only. |
| 4 | **Private chats on the server.** Chat memberships written at create; the announcement goes on the chat stream; `welcome`, catch-up and the room-join hydration include the private chats a person belongs to, and nothing else. | `spaces.ts`, `feed.ts`, `events.ts` (`ChatCreated.kind` admits `private` on the chat stream only) | A non-member's `welcome` and every stream they read are unchanged by a private chat's creation — asserted, not assumed. |
| 5 | **Private chats on the client.** Private chats stored and listed for their members; a chat's own member list, kept like a room's (`chat_members`, fed by chat membership events). | `sync/effects.ts`, `sync/roster.ts` | By hand: a member sees the chat, a non-member on another client does not. |
| 6 | **Docs.** PANELS.md §7.1/§7.2 and DESIGN.md §7 updated to what was built; the "side chats need the server" note in the new-panel screen removed. | `docs/` | — |

### Agents starting one

`start_side_chat` (`apps/server/src/agents/tools/side-chat.ts`) — "take Bob
into a side chat about the flaky test". Offered in a room's main chat or a
public side chat, public only. It makes the same write the form does, with the
agent as starter and the asker as `on_behalf_of` on the panel; that panel
arrives as a tab for the asker alone (`panelArrivals`, `me`), since the agent
has no screen. The agent then posts the opening message, mentioning the people
so they are told. Ids come from the run and tool call, so a retried call is the
same chat. `room_members` lists a space's people and roles for the agent to pick
from.

Later, and not in this plan: adding people to an existing side chat,
notifying the people picked, and making a private chat public.
