// What a document is to the surfaces that read one (docs/DOCUMENTS.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { documentIdOfPanel, isEmptyDocument, isStructuralPanel, roomSummary } from './documents.ts';

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
