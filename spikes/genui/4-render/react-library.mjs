// The same library, bound to React renderers.
//
// In the app these renderers are `components/ui/*`. Here they are plain markup:
// the spike is about the runtime (parsing, streaming, errors, actions, CSP), not
// about how a Stat looks.
import { createElement as h } from 'react';
import { createLibrary, useTriggerAction } from '@openuidev/react-lang';
import { library as schemaLibrary, ROOT } from '../library.mjs';

const toneClass = tone => `tone-${tone ?? 'neutral'}`;

const RENDERERS = {
  Card: ({ props, renderNode }) => h('section', { className: 'card' }, renderNode(props.children)),
  Stack: ({ props, renderNode }) =>
    h('div', { className: `stack ${props.direction === 'row' ? 'row' : 'column'}` }, renderNode(props.children)),
  CardHeader: ({ props }) =>
    h('header', null, h('strong', null, props.title), props.subtitle ? h('span', { className: 'muted' }, ` — ${props.subtitle}`) : null),
  Text: ({ props }) => h('p', { className: props.muted ? 'muted' : '' }, props.text),
  Stat: ({ props }) =>
    h('div', { className: `stat ${toneClass(props.tone)}` }, h('span', null, props.label), h('b', null, props.value)),
  // Throws on purpose for one value, to see where a render error is caught.
  Badge: ({ props }) => {
    if (props.text === 'boom') throw new Error('Badge exploded');
    return h('span', { className: `badge ${toneClass(props.tone)}` }, props.text);
  },
  Table: ({ props }) => {
    const columns = (props.columns ?? []).filter(column => column?.props);
    const rows = Math.max(0, ...columns.map(column => column.props.values?.length ?? 0));
    return h('table', null,
      h('thead', null, h('tr', null, columns.map((column, index) => h('th', { key: index }, column.props.label)))),
      h('tbody', null, Array.from({ length: rows }, (_, row) =>
        h('tr', { key: row }, columns.map((column, index) => h('td', { key: index }, column.props.values?.[row] ?? '')))),
      ));
  },
  Col: () => null,
  List: ({ props }) => h(props.ordered ? 'ol' : 'ul', null, (props.items ?? []).map((item, index) => h('li', { key: index }, item))),
  Callout: ({ props }) =>
    h('aside', { className: `callout ${toneClass(props.tone)}` }, h('b', null, props.title), props.text ? h('p', null, props.text) : null),
  FileRef: ({ props }) =>
    h('code', { className: 'file' }, `${props.path}${props.line ? `:${props.line}` : ''}`, props.note ? h('span', { className: 'muted' }, ` ${props.note}`) : null),
  BarChart: ({ props }) => {
    const series = (props.series ?? []).filter(item => item?.props);
    const max = Math.max(1, ...series.flatMap(item => item.props.values ?? []));
    return h('div', { className: 'chart' }, (props.labels ?? []).map((label, index) =>
      h('div', { key: index, className: 'bar-row' }, h('span', null, label),
        series.map((item, seriesIndex) => h('i', { key: seriesIndex, style: { width: `${((item.props.values?.[index] ?? 0) / max) * 60}%` } })))));
  },
  Series: () => null,
  Actions: ({ props, renderNode }) => h('div', { className: 'actions' }, renderNode(props.items)),
  Reply: ({ props }) => {
    const trigger = useTriggerAction();
    return h('button', {
      className: props.primary ? 'primary' : '',
      'data-reply': props.label,
      // The message is relayed's to send; the renderer only reports the intent.
      onClick: () => trigger(props.message, undefined, { type: 'relayed.reply', params: { label: props.label } }),
    }, props.label);
  },
  Link: ({ props }) => {
    const trigger = useTriggerAction();
    return h('button', { className: 'link', onClick: () => trigger(props.label, undefined, { type: 'relayed.link', params: { url: props.url } }) }, props.label);
  },
};

export const reactLibrary = createLibrary({
  root: ROOT,
  components: Object.values(schemaLibrary.components).map(definition => ({
    ...definition,
    component: RENDERERS[definition.name],
  })),
});
