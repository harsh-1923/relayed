// docs/WORKSPACE-AGENTS.md §4.1 — the OAuth half of the spike, against GitHub
// (swapped in for Linear per the session: easy to connect to for testing).
//
// Uses a Composio-managed auth config (Composio's own OAuth app) rather than
// creating one of ours — the right choice for a dev spike; §4.3's checklist
// reserves "our own OAuth app" for production.
import { writeFileSync } from 'node:fs';
import { Composio } from '@composio/core';

const apiKey = process.env.COMPOSIO_API_KEY;
if (!apiKey) throw new Error('COMPOSIO_API_KEY is not set (see .env)');
const composio = new Composio({ apiKey });

// A stand-in `user_id` — the invoker's actor id in the real design (§6.2).
const userId = process.argv[2] ?? 'spike_user_1';
const toolkit = process.argv[3] ?? 'github';

// Reuse an existing composio-managed auth config for this toolkit if one is
// already there from a previous run, rather than minting a new one each time.
const existing = await composio.authConfigs.list({ toolkit, isComposioManaged: true });
let authConfigId = existing.items[0]?.id;
if (!authConfigId) {
  console.log(`No composio-managed auth config for ${toolkit} yet — creating one.`);
  const created = await composio.authConfigs.create(toolkit);
  authConfigId = created.id;
}
console.log('auth_config_id:', authConfigId);

const request = await composio.connectedAccounts.link(userId, authConfigId);
console.log('connected_account_id:', request.id);
console.log('status:', request.status);
console.log('\nOpen this URL and approve the connection:\n');
console.log(request.redirectUrl);
writeFileSync('.last-request.json', JSON.stringify({ userId, toolkit, authConfigId, connectedAccountId: request.id }));

console.log('\nWaiting up to 3 minutes for it to become ACTIVE...');
try {
  const account = await request.waitForConnection(180_000);
  console.log('\nCONNECTED:');
  console.log(JSON.stringify(account, null, 1));
} catch (err) {
  console.log('\nDID NOT complete:', err.name, '-', err.message);
}
