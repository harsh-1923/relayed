// The wire format, and the leniency rules that keep old clients working.
//
// Most of this file is one argument: a protocol that rejects what it does not
// recognise cannot be extended without breaking every client already installed,
// and updates are opt-in, so those clients exist for months (`RELEASE.md`).
// Each test below is a specific way that could go wrong, written as a case
// rather than as a comment in the parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  readFrame, frame, Hello, Welcome, INBOUND, OUTBOUND, PROTOCOL, MIN_PROTOCOL, CLOSE,
} from './frames.ts';

test('a known frame parses to its body, with `t` stripped back out', () => {
  const read = readFrame(frame('hello', { protocol: 1, access_token: 'tok' }), INBOUND);
  assert.equal(read.kind, 'frame');
  if (read.kind !== 'frame') return;
  assert.equal(read.t, 'hello');
  assert.deepEqual(read.body, { protocol: 1, access_token: 'tok' },
    'the discriminator is envelope, not payload');
});

test('an UNKNOWN frame type is ignored, never fatal', () => {
  // Invariant 43, and the reason `readFrame` looks bodies up by `t` instead of
  // unioning them. A `z.discriminatedUnion` would return an error here, the
  // caller would treat it as malformed, and shipping any new frame type would
  // break every older client in the field.
  const read = readFrame(frame('reaction.added', { id: 'rct_1' }), INBOUND);
  assert.equal(read.kind, 'ignored');
  if (read.kind !== 'ignored') return;
  assert.equal(read.t, 'reaction.added', 'named, so the caller can count it by type');
});

test('an UNKNOWN field is dropped, and the frame still parses', () => {
  // Invariant 66, the field-level half. A server that adds a field must not
  // break a client that predates it — which is a property of `z.object`
  // stripping rather than rejecting, so it is worth asserting that we did not
  // reach for `z.strictObject` out of tidiness.
  const read = readFrame(
    frame('hello', { protocol: 1, access_token: 'tok', locale: 'en-GB', beta: true }),
    INBOUND);
  assert.equal(read.kind, 'frame');
  if (read.kind !== 'frame') return;
  assert.deepEqual(read.body, { protocol: 1, access_token: 'tok' });
});

test('a MISSING required field is malformed — leniency is not credulity', () => {
  // The line between the two rules: we tolerate what we do not know, and we do
  // not invent what we were not sent. An access token defaulting to '' would be
  // an unauthenticated connection that believed it had authenticated.
  const read = readFrame(frame('hello', { protocol: 1 }), INBOUND);
  assert.equal(read.kind, 'malformed');
  if (read.kind !== 'malformed') return;
  assert.equal(read.reason, 'bad_body:hello', 'names the frame, so a log says which');
});

test('a wrongly TYPED field is malformed, not coerced', () => {
  const read = readFrame(frame('hello', { protocol: '1', access_token: 'tok' }), INBOUND);
  assert.equal(read.kind, 'malformed');
});

test('junk that is not JSON is malformed, and does not throw', () => {
  // A socket delivers bytes from anywhere. Throwing here would take the
  // connection down on the first stray frame.
  assert.deepEqual(readFrame('{not json', INBOUND), { kind: 'malformed', reason: 'not_json' });
  assert.deepEqual(readFrame('', INBOUND), { kind: 'malformed', reason: 'not_json' });
});

test('a frame with no `t` is malformed rather than ignored', () => {
  // Distinguished from an unknown `t` deliberately: "I do not know this frame"
  // is routine and must not disturb the connection, while "this is not a frame"
  // is a broken peer and worth counting separately.
  assert.deepEqual(readFrame(JSON.stringify({ protocol: 1 }), INBOUND),
    { kind: 'malformed', reason: 'no_frame_type' });
  assert.deepEqual(readFrame(JSON.stringify([1, 2, 3]), INBOUND),
    { kind: 'malformed', reason: 'no_frame_type' });
  assert.deepEqual(readFrame(JSON.stringify(null), INBOUND),
    { kind: 'malformed', reason: 'no_frame_type' });
});

test('traceparent rides the envelope and is returned beside the body', () => {
  // It belongs to the envelope rather than to any body, because every frame may
  // carry one and no frame's meaning depends on it (OBSERVABILITY §4).
  const raw = JSON.stringify({
    t: 'hello', protocol: 1, access_token: 'tok',
    traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
  });
  const read = readFrame(raw, INBOUND);
  assert.equal(read.kind, 'frame');
  if (read.kind !== 'frame') return;
  assert.equal(read.traceparent?.startsWith('00-'), true);
  assert.deepEqual(read.body, { protocol: 1, access_token: 'tok' },
    'and does not leak into the body');
});

test('`t` and `traceparent` are reserved — a body may not declare them', () => {
  // The cost of flat frames: one namespace for envelope and body. A body that
  // declared `t` would shadow the discriminator, and the failure would be a
  // frame that routes to itself. Asserted as a property of the tables rather
  // than left as a comment nobody runs.
  for (const [name, table] of [['inbound', INBOUND], ['outbound', OUTBOUND]] as const) {
    for (const [t, schema] of Object.entries(table)) {
      const shape = (schema as z.ZodObject).shape;
      assert.equal('t' in shape, false, `${name}.${t} declares the reserved key 't'`);
      assert.equal('traceparent' in shape, false,
        `${name}.${t} declares the reserved key 'traceparent'`);
    }
  }
});

