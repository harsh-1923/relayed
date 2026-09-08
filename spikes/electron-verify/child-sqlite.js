// Runs inside an Electron utilityProcess. Verifies node:sqlite under Electron's
// bundled Node behaves as it does standalone (DESIGN.md §15, Phase 0 item 1).
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const os = require('os');

const results = [];
const check = (name, fn, expected) => {
  try {
    const actual = fn();
    const ok = expected === undefined ? !!actual : JSON.stringify(actual) === JSON.stringify(expected);
    results.push({ name, ok, actual });
  } catch (e) { results.push({ name, ok: false, actual: `threw: ${e.message.slice(0, 70)}` }); }
};

const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'relayed-verify-')), 'v.db');
const db = new DatabaseSync(dbPath);
const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

// statement splitter that respects BEGIN…END trigger bodies
const stmts = []; let buf = '', depth = 0;
for (const line of sql.split('\n')) {
  const l = line.replace(/--.*$/, '');
  if (!l.trim() && !buf.trim()) continue;
  buf += line + '\n';
  if (/\bBEGIN\b/i.test(l)) depth++;
  if (/\bEND\s*;/i.test(l)) depth--;
  if (depth === 0 && /;\s*$/.test(l.trim())) { stmts.push(buf); buf = ''; }
}
let ok = 0, failed = 0, firstError = null;
for (const s of stmts) {
  const c = s.split('\n').filter(l => !l.trim().startsWith('--')).join('\n').trim();
  if (!c) continue;
  try { db.exec(c); ok++; } catch (e) { failed++; firstError ??= e.message.slice(0, 90); }
}

results.push({ name: `schema executes (${ok} statements)`, ok: failed === 0,
               actual: failed ? `${failed} failed: ${firstError}` : 'all ok' });

check('auto_vacuum = 2 (INCREMENTAL)',
  () => Object.values(db.prepare('SELECT * FROM pragma_auto_vacuum()').get())[0], 2);
check('journal_mode = wal',
  () => db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
check('FTS5 available + external content',
  () => db.prepare("SELECT count(*) c FROM sqlite_master WHERE name='messages_fts'").get().c, 1);
check('triggers created', () =>
  db.prepare("SELECT count(*) c FROM sqlite_master WHERE type='trigger'").get().c, 4);
check('partial indexes created', () =>
  db.prepare("SELECT count(*) c FROM sqlite_master WHERE type='index' AND sql LIKE '%WHERE%'").get().c > 0, true);

// exercise the behaviours the design depends on
check('FTS round-trip: insert -> search', () => {
  db.exec("INSERT INTO messages(id,chat_id,author_id,body,created_at,state) VALUES('m1','c1','a1','shipped it',1,'acked')");
  return db.prepare('SELECT count(*) c FROM messages_fts WHERE messages_fts MATCH ?').get('shipped').c;
}, 1);
check('FTS round-trip: delete removes from index', () => {
  db.exec("DELETE FROM messages WHERE id='m1'");
  return db.prepare('SELECT count(*) c FROM messages_fts WHERE messages_fts MATCH ?').get('shipped').c;
}, 0);
check('FTS integrity-check passes',
  () => { db.exec("INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')"); return true; }, true);
check('CHECK/NULL trap: channel w/ NULL visibility REJECTED', () => {
  try { db.exec("INSERT INTO spaces(id,org_id,workspace_id,kind,visibility,name,membership_policy,lifecycle,last_activity_at,created_at,updated_at) VALUES('s1','o','w','channel',NULL,'x','open','active',1,1,1)");
    return 'ALLOWED'; } catch { return 'BLOCKED'; }
}, 'BLOCKED');
check('unique partial index blocks 2nd default chat', () => {
  db.exec("INSERT INTO spaces(id,org_id,workspace_id,kind,visibility,name,membership_policy,lifecycle,last_activity_at,created_at,updated_at) VALUES('R','o','w','room','private','r','invite','active',1,1,1)");
  db.exec("INSERT INTO chats(id,workspace_id,space_id,kind,created_at,updated_at) VALUES('c1','w','R','default',1,1)");
  try { db.exec("INSERT INTO chats(id,workspace_id,space_id,kind,created_at,updated_at) VALUES('c2','w','R','default',1,1)");
    return 'ALLOWED'; } catch { return 'BLOCKED'; }
}, 'BLOCKED');
check('incremental_vacuum runs',
  () => { db.exec('PRAGMA incremental_vacuum(10)'); return true; }, true);

process.parentPort.postMessage({
  done: true,
  versions: { node: process.versions.node, electron: process.versions.electron,
              sqlite: db.prepare('select sqlite_version() v').get().v, v8: process.versions.v8 },
  results,
});
