// The rules for web pages inside panels (docs/PANELS.md, web pages).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressFromTyped, isWebUrl, webPanelPartition } from './web-panels.ts';

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
