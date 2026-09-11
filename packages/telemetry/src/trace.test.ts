// Tracing — step 13 of the sync build plan.
//
// The question a trace exists to answer is "what happened to THIS message, in
// order, across two processes". Every test here is a way that could be false:
// a lost parent, a context that does not survive an await, a link that does not
// cross the wire, a failure the trace shows as a success.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  startSpan, openSpan, annotate, mark, detached, traceparent, parseTraceparent,
  currentSpan, onSpanEnd, type FinishedSpan,
} from './trace.ts';

/** Collect every span a block produces. */
async function traced(fn: () => Promise<unknown>): Promise<FinishedSpan[]> {
  const spans: FinishedSpan[] = [];
  onSpanEnd(span => spans.push(span));
  try { await fn(); } finally { onSpanEnd(() => {}); }
  return spans;
}

const byName = (spans: FinishedSpan[], name: string): FinishedSpan =>
  spans.find(s => s.name === name) as FinishedSpan;

// ─── the tree ───────────────────────────────────────────────────────────────

test('a nested span is a CHILD, sharing the trace and naming its parent', async () => {
  const spans = await traced(async () => {
    await startSpan('outbox.send', async () => {
      await startSpan('db.write', () => {});
    });
  });

  const parent = byName(spans, 'outbox.send');
  const child = byName(spans, 'db.write');
  assert.equal(child.traceId, parent.traceId, 'one operation, one trace');
  assert.equal(child.parentSpanId, parent.spanId, 'and the tree is real');
  assert.equal(parent.parentSpanId, undefined, 'the root has no parent');
});

test('the context survives an await, so concurrent work does not cross', async () => {
  // The reason this uses AsyncLocalStorage rather than a module variable. Two
  // messages being sent at once would otherwise attribute one's database call
  // to the other's span — and the resulting trace would look plausible.
  const spans = await traced(async () => {
    await Promise.all([
      startSpan('send:a', async () => {
        await new Promise(r => setTimeout(r, 10));
        await startSpan('write:a', () => {});
      }),
      startSpan('send:b', async () => {
        await new Promise(r => setTimeout(r, 5));
        await startSpan('write:b', () => {});
      }),
    ]);
  });

  assert.equal(byName(spans, 'write:a').parentSpanId, byName(spans, 'send:a').spanId);
  assert.equal(byName(spans, 'write:b').parentSpanId, byName(spans, 'send:b').spanId);
  assert.notEqual(byName(spans, 'send:a').traceId, byName(spans, 'send:b').traceId,
    'two operations, two traces');
});

test('a span records its duration and ends when the work does', async () => {
  const spans = await traced(async () => {
    await startSpan('slow', () => new Promise(r => setTimeout(r, 25)));
  });
  assert.ok(spans[0]!.durationMs >= 20, `measured ${spans[0]!.durationMs}ms`);
});

test('`detached` breaks the parent link for work that is not part of the request',
  async () => {
    // A background sweep kicked off from a handler must not inherit the
    // request's trace, or one message's span tree contains an hour of retention
    // work and the trace view becomes unreadable.
    const spans = await traced(async () => {
      await startSpan('request', async () => {
        await detached(() => startSpan('retention.sweep', () => {}));
      });
    });
    const sweep = byName(spans, 'retention.sweep');
    assert.equal(sweep.parentSpanId, undefined);
    assert.notEqual(sweep.traceId, byName(spans, 'request').traceId);
  });

// ─── failure is recorded, not swallowed ─────────────────────────────────────

test('a span that throws is recorded as an ERROR and the error still propagates',
  async () => {
    // A trace that silently omits its failures is worse than no trace: it shows
    // a path that looks complete.
    const spans: FinishedSpan[] = [];
    onSpanEnd(span => spans.push(span));
    await assert.rejects(() => startSpan('doomed', () => {
      throw new Error('the database said no');
    }));
    onSpanEnd(() => {});

    assert.equal(spans[0]?.status, 'error');
    assert.equal(spans[0]?.error, 'the database said no');
  });

