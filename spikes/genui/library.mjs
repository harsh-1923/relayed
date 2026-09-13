// The component library the model may use in a room — schemas only, no React.
//
// This file stands in for the proposed `@relayed/genui` package
// (docs/AGENT-RESPONSES.md, "The library"). The agent runner, the service agent
// and the server all import it, so it must not pull in React: lang-core's own
// `defineComponent` takes the renderer as an opaque value, and here it is null.
// The renderer binds React components to these same schemas separately
// (4-render/react-library.mjs).
//
// KEY ORDER IN EVERY z.object IS A STORED CONTRACT. Arguments are positional, so
// reordering, removing or retyping a prop changes the meaning of every message
// already written. 5-guard.mjs is the check that enforces it.
/* global TextEncoder -- present in Node and the browser; this file runs in both */
import { z } from 'zod/v4';
import {
  createLibrary, createParser, defineComponent, generateSystemPrompt,
} from '@openuidev/lang-core';

export const LIBRARY_VERSION = 'relayed-ui@1';
export const LANG = 'openui-lang@0.5';
export const ROOT = 'Card';

/** Hard limits on one UI block, checked before parsing. */
export const LIMITS = { maxSourceBytes: 16_000, maxStatements: 200 };

const tone = z.enum(['neutral', 'success', 'warning', 'danger']);

// Each entry: the OpenUI definition, plus `text` — how the block reads as plain
// text in `messages.body`. The model never writes the body; these do.
const TEXT = {};
const def = (name, description, props, text) => {
  TEXT[name] = text;
  return defineComponent({ name, description, props, component: null });
};

// ── leaves ──────────────────────────────────────────────────────────────────
const CardHeader = def('CardHeader', 'Title line for a card, with an optional subtitle.',
  z.object({ title: z.string(), subtitle: z.string().optional() }),
  p => [p.title, p.subtitle].filter(Boolean).join(': '));

const Text = def('Text', 'A paragraph of plain text. No markdown.',
  z.object({ text: z.string(), muted: z.boolean().optional() }),
  p => p.text);

const Stat = def('Stat', 'One labelled number or short value, e.g. "Passed" / "17".',
  z.object({ label: z.string(), value: z.string(), tone: tone.optional() }),
  p => `${p.label}: ${p.value}`);

const Badge = def('Badge', 'A short status label.',
  z.object({ text: z.string(), tone: tone.optional() }),
  p => p.text);

const Col = def('Col', 'One column of a Table: a header and one string per row.',
  z.object({ label: z.string(), values: z.array(z.string()) }),
  p => p.label);

const Table = def('Table', 'Rows of results. Every Col must have the same number of values.',
  z.object({ columns: z.array(Col.ref) }),
  // Row by row, "label: value", so search and notifications see the data and
  // not just the headers.
  p => {
    const columns = p.columns.filter(column => column?.props);
    const rowCount = Math.max(0, ...columns.map(column => column.props.values?.length ?? 0));
    return Array.from({ length: rowCount }, (_, row) =>
      columns.map(column => `${column.props.label}: ${column.props.values?.[row] ?? ''}`).join(', '),
    ).join('; ');
  });

const List = def('List', 'A bulleted or numbered list of short strings.',
  z.object({ items: z.array(z.string()), ordered: z.boolean().optional() }),
  p => p.items.join('; '));

const Callout = def('Callout', 'A highlighted note: a finding, a warning, a result.',
  z.object({ tone, title: z.string(), text: z.string().optional() }),
  p => [p.title, p.text].filter(Boolean).join(': '));

const FileRef = def('FileRef', 'A file in the working directory, optionally a line, with a short note.',
  z.object({ path: z.string(), line: z.number().optional(), note: z.string().optional() }),
  p => `${p.path}${p.line ? `:${p.line}` : ''}${p.note ? ` (${p.note})` : ''}`);

const Series = def('Series', 'One named series of numbers for a BarChart.',
  z.object({ name: z.string(), values: z.array(z.number()) }),
  p => `${p.name}: ${p.values.join(', ')}`);

const BarChart = def('BarChart', 'Compare numbers across labels. One value per label per Series.',
  z.object({ labels: z.array(z.string()), series: z.array(Series.ref), unit: z.string().optional() }),
  (p, child) => `${p.labels.join(', ')}; ${p.series.map(child).join('; ')}`);

