// The room's summary leads the tab strip (docs/DOCUMENTS.md §8.1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withSummaryFirst } from './useRoomSummaryTab.ts';
import type { Panel } from '../../../preload/api';

const panel = (id: string, type: string): Panel => ({
  id, spaceId: 'spc_1', type, chatId: null, payload: type === 'doc' ? { document_id: 'doc_1' } : { url: 'https://x.test' },
  title: null, openedFromChatId: null, scope: 'shared', createdAt: 0, openedAt: 0,
  createdByActorId: null, onBehalfOfActorId: null,
});

const summary = panel('pnl_summary', 'doc');
const page = panel('pnl_page', 'web');
const chat = panel('pnl_chat', 'chat');

test('the summary is first, however the person ordered their own tabs', () => {
  assert.deepEqual(withSummaryFirst([page, chat], [summary, page, chat]).map(p => p.id),
    ['pnl_summary', 'pnl_page', 'pnl_chat']);
  assert.deepEqual(withSummaryFirst([], [summary]).map(p => p.id), ['pnl_summary'],
    'and it is there when nothing else is open');
});

test('it appears once, even if `?p=` also names it', () => {
  assert.deepEqual(withSummaryFirst([page, summary], [summary, page]).map(p => p.id),
    ['pnl_summary', 'pnl_page']);
});

test('a room without one — a channel, or a room before the backfill — is left alone', () => {
  assert.deepEqual(withSummaryFirst([page], [page]).map(p => p.id), ['pnl_page']);
  assert.deepEqual(withSummaryFirst([], []), []);
});
