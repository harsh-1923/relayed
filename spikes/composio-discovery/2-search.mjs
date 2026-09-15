// Q2. Search, per person: does it find the right tool, does it report the
// connection correctly both ways, does it stay inside the session's toolkits,
// how many schemas come back full, what text would push the model toward
// Composio's own connect tool, and how slow is it.
import { readFileSync } from 'node:fs';
import { api, save } from './lib.mjs';

const sessions = JSON.parse(readFileSync(new URL('./results/1-sessions.json', import.meta.url), 'utf8'));
const NOT_CONNECTED = sessions.not_connected.session_id;
const CONNECTED = sessions.connected_pinned.session_id;
const UNPINNED = sessions.connected_unpinned.session_id;

const QUERIES = {
  issue: 'look at github issue #445 and tell me about it',
  commit: 'what was my latest commit',
  pr_review: 'review pull request #4561 and leave comments',
  notion: 'find the onboarding page in notion and summarise it',
  slack_not_enabled: 'send a message to the #eng slack channel',
  vague: 'help me with my work',
};

function summarise(body) {
  const result = body.results?.[0] ?? {};
  const schemas = Object.values(body.tool_schemas ?? {});
  return {
    primary: result.primary_tool_slugs ?? [],
    related: result.related_tool_slugs ?? [],
    toolkits: result.toolkits ?? [],
    connection: (body.toolkit_connection_statuses ?? []).map(s => ({
      toolkit: s.toolkit, has_active_connection: s.has_active_connection, status_message: s.status_message,
    })),
    full_schemas: schemas.filter(s => s.hasFullSchema).length,
    schema_refs: schemas.filter(s => !s.hasFullSchema).length,
    next_steps_guidance: body.next_steps_guidance,
    has_plan: Boolean(result.recommended_plan_steps),
    top_level_keys: Object.keys(body),
    error: body.error ?? undefined,
  };
}

const out = { by_query: {}, latency: {} };

for (const [name, use_case] of Object.entries(QUERIES)) {
  out.by_query[name] = {};
  for (const [label, sid] of [['not_connected', NOT_CONNECTED], ['connected_pinned', CONNECTED], ['connected_unpinned', UNPINNED]]) {
    const r = await api('POST', `/tool_router/session/${sid}/search`, { queries: [{ use_case }] });
    out.by_query[name][label] = { status: r.status, ms: r.ms, ...summarise(r.body) };
    console.log(name.padEnd(18), label.padEnd(19), r.status, `${r.ms}ms`, out.by_query[name][label].primary.join(','),
      JSON.stringify(out.by_query[name][label].connection.map(c => [c.toolkit, c.has_active_connection])));
  }
}

// One raw response kept, so the plan can quote the real shape. A connected
// search returns the person's whole provider profile (`current_user_info`) —
// redacted here so it never lands in the repository.
const raw = await api('POST', `/tool_router/session/${CONNECTED}/search`, { queries: [{ use_case: QUERIES.issue }] });
for (const s of raw.body.toolkit_connection_statuses ?? []) {
  if (s.current_user_info) s.current_user_info = `[redacted: ${Object.keys(s.current_user_info).length} profile fields]`;
}
save('2-search-raw-connected', raw.body);

// Latency and stability: the same query ten times.
const runs = [];
for (let i = 0; i < 10; i++) {
  const r = await api('POST', `/tool_router/session/${CONNECTED}/search`, { queries: [{ use_case: QUERIES.issue }] });
  runs.push({ ms: r.ms, primary: (r.body.results?.[0]?.primary_tool_slugs ?? []).join(',') });
}
const sorted = runs.map(r => r.ms).sort((a, b) => a - b);
out.latency = {
  runs,
  p50_ms: sorted[Math.floor(sorted.length / 2)],
  max_ms: sorted.at(-1),
  distinct_primary_sets: [...new Set(runs.map(r => r.primary))],
};
console.log('latency p50', out.latency.p50_ms, 'max', out.latency.max_ms, 'distinct results', out.latency.distinct_primary_sets);

save('2-search', out);