test('an object is accepted as well as a string, so tests need no round trip', () => {
  const read = readFrame({ t: 'ping' }, INBOUND);
  assert.equal(read.kind, 'frame');
});

test('the two directions are separate tables, not one', () => {
  // A server must not accept a `welcome`, and a client must not accept a
  // `hello`. One shared table would make both parse — and a client that
  // answered a `hello` would be a delightful thing to point at a server.
  assert.equal(readFrame(frame('welcome', {}), INBOUND).kind, 'ignored');
  assert.equal(readFrame(frame('hello', { protocol: 1, access_token: 't' }), OUTBOUND).kind,
    'ignored');
});

test('a welcome carrying fields this version predates still parses', () => {
  // The forward-compatibility promise, from the client's side and stated as a
  // scenario rather than as an intention: a server that starts sending
  // something new must not require a client update to be deployed first.
  //
  // THE FIXTURE HAD TO CHANGE ONCE ALREADY, which is the test working. It used
  // `spaces` as the example of a future field; the step that filled this frame
  // declared `spaces`, so it stopped being stripped and this failed. Whatever
  // is named here must be something no version has ever declared — so it is a
  // deliberately absurd one rather than the next feature anybody might add.
  const future = frame('welcome', {
    protocol: PROTOCOL, now: 1789042451238,
    actor: { id: 'act_1', handle: 'harsh', display_name: 'Harsh Sharma' },
    spaces: [{
      id: 'spc_1', kind: 'channel', name: 'engineering', slug: 'engineering',
      visibility: 'public', membership_policy: 'open', lifecycle: 'active', rev: 31,
    }],
    weather_on_the_server: 'drizzle',
    quantum_entanglement_id: 42,
  });
  const read = readFrame(future, OUTBOUND);
  assert.equal(read.kind, 'frame');
  if (read.kind !== 'frame') return;
  const body = read.body as Welcome;
  assert.equal(body.actor.handle, 'harsh');
  assert.equal(body.spaces?.[0]?.slug, 'engineering', 'declared fields survive');
  assert.equal('weather_on_the_server' in body, false, 'undeclared ones are dropped, not rejected');
  assert.equal('quantum_entanglement_id' in body, false);
});

test('hello carries no actor, workspace or device id', () => {
  // All three are claims in the verified token. A field that is present but
  // ignored is an invitation to trust it one day, so it is absent rather than
  // accepted-and-discarded — and this asserts the absence, because the flows
  // document showed two of them before this step removed them.
  const shape = Hello.shape;
  for (const forbidden of ['actor_id', 'workspace_id', 'device_id', 'org_id']) {
    assert.equal(forbidden in shape, false, `hello must not carry ${forbidden}`);
  }
});

test('the version floor is a real comparison, not a placeholder', () => {
  assert.equal(typeof PROTOCOL, 'number');
  assert.ok(MIN_PROTOCOL <= PROTOCOL, 'a floor above the current version rejects everyone');
});

test('close codes sit in the application-defined range', () => {
  // Outside 4000–4999 a code is either reserved or silently replaced by 1005,
  // and the client would lose the one piece of information the close carries.
  for (const [name, code] of Object.entries(CLOSE)) {
    assert.ok(code >= 4000 && code <= 4999, `${name} (${code}) is outside 4000–4999`);
  }
  assert.equal(new Set(Object.values(CLOSE)).size, Object.values(CLOSE).length,
    'two reasons sharing a code is a reason you cannot tell apart');
});

// ─── the envelope carries the trace, and nothing may shadow it ──────────────

test('frame() attaches a traceparent when given one, and OMITS it when not', () => {
  // A WebSocket carries no headers, so the frame is the only place trace
  // context can ride (OBSERVABILITY.md §4). Omitted rather than sent as null
  // when there is no active span: a null is a field every receiver has to know
  // to ignore, and an older server would have to be taught about it.
  const carried = JSON.parse(
    frame('op', { op_id: 'op_1' }, '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'),
  ) as Record<string, unknown>;
  assert.equal(carried['traceparent'],
    '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');

  const bare = JSON.parse(frame('op', { op_id: 'op_1' })) as Record<string, unknown>;
  assert.equal('traceparent' in bare, false, 'absent, not null');
});

test('a traceparent survives the round trip to the reader', () => {
  const read = readFrame(
    frame('hello', { protocol: 1, access_token: 'tok' },
          '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'),
    INBOUND);
  assert.equal(read.kind, 'frame');
  if (read.kind !== 'frame') return;
  assert.equal(read.traceparent,
    '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
  // And it is stripped from the body, because no body schema declares it.
  assert.equal('traceparent' in (read.body as object), false);
});

test('A BODY CANNOT SHADOW A RESERVED ENVELOPE KEY', () => {
  // The rule was documented — `t` and `traceparent` are reserved, no body may
  // use them — and was not enforced: the serialiser spread the body AFTER `t`,
  // so a body carrying `t` silently rewrote the frame type. Nothing would look
  // wrong; the frame would simply be routed somewhere else, or ignored.
  const out = JSON.parse(
    frame('op', { t: 'hello', traceparent: 'nonsense', op_id: 'op_1' }, '00-a-b-01'),
  ) as Record<string, unknown>;
  assert.equal(out['t'], 'op', 'the envelope wins');
  assert.equal(out['traceparent'], '00-a-b-01');
  assert.equal(out['op_id'], 'op_1', 'and the rest of the body is untouched');
});
