import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localRoom, space } from '../../../../lib/navigation/destinations/destinations.fixtures.ts';
import { navigationEntriesFor } from './navigation-entries.ts';

test('no active workspace means nothing to navigate to', () => {
  assert.deepEqual(navigationEntriesFor(null, [space('channel', 'channel')], [
    localRoom('local', 'Local', '/work/local'),
  ]), []);
});

test('each kind is found by its name, its aliases and its slug', () => {
  const entries = navigationEntriesFor('workspace', [
    space('channel', 'channel', { name: 'General', visibility: 'public', slug: 'general' }),
    space('group', 'group_dm', { name: 'Ada and Lin' }),
    space('direct', 'dm', { name: 'Ada' }),
  ], []);
  const keywordsOf = (id: string) => entries.find(entry => entry.destination.id === id)?.keywords;

  assert.deepEqual(keywordsOf('p:workspace:people'), ['People', 'members']);
  assert.deepEqual(keywordsOf('p:workspace:apps:installed'), [
    'Installed apps', 'connected apps', 'connections', 'manage apps',
  ]);
  assert.deepEqual(keywordsOf('s:workspace:channel'), ['General', 'channel', 'general']);
  assert.deepEqual(keywordsOf('s:workspace:group'), ['Ada and Lin', 'group message', 'group dm']);
  assert.deepEqual(keywordsOf('s:workspace:direct'), ['Ada', 'direct message', 'dm']);
});

test('a local room is found by and shows its folder', () => {
  const [entry] = navigationEntriesFor('workspace', [], [
    localRoom('local', 'Debugger', '/Users/me/project/'),
  ]).filter(item => item.destination.group === 'local-room');
  assert.equal(entry?.detail, 'project');
  assert.deepEqual(entry?.keywords, ['Debugger', 'local room', 'room', 'project', '/Users/me/project/']);
});

test('keeps duplicate labels distinct and orders them like the sidebar', () => {
  const entries = navigationEntriesFor('workspace', [
    space('dm', 'dm', { name: 'General' }),
    space('room', 'room', { name: 'General' }),
    space('channel', 'channel', { name: 'General', visibility: 'public' }),
    space('future', 'broadcast', { name: 'General' }),
  ], [
    localRoom('local-one', 'General', '/work/one'),
    localRoom('local-two', 'General', '/work/two'),
  ]);

  assert.deepEqual(entries.map(entry => entry.destination.group), [
    'go-to', 'go-to', 'go-to', 'local-room', 'local-room', 'channel', 'room', 'dm',
  ]);
  assert.equal(new Set(entries.map(entry => entry.destination.id)).size, entries.length);
  assert.deepEqual(entries.filter(entry => entry.destination.label === 'General').map(entry => entry.destination.to), [
    '/local/s/local-one',
    '/local/s/local-two',
    '/w/workspace/s/channel',
    '/w/workspace/s/room',
    '/w/workspace/s/dm',
  ]);
});
