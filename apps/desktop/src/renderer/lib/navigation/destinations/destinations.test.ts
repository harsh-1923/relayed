import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  localRoomDestination, primaryDestinationsFor, workspaceSpaceDestination,
} from './destinations.ts';
import { localRoom, space } from './destinations.fixtures.ts';

test('no active workspace means no workspace destinations', () => {
  assert.deepEqual(primaryDestinationsFor(null), []);
  assert.equal(workspaceSpaceDestination(null, space('channel', 'channel')), null);
});

test('projects every workspace space kind with its sidebar group, icon and route', () => {
  const destinations = [
    space('channel', 'channel', { name: 'General', visibility: 'public' }),
    space('room', 'room', { name: 'Launch', visibility: 'private' }),
    space('group', 'group_dm', { name: 'Ada and Lin' }),
    space('direct', 'dm', { name: 'Ada' }),
  ].map(item => workspaceSpaceDestination('workspace', item));

  assert.deepEqual(destinations.map(destination => destination && ({
    group: destination.group,
    icon: destination.icon,
    to: destination.to,
    disabled: destination.disabled,
  })), [
    { group: 'channel', icon: 'hashtag', to: '/w/workspace/s/channel', disabled: false },
    { group: 'room', icon: 'lock', to: '/w/workspace/s/room', disabled: false },
    { group: 'group_dm', icon: 'group', to: '/w/workspace/s/group', disabled: false },
    { group: 'dm', icon: 'chat', to: '/w/workspace/s/direct', disabled: false },
  ]);
});

test('a space without its main chat stays visible but disabled', () => {
  const destination = workspaceSpaceDestination('workspace', space('arriving', 'room', {
    name: 'Still arriving', hydrated: false,
  }));
  assert.equal(destination?.disabled, true);
  assert.equal(destination?.to, '/w/workspace/s/arriving');
});

test('a local room routes at the account tier', () => {
  assert.deepEqual(localRoomDestination(localRoom('local', 'Debugger', '/Users/me/project')), {
    id: 'l:local',
    label: 'Debugger',
    group: 'local-room',
    icon: 'chat',
    to: '/local/s/local',
    disabled: false,
  });
});

test('omits a future space kind until the sidebar has a section for it', () => {
  assert.equal(workspaceSpaceDestination('workspace', space('future', 'broadcast')), null);
});
