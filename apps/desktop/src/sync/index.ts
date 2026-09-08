// The sync engine. Runs as an Electron utilityProcess (DESIGN.md §5): it owns
// the database and — from Phase 2 — the WebSocket. Deliberately not the main
// process, because node:sqlite is synchronous and a catch-up batch would stall
// the UI; and deliberately not the renderer, which would make R2 impossible.
//
// Verified in Phase 0: timers here are NOT subject to Chromium's renderer
// throttling (§13.9), which is what protects the 30s heartbeat.
import { openDatabase } from './db';
import { migrate } from './migrate';
import { emit } from '@relayed/telemetry';

interface Request { id: number; op: string; params?: unknown }
type Reply = { id: number; ok: true; data: unknown } | { id: number; ok: false; error: string };

const dbFile = process.env['RELAYED_DB'] ?? ':memory:';
const t0 = performance.now();
const db = openDatabase(dbFile);
const result = migrate(db);
emit('db.migrated', { from: result.from, to: result.to, duration: Math.round(performance.now() - t0) });

/** Live renderer ports. Multiple windows are normal; dead ones must be reaped. */
const ports = new Set<Electron.MessagePortMain>();

const handlers: Record<string, (params?: unknown) => unknown> = {
  ping: () => ({ pong: true, at: Date.now() }),
  'db.info': () => {
    const uv = db.prepare('PRAGMA user_version').get() as { user_version: number };
    const av = db.prepare('SELECT * FROM pragma_auto_vacuum()').get() as Record<string, number>;
    const jm = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    const tables = db.prepare(
      "SELECT count(*) c FROM sqlite_master WHERE type='table'").get() as { c: number };
    return {
      file: dbFile,
      schemaVersion: uv.user_version,
      autoVacuum: Object.values(av)[0],
      journalMode: jm.journal_mode,
      tables: tables.c,
      sqlite: (db.prepare('select sqlite_version() v').get() as { v: string }).v,
      node: process.versions.node,
      pid: process.pid,
    };
  },
  'ports.live': () => ({ count: ports.size }),
};

function attach(port: Electron.MessagePortMain) {
  ports.add(port);
  port.on('message', (e: Electron.MessageEvent) => {
    const req = e.data as Request;
    let reply: Reply;
    try {
      const handler = handlers[req.op];
      if (!handler) throw new Error(`unknown op: ${req.op}`);
      reply = { id: req.id, ok: true, data: handler(req.params) };
    } catch (err) {
      reply = { id: req.id, ok: false, error: (err as Error).message };
    }
    port.postMessage(reply);
  });
  // A port dies when its renderer reloads or its window closes. Reaping is what
  // stops a leak across reloads (DESIGN.md §13.2).
  port.on('close', () => { ports.delete(port); });
  port.start();
  emit('sync.port.attached', { live_ports: ports.size });
}

process.parentPort.on('message', (e) => {
  const [port] = e.ports;
  if (port) attach(port);
});
