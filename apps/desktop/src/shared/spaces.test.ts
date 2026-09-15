// What a space link opens (spaces.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spaceLinkTarget } from './spaces.ts';

test('a space link names a space id, and nothing else counts as one', () => {
  assert.equal(spaceLinkTarget('space:spc_01M2HQ8XB94D'), 'spc_01M2HQ8XB94D');
  for (const href of [undefined, '', 'space:', 'space:cht_01M2', 'https://example.com', 'space:spc_1/../x', 'actor:act_1', 'space:spc_1 extra']) {
    assert.equal(spaceLinkTarget(href), null, String(href));
  }
});

test('a DM or group message is called by the other people in it', async () => {
  const { spaceName } = await import('./spaces.ts');
  const dm = { kind: 'dm', name: null, slug: null };
  assert.equal(spaceName(dm, ['Bob']), 'Bob');
  assert.equal(spaceName({ ...dm, kind: 'group_dm' }, ['Bob', 'Carol']), 'Bob and Carol');
  assert.equal(spaceName({ ...dm, kind: 'group_dm' }, ['Bob', 'Carol', 'Dave']), 'Bob, Carol and Dave');
  assert.equal(spaceName(dm), 'Direct message');
  assert.equal(spaceName({ ...dm, kind: 'group_dm' }), 'Group message');
  assert.equal(spaceName({ kind: 'channel', name: 'eng', slug: null }, ['Bob']), 'eng', 'names only apply to DMs');
});
