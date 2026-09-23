// The permission model, tested as one (docs/MEMORY.md §5.2, §7.1).
//
// No database and no network: choosing a bank is a pure decision about a space,
// and everything worth proving is in what `banksForRun` REFUSES to return.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ulid } from '../db/ulid.ts';
import {
  bankForSpace, banksForRun, isPublicSpace, refilter,
  workspaceBank, spaceBank, personBank, type MemoryPresence, type SpacePlacement,
} from './banks.ts';

const workspace = ulid('wsp');
const other = ulid('wsp');
const alice = ulid('act');

const space = (visibility: SpacePlacement['visibility'], workspaceId = workspace): SpacePlacement =>
  ({ id: ulid('spc'), workspaceId, visibility });

/**
 * Presence claiming everything named holds memory, so these tests ask only
 * about the ACCESS decision. What happens to an EMPTY bank has its own tests.
 */
const holds = (...spaceIds: string[]): MemoryPresence =>
  ({ spacesWithMemory: new Set(spaceIds), personHasNotes: true });

test('a public space writes into the workspace bank, a private one into its own', () => {
  const open = space('public');
  const closed = space('private');
  assert.equal(bankForSpace(open), workspaceBank(workspace));
  assert.equal(bankForSpace(closed), spaceBank(closed.id));
});

test('a DM is not public — NULL visibility gets its own bank', () => {
  // The trap AGENTS.md keeps a table about: `NOT private` would let NULL
  // through, and a DM's facts would land in the workspace bank where every
  // member of the workspace could recall them.
  const dm = space(null);
  assert.equal(isPublicSpace(dm), false);
  assert.equal(bankForSpace(dm), spaceBank(dm.id));
});

test('two spaces never share a bank, and two workspaces never share one either', () => {
  const a = space('private');
  const b = space('private');
  assert.notEqual(bankForSpace(a), bankForSpace(b));
  assert.notEqual(bankForSpace(space('public', workspace)), bankForSpace(space('public', other)));
});

test('a bank id fits — 63 characters is what Hindsight was probed to accept', () => {
  for (const id of [workspaceBank(workspace), spaceBank(ulid('spc')), personBank(alice)]) {
    assert.ok(id.length <= 63, `${id} is ${id.length} characters`);
  }
});

test('a run in a public space reads the workspace and person banks, and no space bank', () => {
  const open = space('public');
  const banks = banksForRun(open, alice, [open.id], holds(open.id));
  assert.deepEqual(banks.map((bank) => bank.id), [workspaceBank(workspace), personBank(alice)]);
});

test('a run in a private space reads its own bank as well', () => {
  const closed = space('private');
  const banks = banksForRun(closed, alice, [], holds(closed.id));
  assert.deepEqual(banks.map((bank) => bank.id),
                   [workspaceBank(workspace), spaceBank(closed.id), personBank(alice)]);
});

test('a run never reads another space’s bank, however public that space is', () => {
  const closed = space('private');
  const elsewhere = space('public');
  const ids = banksForRun(closed, alice, [elsewhere.id], holds(closed.id, elsewhere.id)).map((bank) => bank.id);
  assert.ok(!ids.includes(spaceBank(elsewhere.id)));
});

test('a job — an ambient answer with no invoker — reads no person bank at all, even when notes exist', () => {
  // AMBIENT-RESPONSES.md, whose authority §5; invariant 92. Presence here says
  // the person bank holds notes, so only the NULL invoker keeps it out.
  const closed = space('private');
  for (const banks of [banksForRun(closed, null, [], holds(closed.id)), banksForRun(space('public'), null, [], holds())]) {
    assert.ok(banks.every((bank) => !bank.id.startsWith(personBank(''))),
      `no person bank, got ${banks.map((bank) => bank.id).join(', ')}`);
  }
  // Exactly what a run there reads, less the person bank.
  assert.deepEqual(banksForRun(closed, null, [], holds(closed.id)).map((bank) => bank.id),
                   [workspaceBank(workspace), spaceBank(closed.id)]);
});

test('a run never reads another person’s bank', () => {
  const bob = ulid('act');
  const privateSpace = space('private');
  const ids = banksForRun(privateSpace, alice, [], holds(privateSpace.id)).map((bank) => bank.id);
  assert.ok(!ids.includes(personBank(bob)));
  assert.ok(ids.includes(personBank(alice)));
});

test('the workspace bank is filtered to the live public list, and only that list', () => {
  const open = space('public');
  const alsoOpen = space('public');
  const banks = banksForRun(open, alice, [open.id, alsoOpen.id], holds(open.id, alsoOpen.id));
  const workspaceEntry = banks.find((bank) => bank.id === workspaceBank(workspace));
  assert.deepEqual(workspaceEntry?.tags, [`space:${open.id}`, `space:${alsoOpen.id}`]);
});

test('a space that has just gone private drops out of the tag list, with no job run', () => {
  // The enforcement in §8.2: the list is read per recall, so the only thing
  // that has to happen is the `spaces` row changing.
  const converted = space('private');
  const stillOpen = space('public');
  const banks = banksForRun(stillOpen, alice, [stillOpen.id], holds(stillOpen.id, converted.id));
  const tags = banks.find((bank) => bank.id === workspaceBank(workspace))?.tags ?? [];
  assert.ok(!tags.includes(`space:${converted.id}`));
});

// ─── The re-filter, which is enforcement rather than hardening ──────────────

test('the re-filter drops a fact whose tags are not in the allowed set', () => {
  const allowed = { id: workspaceBank(workspace), tags: ['space:spc_A'] };
  const facts = [
    { tags: ['space:spc_A'], text: 'kept' },
    { tags: ['space:spc_B'], text: 'dropped' },
    { tags: [], text: 'dropped — untagged' },
  ];
  assert.deepEqual(refilter(facts, allowed).map((fact) => fact.text), ['kept']);
});

