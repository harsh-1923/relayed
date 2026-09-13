import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partialSource } from './partial-source.ts';

const SOURCE = 'root = Card([h])\nh = CardHeader("Say \\"hi\\"", "tab\\there é")';

test('every prefix of the streamed JSON decodes to a prefix of the source', () => {
  const json = JSON.stringify({ source: SOURCE });
  let previous = '';
  for (let cut = 0; cut <= json.length; cut++) {
    const decoded = partialSource(json.slice(0, cut));
    if (decoded === null) { assert.equal(previous, ''); continue; }
    assert.ok(SOURCE.startsWith(decoded), `prefix at ${cut}: ${JSON.stringify(decoded)}`);
    assert.ok(decoded.length >= previous.length, 'never goes backwards');
    previous = decoded;
  }
  assert.equal(previous, SOURCE, 'and the whole of it at the end');
});

test('nothing until the opening quote of source', () => {
  assert.equal(partialSource(''), null);
  assert.equal(partialSource('{"sour'), null);
  assert.equal(partialSource('{"source": '), null);
  assert.equal(partialSource('{"source": "'), '');
});

test('a cut escape or unicode sequence is held back, not guessed', () => {
  assert.equal(partialSource('{"source": "a\\'), 'a');
  assert.equal(partialSource('{"source": "a\\u00'), 'a');
  assert.equal(partialSource('{"source": "a\\u00e9'), 'aé');
});
