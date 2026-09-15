// docs/WORKSPACE-AGENTS.md §4.1 — "paste a credential" half, against Exa
// (an API_KEY-scheme toolkit, easy to get a free key for without a company
// account). Exercises the SAME link() call as OAuth; Composio's hosted page
// is what actually differs — it renders a form instead of a consent screen.
import { writeFileSync } from 'node:fs';
import { Composio } from '@composio/core';

const apiKey = process.env.COMPOSIO_API_KEY;
if (!apiKey) throw new Error('COMPOSIO_API_KEY is not set (see .env)');
const composio = new Composio({ apiKey });

const userId = process.argv[2] ?? 'spike_user_1';
const toolkit = 'exa';

// Exa has no Composio-managed credentials (there's no shared org to manage —
// every connected account IS one person's key), so this is `use_custom_auth`
// with the API_KEY scheme and no credentials of our own: the auth config just
// declares "this is how exa authenticates", and the person's own key is
// collected per connected account, at link() time, on Composio's hosted form.
const existing = await composio.authConfigs.list({ toolkit });
let authConfigId = existing.items.find(c => !c.isComposioManaged)?.id;
if (!authConfigId) {
  console.log(`No auth config for ${toolkit} yet — creating one.`);
  const created = await composio.authConfigs.create(toolkit, {
    type: 'use_custom_auth', name: 'Exa (spike)', authScheme: 'API_KEY', credentials: {},
  });
  authConfigId = created.id;
}
console.log('auth_config_id:', authConfigId);

const request = await composio.connectedAccounts.link(userId, authConfigId);
console.log('connected_account_id:', request.id);
console.log('status:', request.status);
console.log('\nOpen this URL — it should show a form asking for an Exa API key,');
console.log('with a link to where to get one:\n');
console.log(request.redirectUrl);
writeFileSync('.last-request-apikey.json', JSON.stringify({ userId, toolkit, authConfigId, connectedAccountId: request.id }));
