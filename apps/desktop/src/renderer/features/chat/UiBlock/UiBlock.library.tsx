// @relayed/genui's components, drawn with ours (docs/AGENT-RESPONSES.md, the library).
//
// The DEFINITIONS — names, argument order, descriptions — come from the shared
// package, unchanged; only the drawing is decided here. That split is what lets
// the server validate a block and the model be told about it without either one
// importing React.
//
// Text, lists, tables and inline code are PLAIN elements: UiBlock sets the
// reply's Markdown styles around the block, so a card's words read exactly like
// the prose beside it. Only controls — buttons, badges — keep their own sizes.
//
// Every renderer receives PARTIAL props: a block may still be streaming, and a
// required argument can be missing for a few frames. Nothing here assumes one.
import type { ReactNode } from 'react';
import { Bar, BarChart as RechartsBarChart, CartesianGrid, XAxis } from 'recharts';
import { createLibrary, useTriggerAction, type ComponentRenderer } from '@openuidev/react-lang';
import { library as definitions, ROOT } from '@relayed/genui';
import { AlertCircle, AlertTriangle, CheckTickCircle } from '@relayed/icons';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge as ShadBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { cn } from '@/lib/utils';

type Tone = 'neutral' | 'success' | 'warning' | 'danger';

/** Semantic tokens only (FRONTEND.md, system theme): no colour is written here. */
const toneText: Record<Tone, string> = {
  neutral: 'text-foreground',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-destructive',
};

const toneOf = (value: unknown): Tone =>
  value === 'success' || value === 'warning' || value === 'danger' ? value : 'neutral';

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter(item => typeof item === 'string') : []);

/** A child element as the parser hands it over, before it is rendered. */
const childProps = (node: unknown): Record<string, unknown> | undefined =>
  typeof node === 'object' && node !== null && 'props' in node
    ? (node as { props: Record<string, unknown> }).props
    : undefined;

type Renderer = ComponentRenderer<Record<string, unknown>>;

// The root every block must have (genui ROOT), drawn WITHOUT a card's surface:
// a bordered card read as a separate object stuck into the reply, where these
// are part of it. Only the grouping and the gap between children remain.
const Card: Renderer = ({ props, renderNode }) => (
  <div className="flex max-w-2xl flex-col gap-3">{renderNode(props['children'])}</div>
);

const Stack: Renderer = ({ props, renderNode }) => (
  <div className={cn('flex gap-3', props['direction'] === 'row' ? 'flex-row flex-wrap' : 'flex-col')}>
    {renderNode(props['children'])}
  </div>
);

const CardHeader: Renderer = ({ props }) => (
  <div className="flex flex-col gap-0.5">
    <p className="font-semibold">{str(props['title'])}</p>
    {props['subtitle'] ? <p className="text-sm text-muted-foreground">{str(props['subtitle'])}</p> : null}
  </div>
);

const Text: Renderer = ({ props }) => (
  <p className={cn(props['muted'] === true && 'text-muted-foreground')}>
    {str(props['text'])}
  </p>
);

const Stat: Renderer = ({ props }) => (
  <div className="flex min-w-24 flex-col gap-0.5 rounded-lg border border-border px-3 py-2">
    <span className="text-sm text-muted-foreground">{str(props['label'])}</span>
    <span className={cn('text-xl leading-normal font-semibold tabular-nums', toneText[toneOf(props['tone'])])}>
      {str(props['value'])}
    </span>
  </div>
);

const badgeTone: Record<Tone, string> = {
  neutral: '',
  success: 'border-transparent bg-success/10 text-success',
  warning: 'border-transparent bg-warning/10 text-warning',
  danger: '',
};

const Badge: Renderer = ({ props }) => {
  const tone = toneOf(props['tone']);
  return (
    <ShadBadge variant={tone === 'danger' ? 'destructive' : 'outline'} className={badgeTone[tone]}>
      {str(props['text'])}
    </ShadBadge>
  );
};

