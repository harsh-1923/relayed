// What a document is to the surfaces that read one (docs/DOCUMENTS.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { documentIdOfPanel, isEmptyDocument, isStructuralPanel, roomSummary, webAddress } from './documents.ts';

const document = (over: Record<string, unknown> = {}) => ({
  id: 'doc_1', spaceId: 'spc_1', kind: 'room_summary', title: 'Summary',
  body: '**Now.** Mid-migration.', format: 'markdown', rev: 3,
  updatedByActorId: 'act_roomkeeping', coveredThrough: null, updatedAt: 0, ...over,
});

test('a room has one summary, whatever else the space holds', () => {
  assert.equal(roomSummary([document({ kind: 'note', id: 'doc_note' }), document()])?.id, 'doc_1');
  assert.equal(roomSummary([]), null);
  assert.equal(roomSummary([document({ kind: 'note' })]), null);
});

test('empty is a room nobody has spoken in — not a document that failed to load', () => {
  assert.equal(isEmptyDocument(document({ rev: 0, body: '' })), true);
  assert.equal(isEmptyDocument(document({ rev: 0, body: 'written but never revised' })), true);
  assert.equal(isEmptyDocument(document({ rev: 2, body: '   \n  ' })), true, 'whitespace is nothing');
  assert.equal(isEmptyDocument(document()), false);
});

test('a doc panel names its document, and nothing else does', () => {
  assert.equal(documentIdOfPanel({ type: 'doc', payload: { document_id: 'doc_1' } }), 'doc_1');
  assert.equal(documentIdOfPanel({ type: 'web', payload: { document_id: 'doc_1' } }), null, 'only a doc panel');
  assert.equal(documentIdOfPanel({ type: 'doc', payload: {} }), null);
  assert.equal(documentIdOfPanel({ type: 'doc', payload: { document_id: 42 } }), null);
});

test('the room owns a doc panel: it is structural, so it has no close', () => {
  assert.equal(isStructuralPanel({ type: 'doc' }), true);
  assert.equal(isStructuralPanel({ type: 'web' }), false);
  assert.equal(isStructuralPanel({ type: 'chat' }), false);
});

// ── webAddress: what a link in a document may open ─────────────────────────
//
// The rule exists because this window has no `will-navigate` guard, and
// Tiptap's Link ships `openOnClick: true` — so before this, clicking a link in
// a summary could load that page over the app itself.

test('an ordinary web address is opened', () => {
  assert.equal(webAddress('https://linear.app/harshdev/issue/HAR-21'), 'https://linear.app/harshdev/issue/HAR-21');
  assert.equal(webAddress('http://localhost:5173/'), 'http://localhost:5173/');
});

test('a scheme that is not the web opens nothing', () => {
  // The summary is written by a model out of what people typed. None of these
  // may become something a click acts on.
  for (const href of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<script>',
                      'relayed-blob://abc', 'mailto:someone@example.com']) {
    assert.equal(webAddress(href), null, href);
  }
});

test("the app's own link forms are inert, not wrong", () => {
  // Not rendered yet (DOCUMENTS.md §5): they must do nothing rather than be
  // treated as a web address.
  assert.equal(webAddress('actor:act_01M2KZ1AS1XPPDHQ08RN98NFGZ'), null);
  assert.equal(webAddress('space:spc_01M2JA9PRJ0AR4G5936CRWB2VG'), null);
  assert.equal(webAddress('message:msg_01M2M1B4RG6FV0T5A7DKN3WZ9D'), null);
});

test('nothing, and nonsense, open nothing', () => {
  for (const href of [null, undefined, '', '   ', 'not a url', '//example.com']) {
    assert.equal(webAddress(href), null, String(href));
  }
});
