// Switch a toolkit on (docs/WORKSPACE-AGENTS.md §6.6, §6.11; D10).
//
// WHICH TOOLKITS APPEAR IS OUR DECISION, made here, by hand, once — not by
// the daily catalogue refresh (`catalogue.ts`), which only keeps an already-
// enabled row's metadata current. Run it, review what it printed, commit
// nothing: this writes to the database directly, the same way a migration
// does, and leaves a reviewable line in whoever's shell history ran it.
//
//   pnpm --filter @relayed/server enable-toolkit github
//   pnpm --filter @relayed/server enable-toolkit exa      # no managed scheme — custom, no credentials of ours
import { db, pool } from '../src/db/client.ts';
import { getToolkit, createAuthConfig } from '../src/agents/composio.ts';

const slug = process.argv[2];
if (!slug) {
  console.error('usage: enable-toolkit <slug>');
  process.exit(1);
}

const toolkit = await getToolkit(slug);
if (toolkit.authConfigDetails.length === 0) {
  console.error(`${slug}: Composio reports no auth scheme at all — nothing to enable`);
  process.exit(1);
}

// A managed scheme needs no credentials of ours (development default,
// §6.11 — production wants our own app before the first real person
// connects, a later, separate step: switching an auth config only affects
// NEW connections). Anything else — a pure API-key toolkit like Exa, which
// has no shared org credential at all — is `use_custom_auth` with empty
// credentials; the person's own key is collected per connection, not here.
const managedScheme = toolkit.composioManagedAuthSchemes[0];
const scheme = managedScheme ?? toolkit.authConfigDetails[0]?.authScheme;
if (!scheme) { console.error(`${slug}: no usable auth scheme`); process.exit(1); }

const authConfig = managedScheme
  ? await createAuthConfig(slug)
  : await createAuthConfig(slug, { authScheme: scheme });

await db.insertInto('toolkits').values({
  slug, name: slug, description: '', logo_url: null, categories: [],
  auth_scheme: scheme, auth_config_id: authConfig.id, auth_managed_by: 'composio',
  enabled: true, refreshed_at: new Date(),
})
  .onConflict(oc => oc.column('slug').doUpdateSet({
    auth_scheme: scheme, auth_config_id: authConfig.id, auth_managed_by: 'composio', enabled: true,
  }))
  .execute();

console.log(`${slug}: enabled, auth_scheme=${scheme}, auth_config_id=${authConfig.id}`);
console.log('Run the catalogue refresh (or wait for the daily one) to pull its tools in.');
await pool.end();
