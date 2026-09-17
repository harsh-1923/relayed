import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identityFrom } from './composio.ts';

test('who a person is, read from the shapes services answer with — and never their email', () => {
  assert.deepEqual(identityFrom({ data: { viewer: { id: 'lin_1', name: 'Harsh Sharma', email: 'h@example.com' } } }),
    { externalId: 'lin_1', name: 'Harsh Sharma', username: null });
  assert.deepEqual(identityFrom({ id: 42, login: 'harsh', name: 'Harsh', email: 'h@example.com' }),
    { externalId: '42', name: 'Harsh', username: 'harsh' });
  assert.deepEqual(identityFrom({ user: { id: 'U1', real_name: 'Harsh', handle: 'hs' } }),
    { externalId: 'U1', name: 'Harsh', username: 'hs' });
  assert.deepEqual(identityFrom({
    object: 'user', id: 'bot_1', name: 'Composio', type: 'bot',
    bot: { owner: { type: 'user', user: { object: 'user', id: 'person_1', name: 'Harsh Sharma', type: 'person', person: { email: 'h@example.com' } } } },
  }), { externalId: 'person_1', name: 'Harsh Sharma', username: null }, 'Notion: the person who owns the bot, not the bot');
  assert.equal(identityFrom({ data: { viewer: { name: 'no id' } } }), null);
  assert.equal(identityFrom('[redacted]'), null);
  assert.equal(identityFrom(undefined), null);
});