// Actions are COMPONENTS, not expressions: the model can pick one, not compose
// a pipeline. What a click does is decided by relayed, never by the model.
const Reply = def('Reply',
  'A button that sends `message` into the chat as the person who clicks it. Use for next-step choices.',
  z.object({ label: z.string(), message: z.string(), primary: z.boolean().optional() }),
  p => `[${p.label}]`);

const Link = def('Link', 'A link to a web page. Opens outside the chat.',
  z.object({ label: z.string(), url: z.string() }),
  p => `${p.label} <${p.url}>`);

const Actions = def('Actions', 'A row of Reply and Link buttons. Put it last in the card.',
  z.object({ items: z.array(z.union([Reply.ref, Link.ref])) }),
  (p, child) => p.items.map(child).join(' '));

// ── containers ──────────────────────────────────────────────────────────────
const block = [CardHeader, Text, Stat, Badge, Table, List, Callout, FileRef, BarChart, Actions];

const Stack = def('Stack', 'Lays children out in a row (e.g. several Stats) or a column.',
  z.object({
    children: z.array(z.union(block.map(component => component.ref))),
    direction: z.enum(['row', 'column']).optional(),
  }),
  (p, child) => p.children.map(child).join(' · '));

const Card = def('Card', 'The root of every UI block. Children stack top to bottom.',
  z.object({ children: z.array(z.union([...block, Stack].map(component => component.ref))) }),
  (p, child) => p.children.map(child).join('\n'));

