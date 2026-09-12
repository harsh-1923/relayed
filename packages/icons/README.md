# @relayed/icons

~980 icons as themeable React components. Every icon ships in **5 styles** —
`Stroke`, `Solid`, `Contrast`, `Duo Stroke`, `Duo Solid` — from a single
component, chosen at the call site rather than at the import.

## Usage

```tsx
import { Ai01 } from '@relayed/icons';

<Ai01 />                                      // Stroke, 24px, inherits text color
<Ai01 variant="Solid" />
<Ai01 variant="Duo Solid" size={32} color="#6d28d9" />
<Ai01 variant="Contrast" strokeWidth={1.5} className="opacity-80" />
```

Props: `variant` (style), `size`, `color`, `strokeWidth`, `absoluteStrokeWidth`,
plus any native `<svg>` prop (`onClick`, `aria-label`, …). Passing `aria-label`
drops the default `aria-hidden`, so a decorative icon stays out of the
accessibility tree and a meaningful one does not.

Color is driven by `currentColor`: both tones of the duo and contrast styles
inherit the same `color`, with the secondary tone at reduced opacity — so one
`color` prop themes the whole icon, and leaving it off inherits the surrounding
text color.

**The barrel, and when not to use it.** `@relayed/icons` re-exports all ~980
icons. Measured against the renderer build:

| | |
|---|---|
| Production, one icon from the barrel | **+20 kB** uncompressed (1,531 → 1,552 kB) |
| Production, the renderer's real 47 icons | **+123 kB** uncompressed (1,531 → 1,654 kB) |
| The same, without `"sideEffects": false` | **+5,496 kB** — the entire set |
| Dev server, cold, one icon from the barrel | **986 module requests**, ~1.4s of transform |

The first icon costs 20 kB and each further one about 2.6 kB, because what ships
per icon is all five styles: the variant is a prop, so the bundler cannot know
which ones a call site will ask for.

So `"sideEffects": false` in this package's manifest is not decoration. Every
icon module ends in a top-level `createIcon(...)` call, which Rollup cannot
prove pure on its own — without that flag it keeps all ~980, and importing one
icon ships the whole set.

Dev is the case the flag does not cover: Vite serves a linked workspace package
as source rather than pre-bundling it, so the barrel fans out to a request per
icon on a cold start. Where that shows, import the file instead:
`import { Ai01 } from '@relayed/icons/icons/ai-01'`.

`@relayed/icons/meta` carries `ICON_META` (component name, kebab-case id,
section, category per icon) and `ICON_SECTIONS` — enough to build a picker
without enumerating the barrel by hand.

## How it works

- **`src/types.ts`** — `IconNode` (`[tag, attrs][]`), the `IconStyle` union,
  `IconVariants`.
- **`src/createIcon.ts`** — one factory + renderer. Builds the `<svg>` from
  shared defaults, applies `size`/`color`/`strokeWidth`, and maps the selected
  variant's nodes to child elements. `fill`/`stroke`/`strokeWidth` are set once
  on the root and inherited by every path, which is what keeps a 5-style icon
  one component instead of five. It uses `createElement` rather than JSX, so the
  package needs no `jsx` compiler setting of its own.
- **`src/icons/*.ts`** — generated, one file per icon: an `IconVariants` object
  fed to `createIcon`.
- **`src/meta.ts`** — generated. Component name, kebab-case id, section and
  category per icon.

Consumed as TypeScript source, like every other workspace package here — there
is no build step and no `dist`.

**A few icons do not have all five styles**, because the set they came from does
not. Those fall back to `Stroke`, so asking one of them for `Solid` renders the
stroke shape rather than nothing — worth knowing before concluding that
`variant` is ignored.

## Adding icons

`src/icons/*.ts` is generated, and **the generator is not in this repository** —
this package ships the icons, not the machinery that produced them. The
pipeline, its raw SVG exports and its build report are ignored at the repo root;
whoever holds them regenerates `src/icons/`, `src/index.ts` and `src/meta.ts`
together and commits the result.

So there are two ways to add one, and no third:

- **Regenerate**, if you have the pipeline. It rewrites all three, and it drops
  anything hand-added — today that is `mark-as-read`, which says so in its own
  header.
- **Add the file by hand**: one `src/icons/<name>.ts` shaped like its
  neighbours, plus a line in the barrel and a row in `src/meta.ts`. Mark it the
  way `mark-as-read` is marked, so the next regeneration does not silently take
  it away.

The file name is the component name: `ai-01` → `Ai01`.
