// The components an agent may use in a UI block (docs/AGENT-RESPONSES.md, the
// library).
//
// Schemas only. The server, the agent runner and the service agent import this
// package, so it must not pull in React: lang-core's `defineComponent` stores
// the renderer as an opaque value, and here it is null. The desktop renderer
// binds `components/ui/*` to these same definitions.
//
// ARGUMENT ORDER IS STORED. OpenUI Lang arguments are positional, mapped by the
// key order of each `z.object`, so every UI block already written depends on
// that order. Moving, removing, renaming or retyping a prop does not fail — it
// silently changes what old messages say (measured: a swapped label and value
// still validate). The guard test refuses those changes (guard.ts).
import { z } from 'zod';
import { createLibrary, defineComponent } from '@openuidev/lang-core';

/** Stamped on every stored `ui` part. Bumped only when a component is added. */
export const LIBRARY_VERSION = 'relayed-ui@1';
export const LANG = 'openui-lang@0.5';
export const ROOT = 'Card';

/** Plain text for one child node: another component, or nothing. */
export type ChildText = (node: unknown) => string;

/**
 * How a component reads as plain text in `messages.body`.
 *
 * `Partial`, because this also runs on a block that is still streaming or that
 * failed validation — the renderer's fallback — where required props may be
 * missing. Every function below has to cope with that.
 */
type TextFor<Shape extends z.ZodObject> = (props: Partial<z.infer<Shape>>, child: ChildText) => string;
type AnyText = (props: Record<string, unknown>, child: ChildText) => string;

const textByComponent = new Map<string, AnyText>();

function component<Shape extends z.ZodObject>(
  name: string, description: string, props: Shape, text: TextFor<Shape>,
) {
  textByComponent.set(name, text as AnyText);
  return defineComponent({ name, description, props, component: null });
}

const tone = z.enum(['neutral', 'success', 'warning', 'danger']);
const joined = (...parts: (string | undefined)[]): string => parts.filter(Boolean).join(': ');
const list = (items: readonly unknown[] | undefined, child: ChildText, separator: string): string =>
  (items ?? []).map(child).filter(Boolean).join(separator);

// ── leaves ──────────────────────────────────────────────────────────────────

const CardHeader = component('CardHeader', 'Title line for a card, with an optional subtitle.',
  z.object({ title: z.string(), subtitle: z.string().optional() }),
  props => joined(props.title, props.subtitle));

const Text = component('Text', 'A paragraph of plain text. No markdown.',
  z.object({ text: z.string(), muted: z.boolean().optional() }),
  props => props.text ?? '');

const Stat = component('Stat', 'One labelled number or short value, e.g. "Passed" / "17".',
  z.object({ label: z.string(), value: z.string(), tone: tone.optional() }),
  props => joined(props.label, props.value));

const Badge = component('Badge', 'A short status label.',
  z.object({ text: z.string(), tone: tone.optional() }),
  props => props.text ?? '');

const Col = component('Col', 'One column of a Table: a header and one string per row.',
  z.object({ label: z.string(), values: z.array(z.string()) }),
  props => props.label ?? '');

const Table = component('Table', 'Rows of results. Every Col must have the same number of values.',
  z.object({ columns: z.array(Col.ref) }),
  // Row by row as "label: value", so search and notifications see the data
  // rather than only the headers.
  props => {
    const columns = (props.columns ?? []).filter(column => column?.props);
    const rowCount = Math.max(0, ...columns.map(column => column.props.values?.length ?? 0));
    return Array.from({ length: rowCount }, (_, row) =>
      columns.map(column => `${column.props.label}: ${column.props.values?.[row] ?? ''}`).join(', '),
    ).join('; ');
  });

const List = component('List', 'A bulleted or numbered list of short strings.',
  z.object({ items: z.array(z.string()), ordered: z.boolean().optional() }),
  props => (props.items ?? []).join('; '));

