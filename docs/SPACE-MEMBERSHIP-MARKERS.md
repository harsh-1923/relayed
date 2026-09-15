# Space membership additions and chat markers

> **Status: built, 2026-09-14.** Everything this document specifies is
> implemented and tested — server (`apps/server/src/sync/spaces.ts`,
> `ops.ts`, `events.ts`, `routes.ts`, `feed.ts`, migration
> `014_space_member_markers.sql`) and desktop client (`apps/desktop/src/sync/
> effects.ts`, `link.ts`, `index.ts`, `storage.ts`, migration
> `workspace.ts` v13, and the renderer's `SystemMarker.tsx`/`ChatView.tsx`).
> Its decisions are folded into `DESIGN.md` §8.1a and §12, `AUTHZ.md`'s
> `add_member` section, `SYNC-FLOWS.md` §16.2, and `FRONTEND.md` §5.4. The
> sections below are kept as the record of *why*, updated from "will" to "is"
> where a claim was verified rather than rewritten wholesale — the plan and the
> build agreed closely enough that the reasoning did not need to change, only
> its tense.
>
> One deliberate deviation from the plan below: the SQLite replica's migration
> does **not** carry the matching three-way CHECK constraint the server's does.
> `ALTER TABLE ADD COLUMN` cannot express a multi-column CHECK in SQLite
> without a table rebuild, and the replica only ever receives a `system` row
> from a trusted `message.created` event — never from a local insert — so
> there is no adversarial-input path there to guard against.

## The outcome

When Bob adds Alice to a channel or room, its structural chat gains a durable
system message:

> Alice was added by Bob

The message renders with the existing shadcn `Marker`, not as Bob's speech
bubble. It is ordered with the chat, available offline, retained and backfilled
like other messages, and visible to Alice as well as the members who were
already there.

This must be a real chat message rather than a renderer projection of
`space.member_added`. A space event has a space revision but no chat ordinal;
synthesising a row from it would give different clients different chat order
and would bypass the message retention, backfill, and read-cursor machinery.
The design-of-record distinction remains intact: the **space is the permission
unit**, while the **chat is the ordered sync unit** (`DESIGN.md`, the universal
message container and two-counter model).

## Product rules

| Situation | Behaviour |
|---|---|
| Bob adds Alice to a channel | Add Alice and append the marker to the channel's `sole` chat |
| Bob adds Alice to a room | Add Alice and append the marker to the room's `default` chat; do not copy it into side chats |
| Bob adds an agent | Use the same actor-neutral wording and marker; agents and people are peers here |
| Alice is already an active member | Return `already_member`; write no membership event and no marker |
| Alice left and is later re-added | Restore her as `member` and append a new marker for the new addition |
| Alice joins an open space herself | A separate product event should say “Alice joined”; do not render “Alice was added by Alice” |
| A member tries to add someone to a DM or group DM | Refuse it. These spaces are `sealed`; adding a participant creates a new conversation rather than mutating the old one |
| Alice or Bob is later renamed | A current client resolves the stored actor ids to current display names; the stored body remains the readable historical fallback |
| An actor is deactivated | The actor tombstone keeps the name available, so historical markers remain intelligible |

The marker is history, not authored conversation content:

- it creates no unread count or mention count;
- it does not start an agent run;
- it cannot be edited, deleted, replied to, reacted to, or copied as a normal
  message;
- it does not bump the space activity clock or move the space to the top of the
  sidebar;
- it has no sender avatar, speech bubble, footer, or message-group relationship;
- it may expose its timestamp accessibly or in a tooltip, without adding a
  permanent footer.

The initiating actor still matters. Bob's actor id is durable attribution for
authorization history and display, even though Bob did not author a sentence.

## Authorization remains unchanged

The system message records a successful decision; it does not create a new
permission path.

- Any active member of the space may add another actor. This openness is
  deliberate and differs from removal, promotion, and making a space public.
- A workspace administrator who is not a member of the space cannot add someone
  to it.
- The target must be an active actor with active membership in the same
  workspace.
- Adding always grants `member`. Restoring an old administrator does not restore
  the old role; promotion remains a separate space-admin action.
- The target check happens only after the caller passes the space permission
  check, so an inaccessible space cannot be used to probe actor ids.
- A `sealed` membership policy overrides the ordinary add action for DMs and
  group DMs.

The first five rules are already represented in `AUTHZ.md` and the shared
evaluator. The sealed-space refusal is recorded in `DESIGN.md` but is not
currently enforced by the add-member command.

## Proposed message contract

System messages need a first-class discriminator. A body string or a message
part alone is insufficient: the server must be able to forbid ordinary message
mutations, unread queries must distinguish the row, and the renderer must select
the marker without inferring semantics from English text.

```ts
interface SpaceMemberAddedMessage {
  kind: 'system';
  systemKind: 'space.member_added';
  authorId: string;       // Bob: the initiating actor
  subjectActorId: string; // Alice: the actor added
  body: string;           // “Alice was added by Bob”, for older clients
}
```

The database representation should be explicit and constrained:

```sql
message_kind    TEXT NOT NULL DEFAULT 'actor',
system_kind     TEXT,
subject_actor_id TEXT REFERENCES actors(id) ON DELETE RESTRICT,

CHECK (message_kind IN ('actor', 'system')),
CHECK (
  (message_kind = 'actor' AND system_kind IS NULL AND subject_actor_id IS NULL)
  OR
  (message_kind = 'system'
    AND system_kind IN ('space.member_added')
    AND subject_actor_id IS NOT NULL)
)
```

Each new constraint needs a real-engine test for accepted and rejected rows.
The replica needs the equivalent SQLite constraints. The server migration is
the next migration after `013_connections.sql`; the replica migration follows
`message-parts` version 12.

`author_id` remains Bob for the first version. Its meaning for a system row is
“the actor whose successful command caused this entry,” not “the actor who
typed this body.” This avoids inventing a privileged Relayed actor and preserves
the rule that actor references point at real Layer 2 actors. The renderer must
not use this field to select a speech-bubble layout when `message_kind` is
`system`.

The stored body is a compatibility rendering, captured at write time. New
clients render current names from `author_id` and `subject_actor_id`; clients
that predate system messages permissively ignore the new fields and show the
body. Their degraded presentation is a normal bubble, but the text remains true
and the client does not stall.

## The write must be one transaction

The successful add has three durable effects:

1. create or restore Alice's space membership as `member`;
2. append `space.member_added` to the space stream;
3. append the system `message.created` to the structural chat stream, allocating
   its chat ordinal and revision.

All three must commit together or none may commit. A marker without membership
is false; membership without a marker violates the product promise; a message
row without its event is permanently absent from replicas.

**A room an agent creates for someone** (`WORKSPACE-AGENTS.md` §5.5,
`create_room`) adds that person the same way, inside the creating transaction:
the agent founds the room, then the person is added as `admin` by the agent,
with the same event and the same marker ("Alice was added by Triage"). No
client-generated id exists there, so the server mints the marker's id.

The route supplies a client-generated marker message id, preserving the
client-generated message-id invariant even though the content is generated by
the system. The domain operation returns both appended events. The HTTPS route
delivers both only after the transaction commits.

There is deliberately no global ordering between the space and chat streams.
The membership row is already committed when either event is delivered, so
fanout authorizes Alice correctly. The marker's position is determined only by
its chat ordinal, which is the one order the timeline needs.

## Issues the implementation fixes

Each of these was a real defect in the add-member flow as it stood before this
work; each is now fixed, at the file/function named in its **Fix** — kept
below as the record of the defect and the reasoning behind its fix, not as
outstanding work.

### Repeated adds produce false events

`addMember` currently uses an upsert and always appends `space.member_added`,
even when the row was already active. That was visually harmless while the
event did not render, but it would make every repeated click claim that Alice
was added again and would reset `joined_at`.

**Fix:** lock or inspect the membership row inside the transaction. If it is
already active, return an `already_member` domain result without changing the
row, allocating a space revision, allocating a chat ordinal, or delivering an
event. A tombstoned row is a real re-add and follows the full path.

### Sealed conversations can currently be mutated

The design makes DMs and group DMs `sealed`, because adding a third participant
must create a new conversation. The current `addToSpace` path checks the
caller's `add_member` action but not `spaces.membership_policy`.

**Fix:** make an addable-space check part of the authoritative domain operation
and return a stable `sealed_space` refusal. Hide the add control for DMs and
group DMs as an affordance, but rely on the server refusal for enforcement.

### A newly added online actor may not see the space immediately

The target joins the fanout audience after the transaction commits and can
receive `space.member_added`, but the replica currently treats space topology
events as invalidations. It does not apply a new space, its chats, or the
target's own membership from that event. The complete rows arrive in `welcome`,
so reconnect repairs the state, but requiring reconnect is not acceptable for
an interactive add flow.

**Fix:** make the successful membership event sufficient to hydrate its target.
Include the space row and all chats the new member may initially know (`sole` or
`default`, plus public room chats) in `space.member_added`. When the named actor
is the active replica actor, apply those rows and their own membership in one
SQLite transaction before invalidating the space list. Existing members use the
same event only as topology invalidation and must not start storing everybody's
membership rows. This preserves the intentional caller-only membership
projection.

The system message may arrive before or after that space event. Applying it is
safe because the replica deliberately permits a message to precede its
directory row; the new hydration handler must make the space and chat visible
as soon as the membership event is applied.

### System messages would currently create unread badges

Unread queries count every undeleted message after the read cursor whose
`author_id` differs from the reader. Alice and every existing member other than
Bob would therefore receive an unread badge for administrative activity.

**Fix:** add `message_kind = 'actor'` to both unread-count implementations in
`sync/feed.ts`: the one-chat counter and the batched `welcome` calculation.
Mention counts receive the same filter. Keep the system message's ordinal: it
still occupies a stable place in history, while the authoritative counters
decide that it is not unread.

### Ordinary message actions could mutate the marker

If Bob remains `author_id`, the existing own-message checks could otherwise let
him edit or delete the marker. Replies and reactions would also make a system
event look like authored content.

**Fix:** every edit, delete, reply, and reaction path rejects a target whose
`message_kind` is not `actor`. The renderer exposes none of those controls for a
system row. These are server rules first and UI rules second.

### The space event does not identify who performed the add

`SpaceMemberAdded` currently contains only `actor_id` and `role`. That is enough
to describe membership topology, but not enough to explain it or audit the
initiator.

**Fix:** add `by_actor_id` to the space-event payload. It is not the source for
the chat marker—the message row is—but it makes the topology event complete and
keeps future membership surfaces from guessing. The field is additive, so old
clients ignore it and still advance their cursors.

### The candidate picker cannot exclude current members

Replicas intentionally hold only the active actor's grants, not every other
space membership. The picker therefore cannot authoritatively remove actors who
already belong to the space without adding a network read to a renderer
surface, which is forbidden.

**Fix now:** keep the local directory picker and make `already_member` a clean,
non-error answer. Do not create a false marker.

**Fix when a roster is built:** add an explicit local projection for the open
space's member roster, populated through sync or an online command whose result
is written into the replica by the sync process. The renderer still reads only
SQLite. Do not broaden `welcome` to every workspace membership; that has the
members-by-spaces shape the existing design rejects.

## Server implementation

`apps/server/src/sync/spaces.ts`

- Load the space policy and structural chat while checking the caller.
- Reject `sealed` spaces.
- Validate that the target is an active actor in the same workspace.
- In one transaction, distinguish active membership from a tombstone, restore
  or insert only when needed, append the space event with `by_actor_id`, and
  write the system message through the one message writer.
- Extend the message writer with a discriminated actor/system input rather than
  creating a second unconstrained insertion path.
- For a system input, skip authored-part validation, mentions, parent ids, and
  the space activity-clock update.

`apps/server/src/sync/routes.ts`

- Accept `actor_id` and a client-generated `message_id`.
- Return success for an addition and `already_member` for the idempotent no-op.
- Map `sealed_space`, unavailable actor, and authorization refusals to stable
  field/action answers.
- Deliver the space and chat events after commit.

`apps/server/src/sync/events.ts` and `apps/server/src/sync/feed.ts`

- Extend `MessageCreated` and every `MessageRow` used by catch-up/backfill with
  `message_kind`, `system_kind`, and `subject_actor_id`.
- Extend `SpaceMemberAdded` with `by_actor_id` and the target-hydration snapshot.
- Keep all additions optional at inbound parse boundaries for old-client
  compatibility; the new server writer produces the complete shape.
- Exclude system rows from unread and mention counts.

## Client implementation

Replica schema and application:

- Add the constrained system-message columns to the workspace database.
- Store the new fields from live events, gap snapshots, and backfill pages.
- Preserve them during upsert and repair; a complete row must replace complete
  current state.
- Apply the target hydration carried by `space.member_added` only when the
  event's `actor_id` is the active actor.
- Add the fields to `ReplicaMessage` and the message query.

Renderer:

- Branch on `message.kind` in `ChatView` before sender grouping.
- Render a `SystemMessage` as a direct `MessageScrollerContent` child so the
  scroller retains anchoring and message addressing.
- Use `Marker`, `MarkerIcon`, and `MarkerContent` from
  `renderer/components/ui/marker.tsx`, preferably the centered `separator`
  variant with the shared `UserPlus` icon.
- Resolve the subject and initiator locally by actor id. Fall back to the stored
  body if either directory row is not available yet.
- Exclude system rows when calculating `startsGroup`, `endsGroup`, and `mine`;
  markers break actor-message groups on both sides.

The add-member UI generates the marker message id with the existing id helper
and sends it with the HTTPS command. It continues to disable itself while the
command is pending and closes on either `added` or `already_member`.

## Verification

### Database and domain

- Each new Postgres and SQLite constraint accepts every intended system/actor
  shape and rejects each invalid null or discriminator combination.
- Adding an active workspace actor creates one membership event and one system
  message in the structural chat.
- The membership row and both event rows roll back together on an injected
  failure.
- Repeating an active add changes no row, counter, revision, ordinal, or
  `joined_at` value.
- Re-adding a tombstoned former admin restores `member` and creates one new
  marker.
- A sealed DM or group DM is refused without any write.
- An unavailable or cross-workspace actor is refused without revealing which
  target condition failed.

### Sync and compatibility

- Live delivery, catch-up, gap snapshots, and backfill reproduce the same
  system row.
- A newly added online actor receives enough topology to display the space and
  marker without reconnecting.
- An old permissive client ignores the new fields, advances both stream
  frontiers, and displays the fallback body rather than disconnecting.
- Out-of-order space and chat event delivery converges to the same replica.
- Retention and eviction treat the marker as an ordinary ordered row.

### Product behaviour

- System rows do not change unread, thread-unread, or mention counts.
- They do not start an agent run or bump the space activity clock.
- Edit, delete, reply, and reaction attempts are refused by the server.
- Marker layout works in light and dark themes, with long names, an agent
  subject, missing directory rows, keyboard navigation, and a screen reader.
- In a two-client run, Bob adds Alice; Bob and Alice each see exactly one marker
  in the structural chat, and Alice sees the space without restarting.

The authorization, sync, visibility, server, desktop, typecheck, production
build, and boundary suites all remain required. The multi-client check is part
of completion because the defining behaviour crosses two actors and two
streams.

## Observability

No new telemetry marker is proposed initially. The existing sync event and
fanout traces already answer whether the space event and chat message were
committed and delivered, and the domain tests answer the atomicity and duplicate
questions. Adding a dedicated metric would cost another signal without an
operational question that existing traces cannot answer.

If production traces cannot distinguish a partially delivered two-event result,
propose one bounded outcome on the add-member command before implementing it;
do not use actor, space, chat, or message ids as metric labels, and never include
the fallback body in telemetry.

## Documentation changes — done

- `DESIGN.md` §8.1a: system messages in the message model, alongside the
  two-counter model they ride; §12 records the unread/mention exclusion.
- `AUTHZ.md`: the sealed-policy precondition recorded beside `add_member`; the
  actor-role matrix itself is unchanged, as planned.
- `SYNC-FLOWS.md` §16.2: the atomic membership-plus-chat-message write, its two
  delivered events, recipient hydration, and the idempotent no-op — §16.2a
  keeps the former-member re-add case that was already there.
- `FRONTEND.md` §5.4: the `kind`-branch ahead of sender grouping and local
  actor-name resolution, as a bullet beside the message list's other
  pre-conditions.
- This document: status changed from proposal to built, above.

The one planned invariant-set addition not made: `DESIGN.md` §14's numbered
invariant list was left alone rather than inserting a new number into it,
since every invariant it would have stated (the atomic write, the version rule
covering a system row, the unread exclusion) is already stated in prose in
§8.1a and §12 above it. If a future pass renumbers or extends §14 directly,
folding these in then costs nothing extra.
