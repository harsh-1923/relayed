// docs/WORKSPACE-AGENTS.md §4.1 — "What does revoke return for each?"
//
// The SDK has no method literally named `revoke`; the candidates are
// `delete()` and `updateStatus()`. This checks what each actually does to an
// ACTIVE connected account, and what each returns.
import { Composio } from '@composio/core';

const apiKey = process.env.COMPOSIO_API_KEY;
if (!apiKey) throw new Error('COMPOSIO_API_KEY is not set (see .env)');
const composio = new Composio({ apiKey });

const connectedAccountId = process.argv[2];
if (!connectedAccountId) throw new Error('usage: node 5-revoke.mjs <connected_account_id>');

const before = await composio.connectedAccounts.get(connectedAccountId);
console.log('before:', before.status);

const deleted = await composio.connectedAccounts.delete(connectedAccountId);
console.log('\ndelete() returned:', JSON.stringify(deleted, null, 1));

try {
  const after = await composio.connectedAccounts.get(connectedAccountId);
  console.log('\nget() after delete:', JSON.stringify(after, null, 1));
} catch (err) {
  console.log('\nget() after delete THROWS:', err.name, '-', err.message);
}
