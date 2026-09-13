# Rich message composer

**Status: first vertical slice implemented.** The chat route now uses Tiptap,
canonical Markdown bodies, formatting controls, one suggestion surface for `@`
and `/`, semantic mention atoms, local SQLite drafts, and atomic draft consumption
on send. Reply/edit drafts, attachments, link editing and server-side mention
effects remain later work.

The editor is replaceable; the Markdown body and its Relayed extensions are the
contract.

## Decisions

| Question | Decision |
|---|---|
| Editing engine | Tiptap 3 |
| Durable authored format | `messages.body`, containing canonical Relayed Markdown |
| Tiptap JSON / HTML | In-memory editing projections only; never stored or synced |
| Message parts | Content not naturally expressible as authored Markdown, such as tools and interactive UI |
| Mentions | Inline atoms serialized with durable ids and readable labels |
| Drafts | Local SQLite only, never synced |
| Send | Message, outbox operation and exact draft-revision deletion happen in one transaction |
| Suggestions | One interaction shell, with typed providers for actors, audiences and commands |
| Link cards | Future enrichment; never block composing or sending |

The official Tiptap Markdown extension is currently beta. It is the smallest
bridge for the chosen Markdown contract, but its output needs round-trip tests.
Tiptap upgrades must run those tests rather than assuming beta output stability.

## Overall shape

```text
Chat
├── message list
│   └── MarkdownText
│       ├── CommonMark/GFM blocks and marks
│       ├── durable mention chips
│       └── controlled external links
│
└── MessageComposer
    ├── suggestion surface (temporary)
    │   ├── filtered results
    │   └── highlighted-result peek
    ├── formatting toolbar
    ├── Tiptap editing surface
    └── footer
        ├── trigger hint
        └── send / stop
```

The route owns placement and scrolling. `MessageComposer` owns editor
interaction. Tiptap owns selection, composition, history and its document tree.
The utility process owns durable drafts and sending.

## Content model

```text
Document
├── paragraph
│   ├── text
│   │   └── bold | italic | strike | inline-code | link
│   ├── actor mention
│   ├── audience mention
│   └── command chip (editor-only, serialized as /name)
├── block quote
├── bullet list
├── ordered list
└── code block
```

Headings, horizontal rules, arbitrary HTML, tables and inline attachments are
outside the composer schema. Attachments are message-owned records.

The persisted authored message has one content field:

```text
Message
├── identity, author and ordering
├── body: canonical Relayed Markdown
├── optional non-text parts
└── timestamps and delivery state
```

There is deliberately no `body_document`. Two rich representations drift, and
the server would have to decide which contradictory value to trust.

## Relayed Markdown

CommonMark/GFM represents paragraphs, bold, italic, strike, inline code, fenced
code, quotations, lists and ordinary links. Relayed adds semantic link schemes
for atoms Markdown does not otherwise understand:

```md
[priya](actor:act_01ABC)
[here](audience:here)
```

The label is a readable compose-time fallback. The target is the actor id or
closed audience value. Resolution, authorization, notification and agent
invocation never use the label. A handle rename cannot retarget a mention.

The sent renderer recognizes these schemes and draws `@priya` or `@here` as a
chip. Unknown or malformed schemes stay inert Markdown rather than becoming
privileged actions.

Allowed audience values are `here`, `chat`, `channel` and `room`. The UI should
offer only entries valid for the current placement. The server must still
validate placement and permission when audience effects are implemented.
Audience mentions never invoke agents. Only an explicit actor mention targeting
an agent may do that, and only after the message is durably committed.

## Suggestion surface and peek

Typing `@` or `/` at the beginning of a block or after whitespace creates a
trigger range. Tiptap's Suggestion utility owns detection, the query and
replacement range, dismissal and editor-focused key events. The rendered menu
uses the shared shadcn Command primitives for its scrollable list, empty state,
selected row and pointer selection. A small adapter forwards arrow and Enter
key events to Command while focus stays in the editor. Command's own keyboard
handler changes selection and scrolls the active row into view together; changing
its controlled value externally skips that scrolling in the installed cmdk.
The list reserves one row of scroll padding at each edge, so keyboard navigation
keeps the next row visible until it reaches the actual end of the results.
Selection colors change immediately, and pointer events with unchanged coordinates
cannot replace the keyboard selection when scrolling moves rows beneath the cursor.

```text
@ → local actor directory + context-valid audiences
    actor selection    → insert actor atom + trailing space
    audience selection → insert audience atom + trailing space

/ → composer commands
    selection → remove trigger text, then transform current block
```

The first commands are `/code`, `/quote`, `/bullet`, `/number` and `/text`.
They change the editor; they are not messages sent to the server. Workflows may
later use the same surface but must declare whether selection inserts content,
opens confirmation UI or executes a local action.