test('only the error MESSAGE is recorded, never the thrown value', async () => {
  // An error object can carry anything a caller attached to it, and a chat
  // product's most sensitive data is one careless field away from a span
  // attribute (OBSERVABILITY.md §6).
  const spans: FinishedSpan[] = [];
  onSpanEnd(span => spans.push(span));
  const carrier = Object.assign(new Error('refused'), {
    body: 'the actual private message text',
  });
  await assert.rejects(() => startSpan('leaky', () => { throw carrier; }));
  onSpanEnd(() => {});

  const serialised = JSON.stringify(spans[0]);
  assert.equal(serialised.includes('the actual private message text'), false,
    'the payload did not ride along on the error');
  assert.equal(spans[0]?.error, 'refused');
});

// ─── crossing the wire ──────────────────────────────────────────────────────

test('a traceparent round-trips, and links the two sides into ONE trace', async () => {
  // OTel propagates context through HTTP headers by itself; a WebSocket
  // provides nothing, so a frame carries it explicitly — which is why
  // `traceparent` is a reserved key on every frame envelope.
  let header: string | undefined;
  const clientSpans = await traced(async () => {
    await startSpan('client.send', () => { header = traceparent(); });
  });

  const parsed = parseTraceparent(header);
  assert.ok(parsed, 'the header parsed');
  const serverSpans = await traced(async () => {
    await startSpan('server.op', () => {}, { parent: parsed });
  });

  assert.equal(serverSpans[0]!.traceId, clientSpans[0]!.traceId,
    'the server span is in the CLIENT’s trace');
  assert.equal(serverSpans[0]!.parentSpanId, clientSpans[0]!.spanId);
});

test('a malformed traceparent starts a new trace rather than failing', async () => {
  // A header from another system — or a client three months old — must never
  // be able to fail a request. A missing link is not an error.
  for (const bad of [
    undefined, '', 'nonsense', '00-tooshort-abc-01',
    '99-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',   // version
    `00-${'0'.repeat(32)}-00f067aa0ba902b7-01`,                   // all-zero trace
    `00-4bf92f3577b34da6a3ce929d0e0e4736-${'0'.repeat(16)}-01`,   // all-zero span
  ]) {
    assert.equal(parseTraceparent(bad), undefined, `rejected: ${String(bad)}`);
  }

  const spans = await traced(async () => {
    await startSpan('server.op', () => {}, { parent: parseTraceparent('nonsense') });
  });
  assert.equal(spans[0]!.parentSpanId, undefined, 'a root, not a failure');
  assert.match(spans[0]!.traceId, /^[0-9a-f]{32}$/);
});

