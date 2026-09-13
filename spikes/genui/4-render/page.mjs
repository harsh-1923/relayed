// Spike 4 — the renderer in Chromium, under relayed's real CSP.
//
// Questions:
//   a. Do real stored blocks render?
//   b. Does a real streamed tool input (captured in spike 2) render progressively
//      without throwing, and settle to the same result as the stored block?
//   c. What does an invalid block look like, and where is a throwing component caught?
//   d. Does a Reply click reach relayed as a structured event?
//   e. Does the devtools auto-mount try to load from a CDN, and does the guard stop it?
/* global window, document -- runs in the browser */
import { Component, createElement as h, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Renderer } from '@openuidev/react-lang';
import { reactLibrary } from './react-library.mjs';
import { validateUi } from '../library.mjs';
import streamFixture from '../results/2-claude/stream-fixture-boundary-rules.json';
import storedTool from '../results/2-claude/tool-boundary-rules.json';
import storedInline from '../results/2-claude/inline-storage-tiers.json';

const results = { cspViolations: [], scenarios: {}, actions: [] };
window.__spike = results;
document.addEventListener('securitypolicyviolation', event => {
  results.cspViolations.push({ blocked: event.blockedURI, directive: event.violatedDirective });
});

class Boundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) { this.props.onCatch(String(error.message)); }
  render() {
    // The fallback is the stored plain text: a broken block still says what it meant.
    return this.state.error ? h('pre', { className: 'fallback' }, this.props.fallbackText) : this.props.children;
  }
}

function Block({ name, source, isStreaming = false }) {
  const record = (results.scenarios[name] ??= { onErrorCalls: 0, errorCodes: [], caughtByBoundary: null });
  const text = validateUi(source ?? '').text;
  return h('div', { className: 'message', 'data-scenario': name },
    h('div', { className: 'label' }, name),
    h(Boundary, { fallbackText: text, onCatch: message => { record.caughtByBoundary = message; } },
      h(Renderer, {
        library: reactLibrary,
        response: source,
        isStreaming,
        onError: errors => {
          record.onErrorCalls += 1;
          for (const error of errors) if (!record.errorCodes.includes(error.code)) record.errorCodes.push(error.code);
        },
        onAction: event => results.actions.push({ scenario: name, type: event.type, message: event.humanFriendlyMessage, params: event.params }),
      })));
}

function Streaming() {
  const [index, setIndex] = useState(0);
  const done = index >= streamFixture.length;
  useEffect(() => {
    if (done) {
      results.scenarios.streamed.finished = true;
      return;
    }
    const timer = setTimeout(() => setIndex(index + 1), 12);
    return () => clearTimeout(timer);
  }, [index, done]);
  results.scenarios.streamed ??= { onErrorCalls: 0, errorCodes: [], caughtByBoundary: null };
  results.scenarios.streamed.snapshots = streamFixture.length;
  const source = done ? streamFixture.at(-1) : streamFixture[index];
  return h(Block, { name: 'streamed', source, isStreaming: !done });
}

function App() {
  return h('main', null,
    h(Block, { name: 'stored-tool', source: storedTool.calls[0].source }),
    h(Block, { name: 'stored-inline', source: storedInline.calls[0].source }),
    h(Streaming),
    h(Block, { name: 'unknown-component', source: 'root = Card([h, x])\nh = CardHeader("Before the bad line")\nx = Sparkline([1, 2, 3])' }),
    h(Block, { name: 'throwing-component', source: 'root = Card([ok, bad])\nok = Text("A sibling that is fine")\nbad = Badge("boom")' }),
    h(Block, { name: 'actions', source: 'root = Card([t, a])\nt = Text("Choose")\na = Actions([r, l])\nr = Reply("Apply the fix", "Apply the one-line fix", true)\nl = Link("CI run", "https://example.com/run/42")' }),
  );
}

createRoot(document.getElementById('root')).render(h(App));

// Finish: click the Reply, then snapshot what the DOM holds.
setTimeout(() => {
  document.querySelector('[data-reply="Apply the fix"]')?.click();
  const scenario = name => document.querySelector(`[data-scenario="${name}"]`);
  results.dom = {
    storedToolRows: scenario('stored-tool')?.querySelectorAll('tbody tr').length,
    storedInlineRows: scenario('stored-inline')?.querySelectorAll('tbody tr').length,
    streamedRows: scenario('streamed')?.querySelectorAll('tbody tr').length,
    unknownComponentText: scenario('unknown-component')?.innerText.replace(/\s+/g, ' ').slice(0, 120),
    throwingComponentText: scenario('throwing-component')?.innerText.replace(/\s+/g, ' ').slice(0, 160),
    devtoolsHost: Boolean(document.querySelector('[data-openui-devtools-auto-mount]')),
    scriptTags: [...document.scripts].map(script => script.src || 'inline'),
  };
  results.complete = true;
}, 2500);
