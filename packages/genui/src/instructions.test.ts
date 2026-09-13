// What the model is told (docs/AGENT-RESPONSES.md, the instructions).
//
// These assert the parts the spikes showed matter. They do not replace the eval:
// whether a model USES the tool well is measured, not unit-tested.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHOW_UI, uiInstructions } from './instructions.ts';
import { library } from './library.ts';

const text = uiInstructions();

test('every component in the library is described to the model', () => {
  for (const name of Object.keys(library.components)) {
    assert.match(text, new RegExp(`^${name}\\(`, 'm'), `${name} has no signature line`);
  }
});

test('nothing that runs on a reader\'s machine is taught', () => {
  for (const term of ['Query(', 'Mutation(', '@Run', '@Set', '$days', 'Action(']) {
    assert.equal(text.includes(term), false, `the instructions mention ${term}`);
  }
});

test('the two rules that decided the carrier are present', () => {
  assert.match(text, /Prefer a UI block over a Markdown table/);
  assert.match(text, /Never repeat a block's contents in your text/);
});

test('OpenUI Lang is confined to the tool argument, so ordinary replies stay Markdown', () => {
  assert.match(text, /OpenUI Lang goes ONLY in the `source` argument of `show_ui`/);
  assert.doesNotMatch(text, /Inline Mode/, 'OpenUI\'s inline mode is for a dashboard being patched, not chat');
});

test('the tool description tells the model how to recover', () => {
  assert.equal(SHOW_UI.name, 'show_ui');
  assert.match(SHOW_UI.description, /If it returns errors, fix exactly those and call it again\./);
});

test('the text is stable between calls, so a prompt cache can hold it', () => {
  assert.equal(uiInstructions(), text);
});