test('the sampled flag survives the wire', async () => {
  const parsed = parseTraceparent(
    '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00');
  assert.equal(parsed?.sampled, false, 'an unsampled parent stays unsampled');
  const on = parseTraceparent(
    '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
  assert.equal(on?.sampled, true);
});

// ─── annotations ────────────────────────────────────────────────────────────

test('annotate and mark attach to the span currently running', async () => {
  const spans = await traced(async () => {
    await startSpan('outbox.send', async () => {
      annotate({ chat_id: 'cht_eng', op_kind: 'send' });
      mark('queued');
      await new Promise(r => setTimeout(r, 5));
      mark('socket.write', { bytes: 214 });
    }, { attributes: { device: 'dev_1' } });
  });

  const span = spans[0]!;
  assert.equal(span.attributes['chat_id'], 'cht_eng');
  assert.equal(span.attributes['device'], 'dev_1', 'and the ones set at creation');
  assert.deepEqual(span.events.map(e => e.name), ['queued', 'socket.write']);
  assert.equal(span.events[1]?.attributes['bytes'], 214);
});

test('annotating outside a span is a no-op, not a crash', () => {
  // Called from a helper that is sometimes traced and sometimes not. Throwing
  // here would make instrumentation something you have to be careful about,
  // which is how it stops being added.
  assert.doesNotThrow(() => { annotate({ a: 1 }); mark('nothing'); });
  assert.equal(currentSpan(), undefined);
  assert.equal(traceparent(), undefined);
});

test('ids are the right shape for W3C trace context', async () => {
  const spans = await traced(async () => { await startSpan('root', () => {}); });
  assert.match(spans[0]!.traceId, /^[0-9a-f]{32}$/);
  assert.match(spans[0]!.spanId, /^[0-9a-f]{16}$/);
  assert.match(traceparent(spans[0]!)!, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
});

// ─── spans whose end is somewhere else ──────────────────────────────────────

test('an OPEN span ends where the work ends, not where the function returns',
  async () => {
    // The shape `startSpan` cannot express, and the shape the interesting
    // operations actually have. "Sending a message" begins when somebody
    // presses return and ends when an ack arrives over a socket — there is no
    // function whose body is that operation, so there is no callback to wrap.
    const collected: FinishedSpan[] = [];
    onSpanEnd(span => collected.push(span));
    const sending = openSpan('outbox.send', { attributes: { op_id: 'op_1' } });
    sending.mark('socket.write');
    await new Promise(r => setTimeout(r, 15));
    assert.deepEqual(collected, [], 'still open while the work is outstanding');
    sending.mark('ack');
    sending.end();
    onSpanEnd(() => {});

    const send = byName(collected, 'outbox.send');
    assert.ok(send.durationMs >= 10, `measured ${send.durationMs}ms of waiting`);
    assert.deepEqual(send.events.map(e => e.name), ['socket.write', 'ack']);
    assert.equal(send.attributes['op_id'], 'op_1');
  });

test('ending twice reports ONCE', async () => {
  // A span with a lifetime longer than a function call has more than one way to
  // end: an ack, a nack, a socket that went away, a teardown sweeping up what
  // is left. Reporting twice would count one message as two, and the second
  // duration would be measured from the same start.
  const spans = await traced(async () => {
    const span = openSpan('outbox.send');
    span.end();
    span.end('error', 'link stopped');
  });
  assert.equal(spans.length, 1);
  assert.equal(spans[0]?.status, 'ok', 'the FIRST ending is the real one');
});

test('`run` makes an open span the parent of whatever it calls', async () => {
  // How a frame written from a drain carries the send's trace: the writer reads
  // whatever span is active, and outside `run` there is nothing active at all —
  // the drain is triggered by an ack, not by a request.
  const spans = await traced(async () => {
    const send = openSpan('outbox.send');
    const carried = send.run(() => {
      void startSpan('db.write', () => {});
      return traceparent();
    });
    assert.equal(parseTraceparent(carried)?.spanId, send.spanId);
    send.end();
  });

  assert.equal(byName(spans, 'db.write').parentSpanId, byName(spans, 'outbox.send').spanId);
});

test('an open span nests under whatever was running when it was made', async () => {
  const spans = await traced(async () => {
    await startSpan('sync.connect', () => {
      const page = openSpan('directory.page');
      page.end();
    });
  });
  assert.equal(byName(spans, 'directory.page').parentSpanId,
               byName(spans, 'sync.connect').spanId);
});

test('`root: true` refuses that parent, for work that belongs to nobody', async () => {
  // A reconnect is not caused by whatever happened to be running when the
  // backoff timer fired. Inheriting that trace would file an hour of retrying
  // under one unrelated message.
  const spans = await traced(async () => {
    await startSpan('something.else', () => {
      openSpan('sync.connect', { root: true }).end();
    });
  });
  const connect = byName(spans, 'sync.connect');
  assert.equal(connect.parentSpanId, undefined);
  assert.notEqual(connect.traceId, byName(spans, 'something.else').traceId);
});

test('an open span that ends with an error records only the MESSAGE', async () => {
  const spans = await traced(async () => {
    openSpan('outbox.send').end('error', 'forbidden');
  });
  assert.equal(spans[0]?.status, 'error');
  assert.equal(spans[0]?.error, 'forbidden');
});