Agent and plugin commands selected for sending insert an inline, non-editable
command chip followed by a space for arguments. Like T3's skill chips, these are
editor atoms, not independently editable label text. They serialize to ordinary
`/name` text, so sending and local drafts keep the existing command protocol.
A leading command in a restored draft is projected back into a chip; slashes in
code, marked text and later paragraphs are not. Formatting commands still apply
their block transformation immediately, and app commands that open controls do
not leave a chip behind.

The peek describes the highlighted result and its effect. It is not a second
menu. Its overflow scrolls independently of the result list, with the same height
cap; selecting another result resets the description to the top. It disappears
on narrow layouts while the list remains usable.

Return never sends while the menu owns selection. IME composition is checked
before selection or send. Outside code blocks, Return sends and Shift-Return
inserts a break. Mod-Return sends from every block. Inside code, Return remains
a newline.

Those are the defaults of the `composer.message.send` command, and a person can
change them in keyboard shortcuts settings. The rules generalize: a binding
without Control, Alt or Command never sends inside a code block, and nothing
sends while the menu is open or during composition (`send-key.ts`;
SHORTCUTS.md §10, §12.3).

## Formatting and links

The toolbar exposes bold, italic, strike, inline code, quote, code block,
bulleted list and numbered list. Tiptap keyboard shortcuts and input rules stay
available. Toolbar state uses `useEditorState`, so selection changes do not
rebuild the composer. The editor is not a controlled React input.

Named-link editing and underline remain follow-up work. A bare URL may be shown
as a collapsed chip while retaining the complete URL as its source and clipboard
value. Network-fetched previews are post-send enrichment with privacy and
redirect policy, not editor state.

## Drafts

Drafts live with the chat: in the workspace replica for a workspace chat and in
`local-rooms.db` for a local room. They never enter the outbox and never sync.

```sql
CREATE TABLE drafts (
  chat_id     TEXT    NOT NULL,
  draft_kind  TEXT    NOT NULL DEFAULT 'compose',
  context_key TEXT    NOT NULL DEFAULT 'root',
  body        TEXT    NOT NULL,
  revision    INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (chat_id, draft_kind, context_key)
);
```

The first slice writes `compose/root`. The key already admits root, thread and
edit drafts without a later key migration.

Each document-changing transaction serializes Markdown and increments the
editor revision. Empty content deletes the row. Selection, suggestion state,
toolbar state and undo history are session state. Writes are currently immediate
SQLite writes. Coalescing may be added behind the same utility-process API; a
renderer timer cannot own durability because hidden windows are throttled.

### Atomic send transition

The composer sends its exact Markdown snapshot and current draft revision.

```text
workspace:
  insert optimistic message(body)
  enqueue send operation(body)
  delete compose/root draft where revision = submitted revision

local room:
  insert person's message(body)
  insert streaming agent reply
  delete compose/root draft where revision = submitted revision
```

Revision matching is load-bearing. If a newer edit lands while an older send
snapshot commits, the older send must not delete the newer draft. A successful
transaction clears the editor and returns to the live edge. A local failure
leaves the editor and draft intact. Network failure is not a composer failure:
the workspace message is already durable in the outbox.

Multiple-window leases, reply/edit UI and crash-time in-memory flushing remain
follow-up work. Revisions prevent an older write or send from deleting newer
content, but do not yet stop two windows alternately updating one draft.

## End-to-end flow

```text
SQLite draft body
      ↓ live-query load
Tiptap Markdown parser
      ↓ edit
Tiptap Markdown serializer
      ↓ local draft command
SQLite draft body
      ↓ send exact revision
message + outbox + draft deletion transaction
      ↓ local invalidation
MarkdownText renders optimistic row
```

Actor suggestions come from the local replica; composing needs no network read.
Local rooms use their two fixed local actors. No message body, Markdown, mention
label or URL may enter telemetry.

## Remaining work

- Placement-aware audience filtering and server authorization.
- Normalized mention targets for unread counts, notifications and exactly-once
  agent invocation; intent must not be rediscovered from display labels.
- Named-link editing and collapsed bare-link atoms.
- Configured Return behavior preference.
- Reply and edit draft surfaces using the existing composite key.
- Attachments with draft ownership transfer during send.
- Utility-process coalescing, edit leases and orderly-shutdown flush.
- Complete Markdown/custom-mention round-trip tests around the beta codec.

## Acceptance checks

- Formatting survives compose → Markdown body → sent renderer.
- Mention atoms round-trip without losing their durable target.
- `@` and `/` share keyboard and pointer behavior; Enter cannot send while open.
- Code blocks accept multiline Return and Mod-Return sends them.
- Draft survives route change, renderer reload and application restart.
- Offline send creates a pending message and outbox row.
- Successful send deletes only the submitted draft revision.
- A newer draft survives an older send snapshot.
- Unknown semantic schemes never become mention actions.
- Message bodies and labels never appear in telemetry.
