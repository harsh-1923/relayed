// docs/WORKSPACE-AGENTS.md §4.1, the Composio connect spike.
//
// Read-only: which auth scheme does GitHub (OAuth) and Notion (also OAuth,
// as it turns out — see below) actually declare, and is there a plain
// API-key toolkit we can use for the "paste a credential" half of the spike
// without needing a second OAuth app.
import { Composio } from '@composio/core';

const apiKey = process.env.COMPOSIO_API_KEY;
if (!apiKey) throw new Error('COMPOSIO_API_KEY is not set (see .env)');

const composio = new Composio({ apiKey });

for (const slug of ['github', 'notion', 'exa', 'hackernews', 'firecrawl']) {
  try {
    const toolkit = await composio.toolkits.get(slug);
    const fields = await composio.toolkits.getAuthConfigCreationFields(slug).catch(() => null);
    console.log(`\n=== ${slug} ===`);
    console.log('name:', toolkit.name);
    console.log('auth schemes:', toolkit.authSchemes ?? toolkit.auth_schemes);
    console.log('composio-managed schemes:', toolkit.composioManagedAuthSchemes ?? toolkit.composio_managed_auth_schemes);
    if (fields) console.log('auth config creation fields:', JSON.stringify(fields, null, 1).slice(0, 500));
  } catch (err) {
    console.log(`\n=== ${slug} === FAILED: ${err.message}`);
  }
}
