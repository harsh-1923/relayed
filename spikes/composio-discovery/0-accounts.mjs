// Who has an ACTIVE GitHub or Notion account at Composio right now — the spike
// needs one connected person and one not.
import { api, save } from './lib.mjs';

const r = await api('GET', '/connected_accounts?toolkit_slugs=github,notion&limit=50');
const rows = (r.body.items ?? []).map(a => ({
  id: a.id, user_id: a.user_id, toolkit: a.toolkit?.slug, status: a.status, created_at: a.created_at,
}));
save('0-accounts', { status: r.status, rows });
console.log(r.status, rows);