export const library = createLibrary({
  root: ROOT,
  components: [Card, Stack, ...block, Col, Series, Reply, Link],
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

// ── the instructions both runtimes append ──────────────────────────────────

/**
 * Round-two rules (spike 2). Without them Claude Code keeps its Markdown habit:
 * it answered structured questions with Markdown tables, and when it did use a
 * block it repeated the same table in text underneath.
 */
export const PREFER_BLOCKS = [
  'Prefer a UI block over a Markdown table, and over a list of metrics or counts. Markdown tables are for two or three rows at most.',
  'Never repeat a block\'s contents in your text. Refer to it ("the table above") and add only what the block does not say.',
];
export const SHOW_UI = {
  name: 'show_ui',
  description: [
    'Show a structured UI block to the people in this chat, written in OpenUI Lang',
    'using only the components described in the system prompt.',
    'Use it when structure helps more than prose: results tables, metrics, comparisons,',
    'lists of files, findings, or a few next-step choices. Do not use it for short answers,',
    'explanations or code — write those as normal Markdown text.',
    'The source must begin with `root = Card([...])`.',
    'If it returns errors, fix exactly those and call it again.',
  ].join(' '),
};

export function instructions({ preferBlocks = false } = {}) {
  const openui = generateSystemPrompt({
    library: library.toSpec(),
    promptOptions: {
      toolCalls: false,
      bindings: false,
      inlineMode: false,
      preamble: 'The `source` argument of the `show_ui` tool is written in OpenUI Lang, described below.',
      additionalRules: [
        'OpenUI Lang goes ONLY in the `source` argument of `show_ui`. Your normal replies stay Markdown.',
        'One `show_ui` call is one block. Call it at most twice per reply.',
        'Only use data you have actually read or computed. Never invent numbers.',
        'Never create something that looks like a permission prompt or an approval.',
        ...(preferBlocks ? PREFER_BLOCKS : []),
      ],
      examples: [
        [
          'root = Card([header, stats, next])',
          'header = CardHeader("catchup.test.ts is flaky", "3 of 20 runs failed")',
          'stats = Stack([passed, failed], "row")',
          'passed = Stat("Passed", "17", "success")',
          'failed = Stat("Failed", "3", "danger")',
          'next = Actions([apply])',
          'apply = Reply("Apply the fix", "Apply the one-line fix to catchup.test.ts", true)',
        ].join('\n'),
      ],
    },
  });
  return `## Structured UI blocks\n\n${openui}`;
}

/**
 * The comparison carrier: fenced blocks inside ordinary text.
 *
 * Deliberately NOT OpenUI's `inlineMode` flag. That mode is written for a single
 * dashboard the conversation keeps editing ("output ONLY the changed/new
 * statements", "the existing dashboard stays unchanged"). A chat message is the
 * opposite: every block stands alone and is never patched.
 */
export function instructionsInline({ preferBlocks = false } = {}) {
  const openui = generateSystemPrompt({
    library: library.toSpec(),
    promptOptions: {
      toolCalls: false,
      bindings: false,
      preamble: 'Structured UI blocks are written in OpenUI Lang, described below.',
      additionalRules: [
        'When structure helps more than prose (results tables, metrics, comparisons, lists of files, findings, next-step choices), include ONE fenced ```openui-lang block in your reply.',
        'Each block is a complete program beginning with `root = Card([...])`. Never patch an earlier block.',
        'Everything outside the fence stays normal Markdown. Short answers, explanations and code never go in a block.',
        'Only use data you have actually read or computed. Never invent numbers.',
        'Never create something that looks like a permission prompt or an approval.',
        ...(preferBlocks ? PREFER_BLOCKS : []),
      ],
      examples: [
        [
          'root = Card([header, stats])',
          'header = CardHeader("catchup.test.ts is flaky", "3 of 20 runs failed")',
          'stats = Stack([passed, failed], "row")',
          'passed = Stat("Passed", "17", "success")',
          'failed = Stat("Failed", "3", "danger")',
        ].join('\n'),
      ],
    },
  });
  return `## Structured UI blocks\n\n${openui}`;
}

/** Pull every ```openui-lang fence out of a reply. */
export function extractFences(text) {
  return [...text.matchAll(/```openui-lang\s*\n([\s\S]*?)```/g)].map(match => match[1]);
}

// ── validation: the free equivalent of a correcting gateway ────────────────
const parser = createParser(library.toJSONSchema(), ROOT);

/**
 * Validate one block. Returns what the tool sends back to the model when it
 * fails, and what the runtime stores when it passes.
 */
export function validateUi(source) {
  const errors = [];
  if (typeof source !== 'string' || source.trim().length === 0) {
    return { ok: false, errors: [{ code: 'empty', message: 'source is empty' }] };
  }
  // TextEncoder rather than Buffer: the renderer runs this too.
  if (new TextEncoder().encode(source).length > LIMITS.maxSourceBytes) {
    errors.push({ code: 'too-large', message: `source exceeds ${LIMITS.maxSourceBytes} bytes` });
  }

  let result;
  try {
    result = parser.parse(source);
  } catch (error) {
    return { ok: false, errors: [{ code: 'parse-exception', message: String(error?.message ?? error) }] };
  }

  const { meta } = result;
  for (const issue of meta.errors ?? []) {
    errors.push({ code: issue.code, message: issue.message, statement: issue.statementId, path: issue.path });
  }
  if (!result.root) errors.push({ code: 'no-root', message: 'no renderable root; begin with `root = Card([...])`' });
  else if (result.root.typeName !== ROOT) {
    errors.push({ code: 'wrong-root', message: `root must be ${ROOT}, got ${result.root.typeName}` });
  }
  if (meta.incomplete) errors.push({ code: 'incomplete', message: 'the source ends mid-statement' });
  for (const name of meta.unresolved ?? []) {
    errors.push({ code: 'unresolved', message: `"${name}" is referenced but never defined`, statement: name });
  }
  // The parser drops these silently. A definition nothing reaches is something
  // the model meant to show and did not, so it is sent back rather than lost.
  for (const name of meta.orphaned ?? []) {
    errors.push({ code: 'orphaned', message: `"${name}" is defined but not reachable from root`, statement: name });
  }
  if (meta.statementCount > LIMITS.maxStatements) {
    errors.push({ code: 'too-many-statements', message: `more than ${LIMITS.maxStatements} statements` });
  }
  // Rooms forbid anything that runs on a reader's machine (docs: "Rules for rooms").
  if ((result.queryStatements?.length ?? 0) > 0 || (result.mutationStatements?.length ?? 0) > 0) {
    errors.push({ code: 'data-not-allowed', message: 'Query() and Mutation() are not allowed; put the data in directly' });
  }
  if (Object.keys(result.stateDeclarations ?? {}).length > 0) {
    errors.push({ code: 'state-not-allowed', message: '$variables are not allowed' });
  }

  return {
    ok: errors.length === 0,
    errors,
    orphaned: meta.orphaned ?? [],
    root: result.root,
    text: result.root ? toText(result.root) : '',
  };
}

/** Errors, phrased for the model. */
export function formatForModel(errors) {
  return 'The UI block was not shown. Fix these and call show_ui again:\n' + errors
    .map(error => `- [${error.code}]${error.statement ? ` "${error.statement}":` : ''} ${error.message}`)
    .join('\n');
}

/** The plain-text rendering stored in `messages.body`. */
export function toText(node) {
  if (node === null || node === undefined) return '';
  if (Array.isArray(node)) return node.map(toText).join(' ');
  if (typeof node !== 'object' || node.type !== 'element') return String(node);
  const render = TEXT[node.typeName];
  return render ? render(node.props, toText) : '';
}