const Table: Renderer = ({ props }) => {
  const columns = (Array.isArray(props['columns']) ? props['columns'] : [])
    .map(childProps)
    .filter((column): column is Record<string, unknown> => column !== undefined);
  const rowCount = Math.max(0, ...columns.map(column => strings(column['values']).length));
  return (
    <div className="md-table">
      <table>
        <thead>
          <tr>
            {columns.map((column, index) => <th key={index}>{str(column['label'])}</th>)}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rowCount }, (_, row) => (
            <tr key={row}>
              {columns.map((column, index) => <td key={index}>{strings(column['values'])[row] ?? ''}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const List: Renderer = ({ props }) => {
  const items = strings(props['items']).map((item, index) => <li key={index}>{item}</li>);
  return props['ordered'] === true
    ? <ol>{items}</ol>
    : <ul>{items}</ul>;
};

const calloutIcon: Record<Tone, ReactNode> = {
  neutral: <AlertCircle />,
  success: <CheckTickCircle className="text-success" />,
  warning: <AlertTriangle className="text-warning" />,
  danger: <AlertTriangle />,
};

const Callout: Renderer = ({ props }) => {
  const tone = toneOf(props['tone']);
  return (
    <Alert variant={tone === 'danger' ? 'destructive' : 'default'}>
      {calloutIcon[tone]}
      <AlertTitle className="font-semibold">{str(props['title'])}</AlertTitle>
      {props['text'] ? <AlertDescription className="text-[length:inherit] leading-[inherit]">{str(props['text'])}</AlertDescription> : null}
    </Alert>
  );
};

const FileRef: Renderer = ({ props }) => {
  const line = typeof props['line'] === 'number' ? `:${props['line']}` : '';
  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <code>{str(props['path'])}{line}</code>
      {props['note'] ? <span className="text-muted-foreground">{str(props['note'])}</span> : null}
    </div>
  );
};

const BarChart: Renderer = ({ props }) => {
  const labels = strings(props['labels']);
  const series = (Array.isArray(props['series']) ? props['series'] : [])
    .map(childProps)
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)
    .map((entry, index) => ({
      key: `s${index}`,
      name: str(entry['name']),
      values: Array.isArray(entry['values']) ? entry['values'].map(Number) : [],
    }));
  // The theme's five chart tokens, starting from the SECOND: the first is a light
  // grey that barely shows on a light card. A sixth series wraps round.
  const config: ChartConfig = Object.fromEntries(series.map((entry, index) =>
    [entry.key, { label: entry.name, color: `var(--chart-${((index + 1) % 5) + 1})` }]));
  const data = labels.map((label, row) =>
    Object.fromEntries([['label', label], ...series.map(entry => [entry.key, entry.values[row] ?? 0])]));
  return (
    <ChartContainer config={config} className="aspect-auto h-56 w-full">
      <RechartsBarChart data={data} accessibilityLayer>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} />
        <ChartTooltip content={<ChartTooltipContent />} />
        {series.map(entry => <Bar key={entry.key} dataKey={entry.key} fill={`var(--color-${entry.key})`} radius={4} />)}
      </RechartsBarChart>
    </ChartContainer>
  );
};

const Actions: Renderer = ({ props, renderNode }) => (
  <div className="flex flex-wrap gap-2">{renderNode(props['items'])}</div>
);

// A click reports INTENT and nothing else. What a Reply sends, and where a Link
// opens, is decided by whoever renders the block (docs/AGENT-RESPONSES.md, actions).
const Reply: Renderer = ({ props }) => {
  const trigger = useTriggerAction();
  const label = str(props['label']);
  return (
    <Button
      size="sm"
      variant={props['primary'] === true ? 'default' : 'outline'}
      onClick={() => void trigger(str(props['message']), undefined, { type: 'relayed.reply', params: { label } })}
    >
      {label}
    </Button>
  );
};

const Link: Renderer = ({ props }) => {
  const trigger = useTriggerAction();
  const url = str(props['url']);
  return (
    <Button
      size="sm"
      variant="link"
      title={url}
      onClick={() => void trigger(str(props['label']), undefined, { type: 'relayed.link', params: { url } })}
    >
      {str(props['label'])}
    </Button>
  );
};

// Consumed by their parents (Table, BarChart); never drawn on their own.
const Consumed: Renderer = () => null;

const RENDERERS: Record<string, Renderer> = {
  Card, Stack, CardHeader, Text, Stat, Badge, Table, Col: Consumed, List, Callout,
  FileRef, BarChart, Series: Consumed, Actions, Reply, Link,
};

/**
 * The library, drawn. Fails at load, not at render, if the shared package gains
 * a component this file does not draw — a block using it would otherwise vanish
 * without a trace.
 */
export function makeUiLibrary(overrides: Partial<Record<string, Renderer>> = {}) {
  return createLibrary({
    root: ROOT,
    components: Object.values(definitions.components).map(definition => {
      const component = overrides[definition.name] ?? RENDERERS[definition.name];
      if (!component) throw new Error(`@relayed/genui component "${definition.name}" has no renderer`);
      return { ...definition, component };
    }),
  });
}

export const uiLibrary = makeUiLibrary();
