// Regenerates schema.sql from docs/DESIGN.md so the verification always runs
// the schema of record. A committed copy would drift silently, which is exactly
// the failure this spike exists to catch.
import { readFileSync, writeFileSync } from 'node:fs';
const doc = readFileSync(new URL('../../docs/DESIGN.md', import.meta.url), 'utf8');
const blocks = [...doc.matchAll(/```sql\n([\s\S]*?)```/g)].map(m => m[1]);
const want = ['CREATE TABLE actors', 'messages_ad', 'CREATE TABLE delegations'];
const out = want.map(k => {
  const b = blocks.find(x => x.includes(k));
  if (!b) throw new Error(`no SQL block in DESIGN.md containing "${k}"`);
  return b;
});
writeFileSync(new URL('schema.sql', import.meta.url), out.join('\n'));
console.log(`schema.sql regenerated from docs/DESIGN.md (${out.join('\n').split('\n').length} lines)`);
