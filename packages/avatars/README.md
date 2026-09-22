# @relayed/avatars

Deterministic, animated avatars for agents. A seed goes in — an agent's id — and
the same face comes out, on every device, forever. No network, no stored image,
no cache.

```tsx
import { EyeAvatar } from '@relayed/avatars/react';
import '@relayed/avatars/styles.css';

<EyeAvatar seed={agent.id} />
```

## Why generate rather than fetch

Hosted avatar services render per request from an edge. That means an agent's
face disappears when the reader is offline, flickers on every cold render, and
tells a third party which agents exist every time someone opens a list. Drawing
the face locally costs a few hundred bytes of geometry and has none of those
properties.

## Two families

**Eyes** — a solid disc with the eyes cut *out* of it. The holes mean whatever
is behind shows through, so one face works on a sidebar, a hover card and a
coloured banner without anyone choosing an eye colour to match. Every eye is a
rounded rect, so a mood is only ever its proportions, and moods can interpolate.

**Petals** — a disc cut into rounded segments. A cell is an intersection of
half-planes, which is what lets the gap and the corner rounding be the same
operation, and what lets the cuts themselves travel rather than the pieces
sliding about as rigid tiles.

## States

`AgentActivity` is a vocabulary of nine postures: `idle`, `waiting`, `thinking`,
`searching`, `working`, `laser`, `speaking`, `done`, `failed`.

It is deliberately about **posture, not tools**. "Searching" is a thing a
creature does with its eyes; `LINEAR_SEARCH_ISSUES` is a thing a runtime does
with an API. Keeping the vocabulary on the creature's side is what lets a tool
catalogue grow without anyone re-choreographing an animation.

Liveliness is three independent clocks that never line up — gaze, blink, breath.
Anything moving on one clock reads as a loading spinner.

## The cycle, and its boundary

Most agent runtimes report *that* work is happening and nothing about *what*.
`useAgentPosture` covers such an interval by cycling through `thinking`,
`searching` and `working` on a schedule seeded from the run id.

That cycle is **invented, not observed**, so what is in it matters:

- Only postures true at *any* moment of a run are included. An agent that is
  running genuinely is thinking, searching and calling tools in some order we
  cannot see, so showing one is a plausible depiction of an unobserved interval
  — the way a progress bar's motion depicts work without measuring it.
- `speaking`, `done`, `failed` and `laser` are excluded, and that is the line.
  Each makes a specific claim a person could catch you getting wrong.
- A real signal always wins. Pass `known` and the cycle is never consulted, so
  the day your runtime starts reporting detail, this retires itself.

A test enforces the exclusion; do not relax it casually.

## Host boundary

**Nothing in this package knows what a run looks like.** Translating your own
run record into a posture is your job, and it is about ten lines:

```ts
function observed(run: MyRun | null): AgentActivity | null {
  if (!run) return 'idle';
  if (run.state === 'queued') return 'waiting';
  return run.toolName ? activityForTool(run.toolName) : null; // null → cycle
}

const posture = useAgentPosture({ runId: run?.id ?? null, known: observed(run) });
```

Relayed's own adapter is `apps/desktop/src/renderer/lib/agent-posture.ts`.

## Entry points

| Import | Contains |
| --- | --- |
| `@relayed/avatars` | Geometry and vocabulary. No React, no DOM. |
| `@relayed/avatars/react` | Components and the posture hook. |
| `@relayed/avatars/styles.css` | All animation. Import once per app. |

The split is so a consumer that only wants geometry — rendering an avatar to a
PNG on a server, say — never resolves React.

## Sizing

The package ships **no** width, height or Tailwind classes. An avatar fills
whatever it sits in; `.relayed-avatar` sets only `display: block`, because an
inline SVG inherits line-height and lands off-centre. A library that picks its
own size is a library you fight.

## Motion

`prefers-reduced-motion` is honoured. CSS animations stop through the media
query; the petal morph is SMIL, which ignores stylesheets, so the component
drops the `<animate>` element instead. On a dense list, `animated={false}` turns
idle motion off — fifty blinking faces are fifty animations nobody asked to
watch.

## Publishing

Currently `private: true`, matching the other workspace packages. To publish:
drop that flag, pick a scope you own, and add a build step — consumers outside
this monorepo cannot import `.ts` source the way `exports` currently points at
it. Nothing else here assumes a monorepo.
