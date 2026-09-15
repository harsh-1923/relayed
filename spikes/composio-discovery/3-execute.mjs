// Q3. Executing by slug on a per-person session with NO tool list. Read-only
// tools only. Results keep status, error and the SHAPE of data (its keys),
// never the data itself — it is a real person's GitHub account.
import { readFileSync } from 'node:fs';
import { api, save, ALICE_NOT_CONNECTED, TOOLKITS } from './lib.mjs';

const sessions = JSON.parse(readFileSync(new URL('./results/1-sessions.json', import.meta.url), 'utf8'));
const CONNECTED_USER = 'pg-test-71253ed2-5465-45fb-a8e1-03c216353ecc';

const shape = (body) => ({
  successful: body?.successful,
  error: body?.error ?? null,
  data_keys: body?.data && typeof body.data === 'object' ? Object.keys(body.data).slice(0, 12) : typeof body?.data,
  top_level_keys: body && typeof body === 'object' ? Object.keys(body) : typeof body,
  raw_error: body?.error?.message ?? body?.message ?? undefined,
});

async function exec(label, sessionId, tool_slug, args) {
  const r = await api('POST', `/tool_router/session/${sessionId}/execute`, { tool_slug, arguments: args });
  const row = { label, tool_slug, status: r.status, ms: r.ms, ...shape(r.body) };
  if (r.status >= 400) row.body = r.body;   // error bodies carry no account data
  console.log(label.padEnd(44), r.status, `${r.ms}ms`, JSON.stringify(row.error ?? row.raw_error ?? row.data_keys).slice(0, 160));
  return row;
}

const out = [];
const WHOAMI = 'GITHUB_GET_THE_AUTHENTICATED_USER';

// a. The earlier correction (composio.ts): unpinned fails even when ACTIVE?
out.push(await exec('a connected, unpinned session', sessions.connected_unpinned.session_id, WHOAMI, {}));
// b. Pinned, and a tool never searched for.
out.push(await exec('b connected, pinned, never searched', sessions.connected_pinned.session_id, WHOAMI, {}));
// c. Not connected at all.
out.push(await exec('c not connected', sessions.not_connected.session_id, WHOAMI, {}));
// d. A toolkit outside the session's allowlist (hackernews needs no auth).
out.push(await exec('d toolkit not enabled (hackernews)', sessions.connected_pinned.session_id, 'HACKERNEWS_GET_ITEM', { id: 1 }));
// e. Bad arguments: a required field missing.
out.push(await exec('e missing required argument', sessions.connected_pinned.session_id, 'GITHUB_GET_A_REPOSITORY', { owner: 'octocat' }));
// f. A slug that does not exist.
out.push(await exec('f made-up tool slug', sessions.connected_pinned.session_id, 'GITHUB_DO_SOMETHING_MADE_UP', {}));
// g. A real provider error: a repository that does not exist.
out.push(await exec('g provider 404', sessions.connected_pinned.session_id, 'GITHUB_GET_A_REPOSITORY', { owner: 'octocat', repo: 'this-repo-does-not-exist-relayed-spike' }));

// h. Pin an account onto an EXISTING session later (a person connects after
//    their session was created): does PATCH accept it, and does execute then work?
const fresh = await api('POST', '/tool_router/session', {
  user_id: CONNECTED_USER, toolkits: { enable: TOOLKITS },
  manage_connections: { enable: false }, workbench: { enable: false }, execute: { enable_multi_execute: false },
});
out.push(await exec('h1 fresh unpinned, before patch', fresh.body.session_id, WHOAMI, {}));
const patched = await api('PATCH', `/tool_router/session/${fresh.body.session_id}`, {
  connected_accounts: { github: ['ca_C2cx4zvcBlGM'] },
});
out.push({ label: 'h2 patch connected_accounts', status: patched.status, ms: patched.ms,
  config_accounts: patched.body?.config?.connected_accounts, error: patched.status >= 400 ? patched.body : undefined });
console.log('h2 patch connected_accounts'.padEnd(44), patched.status, JSON.stringify(patched.body?.config?.connected_accounts ?? patched.body).slice(0, 160));
out.push(await exec('h3 after patch', fresh.body.session_id, WHOAMI, {}));

// i. The not-connected person's session, patched with an account that is not
//    theirs — must be refused, or a session could be pointed at anyone's account.
const hijack = await api('PATCH', `/tool_router/session/${sessions.not_connected.session_id}`, {
  connected_accounts: { github: ['ca_C2cx4zvcBlGM'] },
});
out.push({ label: 'i1 patch someone else\'s account', status: hijack.status, error: hijack.status >= 400 ? hijack.body : undefined,
  config_accounts: hijack.body?.config?.connected_accounts });
console.log('i1 patch someone else\'s account'.padEnd(44), hijack.status, JSON.stringify(hijack.body?.config?.connected_accounts ?? hijack.body).slice(0, 200));
if (hijack.status < 400) out.push(await exec('i2 execute after that patch', sessions.not_connected.session_id, WHOAMI, {}));

save('3-execute', { user_not_connected: ALICE_NOT_CONNECTED, rows: out });
