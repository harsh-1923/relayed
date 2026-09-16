// The rules for web pages inside panels (docs/PANELS.md, web pages).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addressFromTyped, annotationAddress, isWebUrl, webPanelPartition, withoutFragmentDirective,
} from './web-panels.ts';

test('what is typed in an address bar becomes an address, or a search', () => {
  assert.equal(addressFromTyped('  '), null);
  assert.equal(addressFromTyped('youtube.com'), 'https://youtube.com');
  assert.equal(addressFromTyped('www.youtube.com/watch?v=1'), 'https://www.youtube.com/watch?v=1');
  assert.equal(addressFromTyped('localhost:5173'), 'http://localhost:5173');
  assert.equal(addressFromTyped('127.0.0.1:8080/x'), 'http://127.0.0.1:8080/x');
  assert.equal(addressFromTyped('http://example.com'), 'http://example.com');
  assert.equal(addressFromTyped('youtube'), 'https://www.google.com/search?q=youtube');
  assert.equal(addressFromTyped('how to use electron.js'), 'https://www.google.com/search?q=how%20to%20use%20electron.js');
  // Another scheme is left as typed, for the caller to refuse.
  assert.equal(addressFromTyped('file:///etc/hosts'), 'file:///etc/hosts');
});

test('a panel shows http and https pages, and no other scheme', () => {
  assert.equal(isWebUrl('http://localhost:5173/'), true);
  assert.equal(isWebUrl('https://example.com/a?b#c'), true);
  for (const url of ['file:///etc/passwd', 'relayed-blob://abc', 'relayed://auth', 'javascript:alert(1)', 'about:blank', 'not a url', 42, null]) {
    assert.equal(isWebUrl(url), false, String(url));
  }
});

test('each account browses in its own persistent session', () => {
  assert.equal(webPanelPartition('acc_A'), 'persist:panels:acc_A');
  assert.notEqual(webPanelPartition('acc_A'), webPanelPartition('acc_B'));
});

// ─── Annotations (docs/ANNOTATIONS.md, navigating to an annotation) ──────────

test('an annotation becomes an address the browser scrolls to', () => {
  assert.equal(
    annotationAddress('https://example.com/spec', { exact: 'the retry budget' }),
    'https://example.com/spec#:~:text=the%20retry%20budget');
  assert.equal(
    annotationAddress('https://example.com/spec', { exact: 'the retry budget', prefix: 'agreed', suffix: 'then' }),
    'https://example.com/spec#:~:text=agreed-,the%20retry%20budget,-then');
});

test('the directive\'s own syntax characters are encoded, not left to be read as syntax', () => {
  // `,` and `&` separate terms and `-` is half of the prefix and suffix
  // markers. A quote containing them must not be able to restructure the
  // directive it is being put into.
  const built = annotationAddress('https://example.com/x', { exact: 'A-B, C & D' });
  assert.equal(built, 'https://example.com/x#:~:text=A%2DB%2C%20C%20%26%20D');
  assert.ok(!built.slice(built.indexOf('text=')).includes('-,'), 'no prefix marker appeared out of the quote');
});

test('a quote is collapsed the way the browser compares it', () => {
  // A selection across two paragraphs carries the newline between them; the
  // directive matches against text the browser has already collapsed.
  assert.equal(
    annotationAddress('https://example.com/x', { exact: 'first line\n\n  second line  ' }),
    'https://example.com/x#:~:text=first%20line%20second%20line');
});

test('non-Latin text survives', () => {
  assert.equal(
    annotationAddress('https://example.com/x', { exact: '重試預算' }),
    `https://example.com/x#:~:text=${encodeURIComponent('重試預算')}`);
});

test('a quote too long for an address is named by its two ends', () => {
  const long = `${'alpha '.repeat(40)}OMEGA`;
  const built = annotationAddress('https://example.com/x', { exact: long });
  const directive = built.slice(built.indexOf('text=') + 'text='.length);
  const [start, end] = directive.split(',');
  assert.ok(start && end, 'two terms, so the browser matches the range between them');
  assert.ok(built.length < 400, `the address stays sane: ${built.length}`);
  assert.ok(decodeURIComponent(end).endsWith('OMEGA'), 'the second term is the end of the quote');
  assert.ok(!decodeURIComponent(start).endsWith(' '), 'terms are cut at whole words');
});

test('a page that already has a fragment keeps it, and the directive follows inside it', () => {
  // ONE `#`, then `:~:`. The directive is part of the same fragment, not a
  // second one — everything from `:~:` on belongs to the browser and is hidden
  // from the page, so `#section-3` still takes the reader to that section.
  assert.equal(
    annotationAddress('https://example.com/x#section-3', { exact: 'a line' }),
    'https://example.com/x#section-3:~:text=a%20line');
});

test('re-anchoring a page that already carries a directive replaces it', () => {
  const once = annotationAddress('https://example.com/x', { exact: 'first' });
  assert.equal(annotationAddress(once, { exact: 'second' }), 'https://example.com/x#:~:text=second');
});

test('an empty quote leaves the address alone rather than building a directive that matches everything', () => {
  assert.equal(annotationAddress('https://example.com/x', { exact: '   ' }), 'https://example.com/x');
});

test('a person is never shown the directive', () => {
  // Main's getURL() keeps it; the page's own location.href does not
  // (spikes/text-fragments). The address bar reads getURL().
  assert.equal(withoutFragmentDirective('https://example.com/x#:~:text=a%20line'), 'https://example.com/x');
  assert.equal(withoutFragmentDirective('https://example.com/x#section-3#:~:text=a'), 'https://example.com/x#section-3');
  assert.equal(withoutFragmentDirective('https://example.com/x#section-3'), 'https://example.com/x#section-3',
    'an ordinary fragment is the page\'s, and stays');
  assert.equal(withoutFragmentDirective('https://example.com/x'), 'https://example.com/x');
});
