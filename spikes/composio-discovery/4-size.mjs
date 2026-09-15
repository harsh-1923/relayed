// Q4. What `find_tools` would hand the model, and how big it is — against the
// raw search response, and against sending a whole toolkit's schemas.
// Tokens are estimated at bytes / 4.
import { readFileSync } from 'node:fs';
import { save } from './lib.mjs';

const raw = JSON.parse(readFileSync(new URL('./results/2-search-raw-connected.json', import.meta.url), 'utf8'));
const bytes = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');

const result = raw.results[0];
const slugs = [...result.primary_tool_slugs, ...result.related_tool_slugs];
// The proposed shape: tool names, descriptions and schemas. No plan text (it
// names tools this session cannot use), no connection details, no profile,
// no Composio session id or "call MANAGE_CONNECTIONS" guidance.
const cleaned = {
  tools: slugs.map(slug => {
    const s = raw.tool_schemas[slug];
    return {
      name: slug,
      description: s?.description ?? '',
      parameters: s?.hasFullSchema ? s.input_schema : '(filled from our catalogue)',
    };
  }),
};

const out = {
  raw_bytes: bytes(raw),
  raw_tokens_est: Math.round(bytes(raw) / 4),
  cleaned_bytes: bytes(cleaned),
  cleaned_tokens_est: Math.round(bytes(cleaned) / 4),
  tools_returned: slugs.length,
  full_schemas: slugs.filter(s => raw.tool_schemas[s]?.hasFullSchema).length,
  plan_fields_present: ['recommended_plan_steps', 'known_pitfalls', 'reference_workbench_snippets'].filter(k => k in result),
  plan_mentions_disabled_tools: JSON.stringify(result).includes('COMPOSIO_REMOTE_WORKBENCH'),
};
console.log(out);
save('4-size', out);
