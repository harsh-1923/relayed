// Empty the WorkOS STAGING environment: every organization, then every user.
//
//   node --env-file=.env scripts/workos-reset-dev.mjs            # list only
//   node --env-file=.env scripts/workos-reset-dev.mjs --confirm  # delete
//   node --env-file=.env scripts/workos-reset-dev.mjs --user someone@acme.com [--confirm]
//                                   # one user only; organizations untouched
//
// For starting local testing from nothing. Pair it with a fresh local database:
// every actor points at a WorkOS user id, and ids do not come back — a user
// deleted here signs in again as a NEW user.
//
// Refuses anything but a test key. Production is a separate WorkOS environment
// with its own credentials (DEPLOY.md §3a), and this must never be one keystroke
// away from it.
/* global AbortSignal */
const key = process.env.WORKOS_API_KEY ?? '';
if (!key.startsWith('sk_test_')) {
  console.error('Refusing: WORKOS_API_KEY is not a staging (sk_test_) key.');
  process.exit(1);
}
const confirm = process.argv.includes('--confirm');
const onlyUser = (() => { const i = process.argv.indexOf('--user'); return i > 0 ? process.argv[i + 1]?.toLowerCase() : null; })();

async function call(method, path) {
  const res = await fetch(`https://api.workos.com${path}`, {
    method, headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok && res.status !== 404) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json().catch(() => null);
}

async function all(path) {
  const out = [];
  let after = null;
  do {
    const page = await call('GET', `${path}?limit=100${after ? `&after=${after}` : ''}`);
    out.push(...page.data);
    after = page.list_metadata?.after ?? null;
  } while (after);
  return out;
}

const orgs = onlyUser ? [] : await all('/organizations');
const users = (await all('/user_management/users')).filter(u => !onlyUser || u.email.toLowerCase() === onlyUser);
if (onlyUser && users.length === 0) { console.error(`No WorkOS user ${onlyUser}.`); process.exit(1); }
console.log(`${orgs.length} organizations:`);
for (const o of orgs) console.log(`  ${o.id}  ${o.name}`);
console.log(`${users.length} users:`);
for (const u of users) console.log(`  ${u.id}  ${u.email}`);

if (!confirm) {
  console.log('\nNothing deleted. Run again with --confirm to delete all of the above.');
  process.exit(0);
}

// Organizations first: deleting one removes its memberships and invitations.
// Every staging environment has a default "Test Organization" WorkOS refuses to
// delete (403). It holds no users of ours, so it is skipped rather than fatal.
let deletedOrgs = 0;
for (const o of orgs) {
  try { await call('DELETE', `/organizations/${o.id}`); deletedOrgs += 1; console.log(`deleted org  ${o.id}`); }
  catch (e) {
    if (!/Default test organizations cannot be deleted/.test(e.message)) throw e;
    console.log(`kept org     ${o.id}  (WorkOS's default test organization; not deletable)`);
  }
}
for (const u of users) { await call('DELETE', `/user_management/users/${u.id}`); console.log(`deleted user ${u.id}`); }
console.log(`\nDone: deleted ${deletedOrgs} organizations and ${users.length} users.`);
