// An annotation is an ordinary link that carries a text directive (docs/ANNOTATIONS.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANCHOR_CHARS, annotationLabel, isAnnotationLink, readAnchor } from './annotations.ts';
import { annotationAddress } from './web-panels.ts';

test('an annotation is recognised by its directive, not by a scheme of our own', () => {
  // The point of the design: anything that can produce such a URL produces an
  // annotation, and anything that cannot read one still sees a link to the page.
  assert.equal(isAnnotationLink(annotationAddress('https://example.com/spec', { exact: 'a line' })), true);
  assert.equal(isAnnotationLink('https://example.com/spec'), false, 'an ordinary link is an ordinary link');
  assert.equal(isAnnotationLink('https://example.com/spec#section-3'), false, 'so is a plain fragment');
  assert.equal(isAnnotationLink(undefined), false);
});

test('only a web address can be an annotation', () => {
  // The chip is a button this app clicks, so a link it opens must be a page.
  for (const href of ['javascript:alert(1)#:~:text=x', 'file:///etc/hosts#:~:text=x', 'not a url #:~:text=x']) {
    assert.equal(isAnnotationLink(href), false, href);
  }
});

test('a quote short enough to read is left alone', () => {
  assert.equal(annotationLabel('the retry budget'), 'the retry budget');
  assert.equal(annotationLabel('  spread   over\nlines  '), 'spread over lines',
    'whitespace is collapsed, so a selection across paragraphs reads as one phrase');
});

test('a long quote is elided in the MIDDLE, keeping both ends', () => {
  // Two quotes from one page often begin identically. A trailing ellipsis makes
  // those two links indistinguishable; keeping the end tells them apart.
  const label = annotationLabel(`Retry budget exhausted after ${'x'.repeat(80)} three attempts`);
  assert.ok(label.length <= 48, `too long: ${label.length}`);
  assert.ok(label.startsWith('Retry budget'), 'the start survives');
  assert.ok(label.endsWith('attempts'), 'and so does the end');
  assert.ok(label.includes('…'));
});

test('an anchor the page reported is checked, never trusted', () => {
  // Whatever comes back crossed out of a page this app does not control, the
  // same boundary `panel-meta.ts` already treats as untrusted.
  assert.deepEqual(readAnchor({ exact: 'a quote', prefix: 'before ', suffix: ' after' }),
    { exact: 'a quote', prefix: 'before ', suffix: ' after' });
  for (const bad of [null, undefined, 'a string', 42, [], { prefix: 'only context' }, { exact: '' }, { exact: '   ' }]) {
    assert.equal(readAnchor(bad), null, JSON.stringify(bad));
  }
});

test('a page cannot make its anchor unboundedly long', () => {
  const read = readAnchor({ exact: 'a quote', prefix: 'x'.repeat(5_000), suffix: 'y'.repeat(5_000) });
  assert.equal(read?.prefix.length, ANCHOR_CHARS);
  assert.equal(read?.suffix.length, ANCHOR_CHARS);
});

test('context of the wrong type is dropped, and the quote still survives', () => {
  // The quote is the durable half. Losing it to a malformed prefix would throw
  // away the citation over the part that only improves the jump.
  assert.deepEqual(readAnchor({ exact: 'a quote', prefix: 42, suffix: null }),
    { exact: 'a quote', prefix: '', suffix: '' });
});
