import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressedAgent, mentionedActorIds, mentionPattern } from './mentions.ts';

test('a reference is drawn like a mention and counted as none', () => {
  const body = 'Ask [Bob](actor:act_bob); [Harsh](actor-ref:act_harsh) is on rendering.';
  assert.deepEqual(mentionedActorIds(body), ['act_bob']);

  // The badge counter's SQL pattern, as LIKE would read it.
  const like = (pattern: string) => new RegExp(`^${pattern.replaceAll('%', '.*').replaceAll('(', '\\(').replaceAll(')', '\\)')}$`);
  assert.ok(like(mentionPattern('act_bob')).test(body));
  assert.ok(!like(mentionPattern('act_harsh')).test(body), 'a reference moves no badge');
});

test('a name used as an address at the start is a mention; the word in a sentence is not', () => {
  const agents = [{ key: 'act_triage', handle: 'triage', name: 'Triage' }, { key: 'act_scribe', handle: 'scribe', name: 'Scribe' }];
  assert.equal(addressedAgent('triage, who owns the rollback script?', agents), 'act_triage');
  assert.equal(addressedAgent('Triage: what is blocking the cutover', agents), 'act_triage');
  assert.equal(addressedAgent('hey triage can you remind me which runbook covers rollback?', agents), 'act_triage');
  assert.equal(addressedAgent('hi @Scribe, notes for 0.0.2?', agents), 'act_scribe');
  assert.equal(addressedAgent('let\'s triage the flaky tests before standup', agents), null);
  assert.equal(addressedAgent('Triage the deploy failures first, then the flaky tests', agents), null, 'an imperative to the room');
  assert.equal(addressedAgent('hey triager, any news?', agents), null, 'a longer word');
  assert.equal(addressedAgent('Bob, did you merge the retry PR?', agents), null);
  // The first live test: no comma, and still asked of the agent.
  assert.equal(addressedAgent('Triage who is looking into sync engines?', agents), 'act_triage');
  assert.equal(addressedAgent('triage can you check the deploy?', agents), 'act_triage');
  assert.equal(addressedAgent('Triage is broken again, ugh', agents), null, 'about the agent, not to it');
  assert.equal(addressedAgent('Triage how-to doc is out of date', agents), null);
});
