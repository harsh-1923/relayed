// The properties that have to hold for these avatars to be usable at all.
// Each one is here because getting it wrong is silent: nothing throws, the
// avatars just quietly stop being identities, or stop animating.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { petalAvatar } from './geometry/petals.ts';
import { eyeAvatar, EYE_MOODS } from './geometry/eyes.ts';
import { postureAt, scheduleFor } from './posture.ts';
import { activityForTool } from './activity.ts';

const SEEDS = Array.from({ length: 200 }, (_, i) => `agt_${i.toString(36)}`);

test('a seed always draws the same avatar', () => {
  for (const seed of SEEDS.slice(0, 20)) {
    assert.deepEqual(petalAvatar(seed), petalAvatar(seed));
    assert.deepEqual(eyeAvatar(seed), eyeAvatar(seed));
  }
});

test('identity survives every option', () => {
  // THE REGRESSION THIS EXISTS FOR. Colour, mood and timing once shared one
  // sequential PRNG, so passing `mood` skipped the draw that picks one from the
  // seed, shifted every later draw by one, and repainted 87% of agents the
  // moment a state was applied — an agent red at rest and yellow while working.
  // Colour is identity. No option may move it, and neither may anything else
  // the caller did not name.
  for (const seed of SEEDS) {
    const resting = eyeAvatar(seed);
    for (const mood of EYE_MOODS) {
      const posed = eyeAvatar(seed, { mood });
      assert.equal(posed.color, resting.color, `${seed} changed colour for mood ${mood}`);
      assert.equal(posed.blinkEvery, resting.blinkEvery, `${seed} changed blink for mood ${mood}`);
      assert.equal(posed.wander, resting.wander, `${seed} changed wander for mood ${mood}`);
    }
    for (const opts of [{ spacing: 20 }, { scale: 1.4 }, { spacing: 44, scale: 0.7 }]) {
      assert.equal(eyeAvatar(seed, opts).color, resting.color, `${seed} changed colour for ${JSON.stringify(opts)}`);
    }
  }

  for (const seed of SEEDS) {
    const base = petalAvatar(seed).color;
    for (const opts of [{ cuts: 1 }, { cuts: 2 }, { cuts: 3 }, { cuts: 4 }, { cuts: 5 }, { gap: 8 }, { corner: 12 }, { morph: true }]) {
      assert.equal(petalAvatar(seed, opts).color, base, `${seed} changed colour for ${JSON.stringify(opts)}`);
    }
  }
});

test('every seed produces a drawable face', () => {
  for (const seed of SEEDS) {
    const petals = petalAvatar(seed);
    assert.ok(petals.cells.length >= 2, `${seed} collapsed to ${petals.cells.length} cells`);
    assert.equal(eyeAvatar(seed).eyes.length, 2);
  }
});

test('morph frames share a point count, or the cell does not morph', () => {
  // Frames only interpolate if their paths have the same number of points. A
  // mismatch does not throw — the browser just refuses to animate, silently.
  for (const seed of SEEDS.slice(0, 50)) {
    for (const cell of petalAvatar(seed, { morph: true }).cells) {
      const counts = new Set(cell.frames.map(frame => frame.split('L').length));
      assert.equal(counts.size, 1, `${seed} emitted frames of ${[...counts]} points`);
    }
  }
});

test('the resting face leans awake', () => {
  // The half-shut moods are the worst ones to meet in bulk: a directory where a
  // third of the agents are dozing reads as a page that failed to load.
  const drowsy = SEEDS.filter(seed => ['sleepy', 'wary'].includes(eyeAvatar(seed).mood));
  assert.ok(drowsy.length / SEEDS.length < 0.2, `${drowsy.length}/${SEEDS.length} agents look asleep`);
});

test('a posture schedule never repeats back to back', () => {
  // A repeat looks like the animation has stalled, which is the one impression
  // the cycle exists to avoid.
  for (const seed of SEEDS.slice(0, 50)) {
    const { slots } = scheduleFor(seed);
    for (let i = 1; i < slots.length; i++) {
      assert.notEqual(slots[i]!.activity, slots[i - 1]!.activity, `${seed} repeats at slot ${i}`);
    }
  }
});

test('a run starts by thinking', () => {
  // Not a guess: there is always a model turn before the first tool call.
  for (const seed of SEEDS.slice(0, 50)) assert.equal(scheduleFor(seed).slots[0]!.activity, 'thinking');
});

test('the cycle never claims anything specific', () => {
  // `speaking`, `done`, `failed` and `laser` each assert something a person
  // could catch us getting wrong, so none may be invented.
  const claims = new Set(['speaking', 'done', 'failed', 'laser', 'idle', 'waiting']);
  for (const seed of SEEDS.slice(0, 50)) {
    for (const slot of scheduleFor(seed).slots) {
      assert.ok(!claims.has(slot.activity), `${seed} invented ${slot.activity}`);
    }
  }
});

test('a posture is stable for the same elapsed time', () => {
  for (const at of [0, 1500, 9000, 40_000, 1_000_000]) {
    assert.equal(postureAt('run_x', at), postureAt('run_x', at));
  }
});

test('tool names land on a posture', () => {
  assert.equal(activityForTool('find_tools'), 'searching');
  assert.equal(activityForTool('LINEAR_SEARCH_ISSUES'), 'searching');
  assert.equal(activityForTool('NOTION_GET_PAGE'), 'searching');
  assert.equal(activityForTool('call_tool'), 'working');
  assert.equal(activityForTool('GITHUB_CREATE_PR'), 'working');
  // Anything unrecognised is working, which is both safe and true.
  assert.equal(activityForTool('WHATEVER_THIS_IS'), 'working');
});
