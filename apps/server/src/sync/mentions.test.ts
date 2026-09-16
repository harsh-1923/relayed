import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mentionedActorIds, mentionPattern } from './mentions.ts';

test('a reference is drawn like a mention and counted as none', () => {
  const body = 'Ask [Bob](actor:act_bob); [Harsh](actor-ref:act_harsh) is on rendering.';
  assert.deepEqual(mentionedActorIds(body), ['act_bob']);

  // The badge counter's SQL pattern, as LIKE would read it.
  const like = (pattern: string) => new RegExp(`^${pattern.replaceAll('%', '.*').replaceAll('(', '\\(').replaceAll(')', '\\)')}$`);
  assert.ok(like(mentionPattern('act_bob')).test(body));
  assert.ok(!like(mentionPattern('act_harsh')).test(body), 'a reference moves no badge');
});
