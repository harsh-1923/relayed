// Q1. Can one session per PERSON (no tool list) be created with Composio's
// own connect tool, sandbox and multi-execute all off — and do the switches
// actually take? Recorded from the config Composio echoes back.
import { api, save, ALICE_NOT_CONNECTED, TOOLKITS } from './lib.mjs';

const CONNECTED = 'pg-test-71253ed2-5465-45fb-a8e1-03c216353ecc';

const config = (userId, extra = {}) => ({
  user_id: userId,
  toolkits: { enable: TOOLKITS },
  manage_connections: { enable: false },
  workbench: { enable: false },
  execute: { enable_multi_execute: false },
  ...extra,
});

const out = {};
for (const [label, userId, extra] of [
  ['not_connected', ALICE_NOT_CONNECTED, {}],
  ['connected_unpinned', CONNECTED, {}],
  ['connected_pinned', CONNECTED, { connected_accounts: { github: ['ca_C2cx4zvcBlGM'] } }],
]) {
  const r = await api('POST', '/tool_router/session', config(userId, extra));
  out[label] = {
    status: r.status, ms: r.ms,
    session_id: r.body.session_id,
    tool_router_tools: r.body.tool_router_tools,
    config: r.body.config,
    error: r.status >= 400 ? r.body : undefined,
  };
  console.log(label, r.status, `${r.ms}ms`, r.body.session_id, r.body.tool_router_tools);
}
save('1-sessions', out);
