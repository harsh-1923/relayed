// List, or delete, Relayed's memory banks in a Hindsight account (docs/MEMORY.md).
//
//   railway run --service relayed-server node scripts/hindsight-banks.mjs
//   railway run --service relayed-server node scripts/hindsight-banks.mjs --delete --confirm
//
// Reads HINDSIGHT_BASE_URL and HINDSIGHT_API_KEY from the environment — under
// `railway run`, production's. Only banks named the way Relayed names them
// (`mem_w_`, `mem_s_`, `mem_p_`; memory/banks.ts) are touched; anything else in
// the account is listed and left alone. Deleting a bank is permanent.
const base = process.env.HINDSIGHT_BASE_URL?.replace(/\/+$/, '');
const key = process.env.HINDSIGHT_API_KEY;
const tenant = process.env.HINDSIGHT_TENANT || 'default';
if (!base || !key) { console.error('HINDSIGHT_BASE_URL and HINDSIGHT_API_KEY must be set'); process.exit(1); }

const del = process.argv.includes('--delete');
const confirmed = process.argv.includes('--confirm');
const call = async (method, path) => {
  const r = await fetch(`${base}/v1/${tenant}${path}`, { method, headers: { authorization: `Bearer ${key}` } });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
};

// Paged: `{ banks, total, limit, offset }`.
const banks = [];
for (let offset = 0; ; ) {
  const page = await call('GET', `/banks?limit=100&offset=${offset}`);
  banks.push(...page.banks.map(b => ({ id: b.bank_id, name: b.name ?? '' })));
  offset += page.banks.length;
  if (page.banks.length === 0 || offset >= page.total) break;
}
const ours = banks.filter(b => /^mem_[wsp]_/.test(b.id));
const other = banks.filter(b => !/^mem_[wsp]_/.test(b.id));

const kind = { w: 'workspace', s: 'space', p: 'person' };
console.log(`${base} (tenant ${tenant}): ${banks.length} banks, ${ours.length} Relayed`);
for (const [k, label] of Object.entries(kind)) console.log(`  ${label}: ${ours.filter(b => b.id[4] === k).length}`);
for (const b of ours) console.log(`  ${b.id}  ${b.name}`);
if (other.length) {
  console.log(`not Relayed's, never touched:`);
  for (const b of other) console.log(`  ${b.id}  ${b.name}`);
}

if (!del) process.exit(0);
if (!confirmed) { console.log('\nNothing deleted. Add --confirm to delete the Relayed banks above.'); process.exit(0); }
let n = 0;
for (const b of ours) {
  try { await call('DELETE', `/banks/${encodeURIComponent(b.id)}`); n++; console.log(`deleted ${b.id}`); }
  catch (e) { console.log(`FAILED  ${b.id}: ${e.message}`); }
}
console.log(`\nDone: deleted ${n} of ${ours.length} banks.`);
