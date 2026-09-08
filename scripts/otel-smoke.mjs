// Proves the local observability loop works: sends one trace, one metric and
// one log over OTLP/HTTP, then reads each back from Tempo, Prometheus and Loki.
//
//   pnpm obs:up && pnpm obs:smoke
//
// Uses OTLP's JSON encoding directly — no SDK — so this verifies the collector
// and backends, not our instrumentation. Run it before debugging "why is my
// telemetry not showing up": if this passes, the problem is in the app.
const OTLP    = process.env.OTLP_HTTP ?? 'http://localhost:4318';
const TEMPO   = process.env.TEMPO_URL ?? 'http://localhost:3200';
const PROM    = process.env.PROM_URL  ?? 'http://localhost:9090';
const GRAFANA = process.env.GRAFANA_URL ?? 'http://localhost:3000';

const hex = n => [...crypto.getRandomValues(new Uint8Array(n))]
  .map(b => b.toString(16).padStart(2, '0')).join('');
const traceId = hex(16), spanId = hex(8);
const now = Date.now(), nano = String(now * 1e6);
const service = { attributes: [{ key: 'service.name', value: { stringValue: 'relayed-smoke' } }] };
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`);
};

async function post(path, body) {
  const r = await fetch(`${OTLP}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${await r.text()}`);
}

// Retry: backends index asynchronously, so a miss is not immediately a failure.
async function until(fn, tries = 30, gap = 1000) {
  for (let i = 0; i < tries; i++) {
    try { const v = await fn(); if (v) return v; } catch {}
    await sleep(gap);
  }
  return null;
}

console.log(`\nOTLP -> ${OTLP}   trace_id=${traceId}\n`);
console.log('sending:');

await post('/v1/traces', { resourceSpans: [{ resource: service, scopeSpans: [{
  scope: { name: 'otel-smoke' },
  spans: [{
    traceId, spanId, name: 'sync.op.send', kind: 3,
    startTimeUnixNano: String((now - 25) * 1e6), endTimeUnixNano: nano,
    attributes: [
      { key: 'op.kind',  value: { stringValue: 'send' } },
      { key: 'result',   value: { stringValue: 'ok' } },
    ],
    status: { code: 1 },
  }] }] }] });
check('trace posted', true);

await post('/v1/metrics', { resourceMetrics: [{ resource: service, scopeMetrics: [{
  scope: { name: 'otel-smoke' },
  metrics: [{
    name: 'relayed_smoke_ops_total',
    description: 'smoke-test counter',
    sum: {
      aggregationTemporality: 2, isMonotonic: true,
      dataPoints: [{
        asInt: '1', timeUnixNano: nano, startTimeUnixNano: String((now - 60000) * 1e6),
        // Closed-set labels only — never an unbounded id (OBSERVABILITY.md §5)
        attributes: [{ key: 'op', value: { stringValue: 'send' } },
                     { key: 'result', value: { stringValue: 'ok' } }],
      }],
    } }] }] }] });
check('metric posted', true);

await post('/v1/logs', { resourceLogs: [{ resource: service, scopeLogs: [{
  scope: { name: 'otel-smoke' },
  logRecords: [{
    timeUnixNano: nano, severityNumber: 9, severityText: 'INFO',
    body: { stringValue: 'message.sent' },
    // trace_id on the record is what correlates logs to the span above
    traceId, spanId,
    attributes: [{ key: 'chat_id', value: { stringValue: 'chat_smoke' } },
                 { key: 'byte_len', value: { intValue: '42' } }],
  }] }] }] });
check('log posted', true);

console.log('\nreading back:');

const trace = await until(async () => {
  const r = await fetch(`${TEMPO}/api/traces/${traceId}`);
  if (!r.ok) return null;
  const j = await r.json();
  return j?.batches?.length ? j : null;
});
check('trace in Tempo', !!trace, trace ? `span "${trace.batches[0].scopeSpans[0].spans[0].name}"` : '');

const metric = await until(async () => {
  const r = await fetch(`${PROM}/api/v1/query?query=relayed_smoke_ops_total`);
  const j = await r.json();
  return j?.data?.result?.length ? j.data.result[0] : null;
});
check('metric in Prometheus', !!metric,
  metric ? `${metric.metric.__name__}{op="${metric.metric.op}"} = ${metric.value[1]}` : '');

// Loki is not port-mapped by the image; query it through Grafana's datasource proxy.
const logLine = await until(async () => {
  const ds = await (await fetch(`${GRAFANA}/api/datasources`)).json();
  const loki = ds.find?.(d => d.type === 'loki');
  if (!loki) return null;
  const q = encodeURIComponent('{service_name="relayed-smoke"}');
  const end = Date.now() * 1e6, start = (Date.now() - 600000) * 1e6;
  const r = await fetch(`${GRAFANA}/api/datasources/proxy/uid/${loki.uid}` +
    `/loki/api/v1/query_range?query=${q}&start=${start}&end=${end}&limit=5`);
  if (!r.ok) return null;
  const j = await r.json();
  return j?.data?.result?.length ? j.data.result[0] : null;
});
check('log in Loki', !!logLine, logLine ? `stream ${JSON.stringify(logLine.stream.service_name ?? '')}` : '');

console.log(`\n${'─'.repeat(56)}\n${pass} passed, ${fail} failed`);
if (!fail) console.log(`\nExplore:  ${GRAFANA}/explore   (trace_id ${traceId})`);
process.exit(fail ? 1 : 0);
