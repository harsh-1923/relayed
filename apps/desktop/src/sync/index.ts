// The sync engine. Runs as an Electron utilityProcess (DESIGN.md §5): it owns
// the database and — from Phase 2 — the WebSocket. Deliberately not the main
// process, because node:sqlite is synchronous and a catch-up batch would stall
// the UI; and deliberately not the renderer, which would make R2 impossible.
//
// Verified in Phase 0: timers here are NOT subject to Chromium's renderer
// throttling (§13.9), which is what protects the 30s heartbeat.
import { openDatabase } from './db';
import { migrate } from './migrate';
import { emit, useOtlpIfConfigured } from '@relayed/telemetry';
import { Session } from './auth/session.ts';
import { vault, openBrowser } from './main-bridge.ts';
import { deviceId } from './device.ts';

interface Request { id: number; op: string; params?: unknown }
type Reply = { id: number; ok: true; data: unknown } | { id: number; ok: false; error: string };

useOtlpIfConfigured('desktop');

const dbFile = process.env['RELAYED_DB'] ?? ':memory:';
const t0 = performance.now();
const db = openDatabase(dbFile);
const result = migrate(db);
emit('db.migrated', { from: result.from, to: result.to, duration: Math.round(performance.now() - t0) });

/** Live renderer ports. Multiple windows are normal; dead ones must be reaped. */
const ports = new Set<Electron.MessagePortMain>();

const session = new Session({
  config: { clientId: process.env['WORKOS_CLIENT_ID'] ?? '' },
  deviceId: deviceId(db),
  openBrowser,
  vault,
});

/** Push auth state to every attached renderer. */
session.onChange((state) => {
  for (const p of ports) p.postMessage({ push: 'auth:state', data: state });
});

const handlers: Record<string, (params?: unknown) => unknown | Promise<unknown>> = {
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

  // ── auth (PHASE-1-IDENTITY.md §7) ──────────────────────────────────────
  'auth.state': () => session.state,
  'auth.signIn': async () => {
    // Opens the SYSTEM browser and blocks on the loopback callback. The
    // renderer never sees a token — only the resulting state.
    await session.signIn();
    return session.state;
  },
  'auth.signOut': async () => { await session.signOut(); return session.state; },
  'auth.createWorkspace': async (params) => {
    const p = params as { workspaceName: string; handle: string };
    await session.createWorkspace(p.workspaceName, p.handle);
    return session.state;
  },
  'auth.configured': () => ({ clientId: (process.env['WORKOS_CLIENT_ID'] ?? '').slice(0, 14) || null }),
};

function attach(port: Electron.MessagePortMain) {
  ports.add(port);
  port.on('message', (e: Electron.MessageEvent) => {
    const req = e.data as Request;
    void (async () => {
      let reply: Reply;
      try {
        const handler = handlers[req.op];
        if (!handler) throw new Error(`unknown op: ${req.op}`);
        reply = { id: req.id, ok: true, data: await handler(req.params) };
      } catch (err) {
        reply = { id: req.id, ok: false, error: (err as Error).message };
      }
      port.postMessage(reply);
    })();
  });
  // A port dies when its renderer reloads or its window closes. Reaping is what
  // stops a leak across reloads (DESIGN.md §13.2).
  port.on('close', () => { ports.delete(port); });
  port.start();
  emit('sync.port.attached', { live_ports: ports.size });
}

// Restore a session at boot. Deliberately NOT awaited before ports attach:
// the UI must render from local data regardless of auth outcome (R3).
void session.restore();

process.parentPort.on('message', (e) => {
  const [port] = e.ports;
  if (port) { attach(port); return; }
  const msg = e.data as { type?: string; url?: string };
  if (msg?.type === 'auth:callback' && msg.url) {
    // Phase 1: PKCE exchange lands here. Logging only for now — the point is
    // that the URL reached the process that owns the verifier.
    console.log(JSON.stringify({ phase1: 'callback-received', url: msg.url }));
  }
});
