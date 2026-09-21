# @relayed/web

The public site: marketing and, in time, documentation. Next.js App Router,
Tailwind v4, shadcn. Deployed separately from the product — this is a static
site, not the sync server.

```bash
pnpm web                              # dev server on http://localhost:3100
pnpm --filter @relayed/web build      # production build
pnpm --filter @relayed/web typecheck  # next typegen, then tsc
```

## Why port 3100 rather than 3000

Grafana holds 3000 in the local stack (`pnpm services`, `pnpm grafana`), and the
server and agent hold 8787 and 8788. 3100 is free, and `pnpm web` alongside
`pnpm services` is the ordinary case rather than the exception.

## Why `typecheck` runs `next typegen` first

Next generates the route-aware globals — `PageProps`, `LayoutProps`,
`RouteContext` — plus `next-env.d.ts` into `.next/types`. They exist only after
`next dev`, `next build` or `next typegen`, so a bare `tsc --noEmit` fails on a
clean checkout with `Cannot find name 'LayoutProps'`. `next typegen` produces
them without a full build, which is what `pnpm -r typecheck` and CI need.

## Where this app's conventions differ from the rest of the repo

Two deliberate exceptions, both because Next owns the build:

- **Imports carry no `.ts` extension.** The root convention exists because tests
  run under `node --test` on TypeScript directly and Node's ESM resolver has no
  extension inference. Nothing here runs that way — Next resolves through its
  own bundler.
- **`tsconfig.json` relaxes `exactOptionalPropertyTypes` and `noUnusedLocals`.**
  The same scoping the desktop renderer uses, for the same reason: `src/components/ui`
  is vendored shadcn that `shadcn add --overwrite` rewrites wholesale, so a patch
  there is undone by the next component update.

Everything else holds — ESM, Node >=24, no TypeScript syntax that emits code.

## shadcn components

**The whole registry is vendored** — all 61 components under
`src/components/ui`, plus `src/hooks/use-mobile.ts`, whether a page uses them or
not. They cost nothing at runtime: Next tree-shakes what no route imports, so
the build output is the same as if only the used ones were here.

To refresh one, or after a registry update, from the repository root with the
workspace named explicitly (the CLI refuses to guess from a monorepo root):

```bash
npx shadcn@latest add <component> -c apps/web -o   # or --all to refresh every one
```

The preset is `base-nova` on a `neutral` base — the same one the desktop
renderer uses (`apps/desktop/components.json`), so a component looks the same on
the site as it does in the product.

## Tuning the hero strips

The earlier strips design remains available in `HeroStrips` and `HeroStripsTuner`,
but is no longer rendered by the homepage. Its [DialKit](https://github.com/joshpuckett/dialkit)
panel controls strip thickness and length, the gap between them in the resting
row, label size, tracking and alignment, the drag feel (scale, elastic, momentum, and whether a
dragged strip pops off the multiply stack), and the rotate zones (handle size,
snap angle, and a toggle that tints them so they can be seen).

**Grab a strip's middle to move it, a tip to swing it.** The tips are React
`onPointerDown` zones that stop the gesture from reaching the body; the body
starts motion's drag by hand through `useDragControls`. Motion's own drag
listener is turned off (`dragListener={false}`) because it binds natively on the
element, so it fires before a delegated React handler can stop it — leaving a
tip that swings and slides at once.

`DialRoot` hides itself in production builds unless it is passed
`productionEnabled`, so the panel never reaches a visitor. Its code still does —
a hook that runs cannot be tree-shaken — which is why `HeroStrips` stays
prop-driven and the panel lives in a separate `HeroStripsTuner` wrapper.
When reusing the strips elsewhere, render `<HeroStrips />` without the tuner
when editing is not needed.

Values persist to `localStorage` under `dialkit:strips`. The panel's **Copy**
button hands you the config to paste into `DEFAULT_STRIP_SETTINGS` in
`src/components/hero-strips.tsx`, which is what the untuned hero reads.

## Hail logo page

`/hail` preserves the original cream Geist SemiBold mark on cobalt, rendered as
inline SVG without animation or controls. The shared SVG loader removes Figma's
comparison-board backgrounds so the square frame border never appears.

`/hail-v2` is the separate color and motion playground. Six starting palettes
(Obsidian, Midnight, Aurora, Ember, Paper, and Cobalt) are seeded as named
DialKit versions on first use. Each version retains its edits; the version menu
can create additional copies, and Copy exports the selected settings. Values
and versions persist locally under `dialkit:hail-v2`. The panel is explicitly
enabled in production because editing is the purpose of this route.

Both pages are statically rendered; the playground's decorative WebGL background
loads on the client. Reduced-motion preferences or unavailable WebGL 2 leave the
selected solid background in place. A pause button freezes the animation, and hidden tabs or
offscreen canvases stop rendering. The React Bits license is retained beside
the adapted component in `src/components/prismatic-burst.LICENSE.md`. Live controls
update shader uniforms without restarting its animation or creating new contexts.

## Relay homepage

The shared photo footer uses the cursor-following Retro Dither lens from the
supplied Canvas UI demo, including its fading trail. Clicking has no effect. The image
is uploaded directly to WebGL, avoiding the demo's experimental HTML-in-canvas
capture API; the Syncopate wordmark remains crisp HTML above it. The effect loads
near the footer, stops rendering once settled or offscreen, and leaves the normal
photo visible on touch, reduced motion, or unavailable/lost WebGL. No interaction
telemetry is added for this decorative effect.

`/` is the approved Relay landing page. `/new` re-exports the homepage so existing
preview links and the homepage cannot drift. The layout is a full-width, viewport-height Ember
hero with the logo centered over the animated rays and a two-line introduction
plus download area inside the canvas. It leads directly into `SiteFooter`, with a
two-column, 18px Manrope charter about Relay in the open sky above the chairs.
The charter stacks on narrow screens, with enough footer height to keep it above
the photograph's main subject. The intro and
download control stack on small screens. The download stays disabled until a
real URL is supplied. A collapsible DialKit panel edits the hero palette, logo
size, rays, and motion in place, with values persisted under `dialkit:new-hero`.
Its reset action restores the complete Ember starting configuration.

Palette defaults live in `src/lib/hail-presets.ts`, shared by this page and the
DialKit playground. `/new` uses the Ember starting preset; browser-local edits in
the playground do not silently change the landing page.

## Not built yet

- **Documentation routing.** MDX through `@next/mdx`, or a docs framework. Not
  chosen; nothing here presumes either.
- **Dark mode has tokens but no switch.** `globals.css` carries the `.dark`
  block and the `dark` variant; nothing sets the class, so the site renders
  light. A toggle is a deliberate decision, not an oversight.
- **Deployment.** Vercel is the intended target and nothing here is tied to it.
  See the hosting section in [`docs/STACK.md`](../../docs/STACK.md).