const Callout = component('Callout', 'A highlighted note: a finding, a warning, a result.',
  z.object({ tone, title: z.string(), text: z.string().optional() }),
  props => joined(props.title, props.text));

const FileRef = component('FileRef', 'A file in the working directory, optionally a line, with a short note.',
  z.object({ path: z.string(), line: z.number().optional(), note: z.string().optional() }),
  props => `${props.path ?? ''}${props.line ? `:${props.line}` : ''}${props.note ? ` (${props.note})` : ''}`);

const Series = component('Series', 'One named series of numbers for a BarChart.',
  z.object({ name: z.string(), values: z.array(z.number()) }),
  props => `${props.name ?? ''}: ${(props.values ?? []).join(', ')}`);

const BarChart = component('BarChart', 'Compare numbers across labels. One value per label per Series.',
  z.object({ labels: z.array(z.string()), series: z.array(Series.ref), unit: z.string().optional() }),
  (props, child) => `${(props.labels ?? []).join(', ')}; ${list(props.series, child, '; ')}`);

// Actions are COMPONENTS, not expressions. The model picks one; what a click
// does is decided by relayed (docs/AGENT-RESPONSES.md, actions).
const Reply = component('Reply',
  'A button that sends `message` into the chat as the person who clicks it. Use for next-step choices.',
  z.object({ label: z.string(), message: z.string(), primary: z.boolean().optional() }),
  props => `[${props.label ?? ''}]`);

const Link = component('Link', 'A link to a web page. Opens outside the chat.',
  z.object({ label: z.string(), url: z.string() }),
  props => `${props.label ?? ''} <${props.url ?? ''}>`);

const Actions = component('Actions', 'A row of Reply and Link buttons. Put it last in the card.',
  z.object({ items: z.array(z.union([Reply.ref, Link.ref])) }),
  (props, child) => list(props.items, child, ' '));

// ── containers ──────────────────────────────────────────────────────────────

const blocks = [CardHeader, Text, Stat, Badge, Table, List, Callout, FileRef, BarChart, Actions];

const Stack = component('Stack', 'Lays children out in a row (e.g. several Stats) or a column.',
  z.object({
    children: z.array(z.union(blocks.map(block => block.ref))),
    direction: z.enum(['row', 'column']).optional(),
  }),
  (props, child) => list(props.children, child, ' · '));

const Card = component('Card', 'The root of every UI block. Children stack top to bottom.',
  z.object({ children: z.array(z.union([...blocks, Stack].map(block => block.ref))) }),
  (props, child) => list(props.children, child, '\n'));

export const library = createLibrary({
  root: ROOT,
  components: [Card, Stack, ...blocks, Col, Series, Reply, Link],
  componentGroups: [
    { name: 'Layout', components: ['Card', 'Stack'],
      notes: ['- Every block is `root = Card([...])`. Use Stack with "row" for side-by-side Stats.'] },
    { name: 'Content', components: ['CardHeader', 'Text', 'Stat', 'Badge', 'List', 'Callout', 'FileRef'] },
    { name: 'Data', components: ['Table', 'Col', 'BarChart', 'Series'],
      notes: ['- Table and BarChart hold data you already have. They never fetch anything.'] },
    { name: 'Actions', components: ['Actions', 'Reply', 'Link'],
      notes: ['- Reply sends its message as the person who clicks. Offer at most three.'] },
  ],
});

interface ElementLike { type: 'element'; typeName: string; props: Record<string, unknown> }

const isElement = (node: unknown): node is ElementLike =>
  typeof node === 'object' && node !== null && (node as { type?: unknown }).type === 'element';

/** The plain-text rendering of a parsed node, for `messages.body`. */
export function toText(node: unknown): string {
  if (Array.isArray(node)) return node.map(toText).filter(Boolean).join(' ');
  if (!isElement(node)) return '';
  return textByComponent.get(node.typeName)?.(node.props, toText) ?? '';
}
