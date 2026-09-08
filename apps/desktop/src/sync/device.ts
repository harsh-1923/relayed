// Stable per-install identity, generated once and kept in `meta`.
//
// A WorkOS token says who you are, never which install — so device_id is a
// claim in OUR session token (server: sessions.device_id). It scopes outbox
// dedupe and multi-device read state, and it is what makes "sign out this
// device" mean something.
import type { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function deviceId(db: DatabaseSync): string {
  const row = db.prepare("SELECT v FROM meta WHERE k = 'device_id'").get() as { v: string } | undefined;
  if (row?.v) return row.v;
  const id = 'dev_' + [...randomBytes(16)].map(b => B32[b % 32]).join('');
  db.prepare("INSERT INTO meta(k, v) VALUES('device_id', ?)").run(id);
  return id;
}
