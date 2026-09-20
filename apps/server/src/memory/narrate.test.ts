// Turning extracted facts into a title and a paragraph (docs/MEMORY.md §14.2).
// The runtime call itself is not exercised here; the parsing and the floor are.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNarration, mechanical, buildPrompt } from './narrate.ts';

test('the shape asked for: a title, a blank line, then the paragraph', () => {
  const parsed = parseNarration(
    'Rollback before retry\n\n' +
    'The team decided to roll back the index rebuild before retrying the cutover. ' +
    'Bob Iyer owns the rollback script.');
  assert.equal(parsed?.title, 'Rollback before retry');
  assert.match(parsed.summary, /^The team decided to roll back/);
  assert.match(parsed.summary, /Bob Iyer owns the rollback script\.$/);
});

test('a model that skipped the blank line still gives a usable entry', () => {
  // Lenient on purpose: being strict here means throwing away prose already
  // paid for, and falling back to the changelog reading.
  const parsed = parseNarration('Cutover window moved\nThursday is the new window.');
  assert.equal(parsed?.title, 'Cutover window moved');
  assert.equal(parsed.summary, 'Thursday is the new window.');
});

test('markdown the rules forbade is stripped rather than shown', () => {
  const parsed = parseNarration('## **Rollback before retry**\n\n- The team rolled back.');
  assert.equal(parsed?.title, 'Rollback before retry');
  assert.equal(parsed.summary, 'The team rolled back.');
});

test('a title alone is an entry; nothing at all is not', () => {
  assert.deepEqual(parseNarration('Rollback before retry'),
    { title: 'Rollback before retry', summary: '' });
  assert.equal(parseNarration('   \n\n  '), null);
});

test('a long title is cut at a word boundary, never mid-word', () => {
  const parsed = parseNarration(`${'alpha '.repeat(40)}\n\nbody`);
  assert.ok(parsed!.title.length <= 73, parsed!.title);
  assert.ok(parsed!.title.endsWith('…'));
  assert.ok(!parsed!.title.includes('alp…'), 'cut between words');
});

test('the floor when narration could not run is the facts themselves', () => {
  // Worse than prose and never absent: losing the record of an episode because
  // a runtime was down would be the wrong trade.
  const floor = mechanical(['Decided to roll back the index rebuild first', 'Bob Iyer owns the script']);
  assert.equal(floor.title, 'Decided to roll back the index rebuild first');
  assert.equal(floor.summary, 'Decided to roll back the index rebuild first Bob Iyer owns the script');

  assert.deepEqual(mechanical([]), { title: 'A conversation', summary: '' });
});

test('the prompt carries the room, the people and the facts, and nothing else', () => {
  const prompt = buildPrompt({
    roomName: '#db-cutover',
    people: [{ id: 'act_a', name: 'Alice Rao' }, { id: 'act_b', name: 'Bob Iyer' }],
    facts: ['Decided to roll back the index rebuild first'],
  });
  assert.match(prompt, /Room: #db-cutover/);
  // The NAME AND THE LINK, so the model has no id to invent.
  assert.match(prompt, /Alice Rao → \[Alice Rao\]\(actor-ref:act_a\)/);
  assert.match(prompt, /Bob Iyer → \[Bob Iyer\]\(actor-ref:act_b\)/);
  assert.match(prompt, /- Decided to roll back the index rebuild first/);
  // No transcript. The whole reason a per-episode call is affordable is that it
  // reads five facts rather than four hundred messages.
  assert.ok(prompt.length < 600);
});

test('a title drops the room name the model prefixed it with', () => {
  // The rules forbid it and the model does it anyway, because the prompt hands
  // it the room. The reader already knows which room they are in.
  const parsed = parseNarration(
    'Relay Project Board Setup: Sync investigation and model check\n\nbody',
    'Relay Project Board Setup');
  assert.equal(parsed?.title, 'Sync investigation and model check');
});

test('a colon that is part of the title is left alone', () => {
  // Only the room's OWN name is stripped: "Postgres 16: the upgrade window" is
  // a title somebody meant to write.
  const parsed = parseNarration('Postgres 16: the upgrade window\n\nbody', '#db-cutover');
  assert.equal(parsed?.title, 'Postgres 16: the upgrade window');
});

test('a title is a phrase, so a trailing full stop goes', () => {
  assert.equal(parseNarration('Harsh started the board setup.\n\nbody')?.title,
    'Harsh started the board setup');
  // An ellipsis is not a full stop somebody forgot.
  assert.equal(parseNarration('And then…\n\nbody')?.title, 'And then…');
  assert.equal(parseNarration('Who owns the rollback?\n\nbody')?.title, 'Who owns the rollback?');
});

test('a person in the sentences keeps their chip; the title never gets one', () => {
  // A title is a phrase. A chip inside a heading is not a heading, and the
  // rules saying so is not the same as it never happening.
  const parsed = parseNarration(
    '[Harsh](actor-ref:act_1) set the launch date\n\n' +
    '[Harsh](actor-ref:act_1) set 21 September as the deadline.');
  assert.equal(parsed?.title, 'Harsh set the launch date');
  assert.equal(parsed.summary, '[Harsh](actor-ref:act_1) set 21 September as the deadline.');
});

test('a clamped summary never ends inside a mention', () => {
  // Cutting through `[Harsh](actor-ref:act_…)` leaves markup the reader sees
  // raw — worse than the few characters backing up costs.
  const long = `${'word '.repeat(150)}[Harsh Sharma](actor-ref:act_01M2YCR5R5VRN8QMNN6QB07MM8) decided.`;
  const parsed = parseNarration(`Title\n\n${long}`);
  const open = (parsed!.summary.match(/\[/g) ?? []).length;
  const close = (parsed!.summary.match(/\)/g) ?? []).length;
  assert.equal(open, close, parsed!.summary.slice(-60));
});