test('the re-filter passes everything when the bank itself is the boundary', () => {
  // A space bank carries no tag filter: the bank IS the boundary there, and
  // filtering to nothing would be a bug, not caution.
  const facts = [{ tags: [] }, { tags: ['chat:cht_1'] }];
  assert.equal(refilter(facts, { id: spaceBank(ulid('spc')), tags: [] }).length, 2);
});

test('a fact tagged with one allowed space among several is kept', () => {
  const allowed = { id: workspaceBank(workspace), tags: ['space:spc_A', 'space:spc_B'] };
  const facts = [{ tags: ['space:spc_B', 'chat:cht_9'] }];
  assert.equal(refilter(facts, allowed).length, 1);
});

// ─── Visibility transitions (§8.2) ──────────────────────────────────────────

test('a room keeps its own memory after going private', () => {
  // Its facts are in the WORKSPACE bank, tagged with its id, because it was
  // public when they were written. Dropping out of the public list is what
  // stops every other space recalling them — and would stop the room itself
  // too, silently, at the moment it was made more private.
  const converted = space('private');
  const stillOpen = space('public');
  const tags = banksForRun(converted, alice, [stillOpen.id], holds(stillOpen.id, converted.id))
    .find((bank) => bank.id === workspaceBank(workspace))?.tags ?? [];
  assert.ok(tags.includes(`space:${converted.id}`), 'its own facts stay readable to it');
  assert.ok(tags.includes(`space:${stillOpen.id}`));
});

test('nobody else can reach a converted room’s facts', () => {
  const converted = space('private');
  const elsewhere = space('public');
  const tags = banksForRun(elsewhere, alice, [elsewhere.id], holds(elsewhere.id, converted.id))
    .find((bank) => bank.id === workspaceBank(workspace))?.tags ?? [];
  assert.ok(!tags.includes(`space:${converted.id}`));
});

test('a public space is not listed twice when it is already in the live list', () => {
  const open = space('public');
  const tags = banksForRun(open, alice, [open.id], holds(open.id))
    .find((bank) => bank.id === workspaceBank(workspace))?.tags ?? [];
  assert.deepEqual(tags, [`space:${open.id}`]);
});

test('a private space reads its own bank AND its own tag in the workspace bank', () => {
  // Facts written while it was private are in its own bank; facts written while
  // it was public are in the workspace bank under its tag. Both are its own.
  const closed = space('private');
  const banks = banksForRun(closed, alice, [], holds(closed.id));
  assert.ok(banks.some((bank) => bank.id === spaceBank(closed.id)));
  assert.ok(banks.find((bank) => bank.id === workspaceBank(workspace))?.tags
    .includes(`space:${closed.id}`));
});

// ─── A bank with nothing in it is never opened (§7.1) ───────────────────────

const empty: MemoryPresence = { spacesWithMemory: new Set(), personHasNotes: false };

test('a workspace that has ingested nothing opens no banks at all', () => {
  // Measured: a recall against a never-written bank costs 1.8 s for a space and
  // 7.5 s for a person, to return nothing — more than the deadline the banks
  // with content are working to.
  assert.deepEqual(banksForRun(space('public'), alice, [], empty), []);
});

test('a private space with no memory of its own reads no space bank', () => {
  const closed = space('private');
  const open = space('public');
  const banks = banksForRun(closed, alice, [open.id], holds(open.id));
  assert.ok(!banks.map((bank) => bank.id).includes(spaceBank(closed.id)),
            'nothing has ever been ingested there, so there is nothing to open');
  assert.ok(banks.map((bank) => bank.id).includes(workspaceBank(workspace)));
});

test('the person bank is skipped until something has been remembered', () => {
  const open = space('public');
  const presence: MemoryPresence = { spacesWithMemory: new Set([open.id]), personHasNotes: false };
  const ids = banksForRun(open, alice, [open.id], presence).map((bank) => bank.id);
  assert.ok(!ids.includes(personBank(alice)));

  const withNotes = { ...presence, personHasNotes: true };
  assert.ok(banksForRun(open, alice, [open.id], withNotes).map((bank) => bank.id)
    .includes(personBank(alice)));
});

test('a private space that WAS public still reads the workspace bank, tagged only with itself', () => {
  // Its facts are in the workspace bank because it was public when they were
  // written (§8.2). No other space has memory, so the tag list is exactly its
  // own id — which is the narrowest the workspace bank is ever opened at.
  const converted = space('private');
  const banks = banksForRun(converted, alice, [], holds(converted.id));
  assert.deepEqual(banks.find((bank) => bank.id === workspaceBank(workspace))?.tags,
                   [`space:${converted.id}`]);
});

test('the workspace bank is dropped rather than opened unfiltered', () => {
  // An empty tag list means "no filter" to any_strict, which would read every
  // space in the workspace. Dropping the bank is the only safe empty case —
  // and it happens when nothing readable holds anything.
  const closed = space('private');
  const presence: MemoryPresence = { spacesWithMemory: new Set(), personHasNotes: true };
  const banks = banksForRun(closed, alice, [], presence);
  assert.deepEqual(banks.map((bank) => bank.id), [personBank(alice)]);
});

test('a public space whose ONLY memory is another space still reads it', () => {
  const open = space('public');
  const other = space('public');
  const tags = banksForRun(open, alice, [open.id, other.id], holds(other.id))
    .find((bank) => bank.id === workspaceBank(workspace))?.tags ?? [];
  assert.deepEqual(tags, [`space:${other.id}`]);
});
