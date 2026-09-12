// `pnpm dev` — one Electron client, or several isolated ones against one server.
//
// Sync is the first phase whose behaviour cannot be SEEN with one client
// (docs/MULTI-CLIENT-DEV.md). This runs N installs from ONE build and ONE
// renderer dev server, so an edit reaches every window the way it reaches one.
//
// WHY NOT N × `electron-vite dev`: each would start its own Vite server — a
// port clash, which is solvable — and its own rollup watchers writing to the
// same `out/` directory. Two processes rewriting `out/main/index.js` while a
// third reads it is a torn build that reproduces once and never again.
//
// So: electron-vite owns the build, the watch, the renderer server and client 1.
// This owns clients 2..N, and restarts them on the SAME signal electron-vite
// restarts client 1 on.
import { spawn, execFileSync } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as p from '@clack/prompts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = join(root, 'apps', 'desktop');
const signalFile = join(desktop, 'out', '.build-signal');

/** Where the renderer dev server listens. Pinned so siblings can be told. */
const PORT = Number(process.env['RELAYED_DEV_PORT'] ?? 5273);
/** Where the API and sync socket listen. Matches apps/server/src/env.ts. */
const SERVER_PORT = Number(process.env['PORT'] ?? 8787);
/** Where the agent runtime listens. Matches apps/agent/src/env.ts. */
const AGENT_PORT = Number(process.env['AGENT_PORT'] ?? 8788);

/**
 * The agent runtime joins `pnpm dev` only once it is configured.
 *
 * It refuses to boot without a key and a provider table (docs/AGENT-RUNTIME.md
 * §5, §11) — correct for the service, wrong as a reason for the whole dev
 * environment to crash-loop before anyone has keys. So: start it when it can
 * start, say so when it cannot, and never fail `pnpm dev` over it.
 *
 * THIS READS `.env`, which is why the root script runs with
 * `--env-file-if-exists`. Every app loads `.env` itself, so the launcher never
 * needed to — until it had to decide something FROM it. Without the flag this
 * gate saw nothing, silently skipped the agent, and printed "set these in
 * .env" at someone who already had.
 */
const agentConfigured = Boolean(process.env['AGENT_S2S_KEY'] && process.env['AGENT_PROVIDERS']);
const withAgent = agentConfigured && !process.argv.includes('--no-agent');
const MAX_CLIENTS = 4;

/**
 * Refuse to start on top of something already running.
 *
 * Without this the failure is two unrelated stack traces a screen apart — an
 * `EADDRINUSE` from the server and a Vite "Port 5273 is already in use" — with
 * the actual cause (a previous run still alive) named in neither. The renderer
 * port is `strictPort` on purpose, because a sibling pointed at a port Vite
 * quietly moved renders nothing and looks like a broken build; that correctness
 * is worth keeping, and this is what makes it legible.
 *
 * It reports rather than kills. Whatever holds the port is somebody's process,
 * possibly deliberate — a server run in another terminal to watch its logs is
 * exactly the case `--no-server` exists for.
 */
function portFree(port) {
  // A CONNECT probe, not a listen probe, and the difference is not academic:
  // this guard failed to fire on a genuinely occupied port because Vite binds
  // `localhost`, which resolves to `::1`, while a `listen` probe on `127.0.0.1`
  // is a DIFFERENT address and succeeds happily beside it. The run then died
  // fifteen seconds later with the two stack traces this function exists to
  // replace.
  //
  // Connecting sidesteps the bind address entirely — if something answers on
  // either family, the port is taken. A timeout counts as free: a host that
  // neither refuses nor accepts is not the case this is protecting against, and
  // hanging the launcher on it would be worse than a clear error downstream.
  const reach = (host) => new Promise(resolve => {
    const probe = connect({ port, host });
    const settle = (answered) => { probe.destroy(); resolve(answered); };
    probe.setTimeout(500);
    probe.once('connect', () => settle(true));
    probe.once('timeout', () => settle(false));
    probe.once('error', () => settle(false));
  });
  return Promise.all([reach('127.0.0.1'), reach('::1')])
    .then(answered => !answered.some(Boolean));
}

/** What is holding a port, best effort — a pid is more use than a number. */
function holderOf(port) {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'],
                             { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const line = out.split('\n')[1];
    if (!line) return null;
    const [cmd, pid] = line.split(/\s+/);
    return `${cmd} (pid ${pid})`;
  } catch { return null; }
}

// Declared UP HERE rather than beside their users, because the client loop below
// runs at the top level and a `const` referenced before its declaration is
// evaluated is a ReferenceError, not a hoisted binding. Cost one debugging round.
const require_ = createRequire(join(desktop, 'package.json'));
/** The Electron binary the workspace resolved, not one from PATH. */
const electronBin = require_('electron');

// ── what each client calls itself, to macOS ─────────────────────────────────

/** The name one client answers to. One client is just "Relayed". */
const nameFor = (n, total) => (total === 1 ? 'Relayed' : `Relayed ${n}`);

/** Where the named copies live. Under node_modules, so it is already ignored. */
const bundleCache = join(root, 'node_modules', '.cache', 'relayed-dev-bundles');

/**
 * Give client `n` an `Electron.app` that says who it is.
 *
 * WHY NOT `app.setName`. Its contract is explicit: it "overrides the current
 * application's name used internally by Electron" and "does not affect the name
 * that the OS uses". On macOS the first submenu of the application menu ALWAYS
 * carries the application's name, taken from the running bundle's
 * `CFBundleName` — so does the Dock tile, and so does ⌘-Tab. A menu template
 * does not help either: the label you give that first submenu is ignored on
 * macOS by design. An unpackaged dev run executes Electron's own prebuilt
 * bundle, and Electron's bundle is called Electron. That is the whole of the
 * bug, and none of it is reachable from inside the process.
 *
 * So the bundle has to say it, which means a copy of the bundle per client, and
 * each client has to be POINTED AT ITS OWN — by a different knob in each case,
 * which cost a round to learn. The siblings are spawned here, so they are simply
 * given the copied binary's path. Client 1 is spawned by electron-vite, which
 * does NOT load the `electron` npm shim and therefore never reads that shim's
 * `ELECTRON_OVERRIDE_DIST_PATH`: it reads `path.txt` and joins it to the module
 * directory itself. Its own override is `ELECTRON_EXEC_PATH`, which it checks
 * first and otherwise fills in — so that is what the primary is given.
 *
 * THE COPY IS FREE, which is the only reason this belongs in a dev loop: `cp -c`
 * on APFS is a copy-on-write clone, so 307MB takes about a tenth of a second and
 * no disk at all. A non-APFS volume falls back to a real copy — which is why the
 * result is cached and stamped rather than remade every run.
 *
 * AND NOTHING IS RE-SIGNED, because nothing needs to be. Electron's dev binary
 * is ad-hoc linker-signed with `Info.plist=not bound` and no sealed resources:
 * the signature covers the Mach-O and nothing else, so editing the plist leaves
 * it exactly as valid as it was — `codesign --verify` says the same thing word
 * for word before and after. If a future Electron ships a sealed bundle the
 * symptom is a copy macOS refuses to launch, and the repair is one line:
 * `codesign --force --sign - <app>`.
 *
 * Returns a dist directory, or null to run the original bundle. This is
 * cosmetic and must never be the reason a dev loop will not start.
 */
function bundleFor(n, label) {
  if (process.platform !== 'darwin') return null;
  const suffix = join('Electron.app', 'Contents', 'MacOS', 'Electron');
  if (!electronBin.endsWith(suffix)) return null;

  const srcDist = electronBin.slice(0, -(suffix.length + 1));
  const dist = join(bundleCache, `client-${n}`);
  const bundle = join(dist, 'Electron.app');
  const stamp = join(dist, '.relayed-stamp');
  // Both halves matter: an Electron upgrade must replace the copy, and renaming
  // a client must not be answered out of a cache of the old name.
  const want = `${electronVersion()} ${label}`;

  try {
    if (readFileSync(stamp, 'utf8') === want
        && existsSync(join(bundle, 'Contents', 'MacOS', 'Electron'))) return dist;
  } catch { /* no stamp yet, or unreadable — rebuild */ }

  try {
    rmSync(dist, { recursive: true, force: true });
    mkdirSync(bundleCache, { recursive: true });
    clone(srcDist, dist);
    const plist = join(bundle, 'Contents', 'Info.plist');
    // `CFBundleName` is what the menu bar and the Dock read; `CFBundleDisplayName`
    // is what Finder and the app switcher prefer when it is present. Setting one
    // and not the other is how an app ends up with two names.
    for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
      execFileSync('plutil', ['-replace', key, '-string', label, plist]);
    }
    // Written LAST, so an interrupted copy is not mistaken for a finished one.
    writeFileSync(stamp, want);
    return dist;
  } catch (e) {
    console.error(`[dev] could not name client ${n} (${e.message}) — it will show as Electron`);
    rmSync(dist, { recursive: true, force: true });
    return null;
  }
}

/** The executable inside a named copy. */
const binIn = (dist) => join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron');

/** Clone if the filesystem can, copy if it cannot. */
function clone(src, dst) {
  try { execFileSync('cp', ['-c', '-R', src, dst], { stdio: 'ignore' }); }
  catch { execFileSync('cp', ['-R', src, dst], { stdio: 'ignore' }); }
}

/** Read from the package rather than the lockfile, which is what is installed. */
function electronVersion() {
  const pkg = join(dirname(require_.resolve('electron')), 'package.json');
  return JSON.parse(readFileSync(pkg, 'utf8')).version;
}

const stampOf = () => {
  try { return statSync(signalFile).mtimeMs; } catch { return 0; }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── how many ────────────────────────────────────────────────────────────────

const flag = process.argv.find(a => a.startsWith('--clients='));
const asked = flag ? Number(flag.slice('--clients='.length)) : null;
const interactive = asked === null && process.stdin.isTTY && !process.env['CI'];

let clients = asked ?? 1;
if (interactive) {
  p.intro('Relayed');
  const answer = await p.select({
    message: 'How many desktop clients?',
    initialValue: 1,
    options: [
      { value: 1, label: '1', hint: 'the usual loop' },
      { value: 2, label: '2', hint: 'two people, or one person on two devices' },
      { value: 3, label: '3', hint: 'both — same account twice, plus a second person' },
    ],
  });
  if (p.isCancel(answer)) { p.cancel('nothing started'); process.exit(0); }
  clients = answer;
}
if (!Number.isInteger(clients) || clients < 1 || clients > MAX_CLIENTS) {
  console.error(`--clients must be 1..${MAX_CLIENTS}`);
  process.exit(1);
}

// ── nothing may already be listening ────────────────────────────────────────

{
  const wanted = [
    { port: PORT, what: 'the renderer dev server' },
    ...(process.argv.includes('--no-server')
      ? [] : [{ port: SERVER_PORT, what: 'the Relayed server' }]),
    ...(withAgent ? [{ port: AGENT_PORT, what: 'the agent runtime' }] : []),
  ];
  const taken = [];
  for (const w of wanted) if (!(await portFree(w.port))) taken.push(w);

  if (taken.length > 0) {
    const lines = taken.map(t => {
      const who = holderOf(t.port);
      return `  :${t.port} — ${t.what}${who ? `, held by ${who}` : ''}`;
    });
    console.error(
      `\nAlready running.\n\n${lines.join('\n')}\n\n` +
      `Another \`pnpm dev\` is probably still alive. Stop it, or:\n` +
      `  lsof -nP -iTCP:${taken[0].port} -sTCP:LISTEN\n` +
      (taken.some(t => t.port === SERVER_PORT)
        ? `\nIf you are running the server yourself, use \`pnpm dev --no-server\`.\n` : ''));
    process.exit(1);
  }
}

// ── the primary: build, watch, renderer server, client 1 ────────────────────

// `--watch` is NOT the default for a reason worth knowing: without it a
// main-process edit does nothing until you restart by hand. Tolerable once,
// not three times — so multi-client makes it a requirement rather than a taste.
// `electron-vite dev` has no `--port`; the renderer's port is pinned in
// electron.vite.config.ts, which reads the same environment variable.
const args = ['--filter', '@relayed/desktop', 'exec', 'electron-vite', 'dev', '--watch'];

const children = new Map();   // client number -> ChildProcess
let stopping = false;

// ── the server ──────────────────────────────────────────────────────────────
//
// Started here rather than left to `pnpm -r --parallel dev`, because `dev` used
// to mean "the whole environment" and must keep meaning that. One server for
// every client: that is the production topology too, not a shortcut — fanout is
// a single in-process tier today and `MULTI_NODE` in sync/retention.ts is
// deliberately unbuilt with its trigger named.
//
// `--no-server` is for the case where you are already running one in another
// terminal to watch its logs.
const withServer = !process.argv.includes('--no-server');
const server = withServer
  ? spawn('pnpm', ['--filter', '@relayed/server', 'dev'],
          { cwd: root, stdio: 'inherit', env: process.env, detached: true })
  : null;

const agent = withAgent
  ? spawn('pnpm', ['--filter', '@relayed/agent', 'dev'],
          { cwd: root, stdio: 'inherit', env: process.env, detached: true })
  : null;
if (!agentConfigured) {
  const missing = ['AGENT_S2S_KEY', 'AGENT_PROVIDERS'].filter(v => !process.env[v]);
  console.log(`[dev] agent runtime not started — ${missing.join(' and ')} unset in .env (docs/AGENT-RUNTIME.md §11).`);
} else if (withAgent) {
  console.log(`[dev] agent runtime on :${AGENT_PORT}`);
}

// Stale signal from a previous run would fire a restart before the first build.
rmSync(signalFile, { force: true });

// DETACHED so it leads its own process GROUP, and that is the whole point:
// `pnpm` does not forward a signal to its grandchild, so killing the pnpm
// process left Electron running with its replica open. The next run's client 1
// would then meet a database another process still holds — the exact failure the
// separate directories exist to prevent, reintroduced by sloppy teardown.
// Killing the negative pid signals the group.
const primaryName = nameFor(1, clients);
const primaryDist = bundleFor(1, primaryName);

const primary = spawn('pnpm', args, {
  cwd: root,
  stdio: 'inherit',
  detached: true,
  env: {
    ...process.env,
    RELAYED_DEV_PORT: String(PORT),
    RELAYED_CLIENT: '1',
    RELAYED_CLIENT_NAME: primaryName,
    // electron-vite's OWN override, and the only one it honours — it resolves
    // the binary itself rather than loading the npm shim, so the shim's
    // `ELECTRON_OVERRIDE_DIST_PATH` is read by nobody on this path and client 1
    // launched from the unnamed bundle while client 2 was correct.
    ...(primaryDist ? { ELECTRON_EXEC_PATH: binIn(primaryDist) } : {}),
    ...(clients > 1 ? { RELAYED_BUILD_SIGNAL: signalFile } : {}),
  },
});
primary.on('exit', (code) => {
  stopping = true;
  killAll();
  killServer();
  process.exit(code ?? 0);
});

if (clients === 1) {
  // Nothing else to do: this is exactly today's loop, with watching on.
  hookSignals();
} else {
  p.log?.info?.(`starting ${clients} clients · renderer on :${PORT}`);
  hookSignals();
  await waitForBuild();
  for (let n = 2; n <= clients; n++) start(n);
  watchForRebuilds();
}

// ── siblings ────────────────────────────────────────────────────────────────

function start(n) {
  if (stopping) return;
  // Named on every start, not once: a rebuild restarts siblings, and the second
  // call is a stamp comparison against a copy that is already there.
  const label = nameFor(n, clients);
  const dist = bundleFor(n, label);
  // Spawned here, so there is nothing to override: the path IS the choice.
  const bin = dist ? binIn(dist) : electronBin;
  const child = spawn(bin, [join(desktop, 'out', 'main', 'index.js')], {
    cwd: desktop,
    stdio: 'inherit',
    env: {
      ...process.env,
      RELAYED_CLIENT: String(n),
      RELAYED_CLIENT_NAME: label,
      // The SAME dev server client 1 uses. `main` reads exactly this variable to
      // choose a URL over a file, so HMR reaches every window from one server.
      ELECTRON_RENDERER_URL: `http://localhost:${PORT}`,
      // Not inherited: a sibling must not signal its own siblings.
      RELAYED_BUILD_SIGNAL: '',
    },
  });
  children.set(n, child);
  child.on('exit', () => { if (children.get(n) === child) children.delete(n); });
}

/**
 * Replace a sibling, waiting for the old process to be GONE first.
 *
 * Two processes sharing one `userData` for even a moment is the thing the
 * separate directories exist to prevent; doing it ourselves on every rebuild
 * would be worse than never having isolated them.
 */
function restart(n) {
  const old = children.get(n);
  if (!old) { start(n); return; }
  children.delete(n);
  old.once('exit', () => { start(n); });
  old.kill();
}

function killAll() {
  for (const child of children.values()) child.kill();
  children.clear();
}

/** Signal a whole process group; a bare kill stops at `pnpm`. */
function killTree(child, sig = 'SIGTERM') {
  if (!child?.pid) return;
  try { process.kill(-child.pid, sig); }
  catch { try { child.kill(sig); } catch { /* already gone */ } }
}

function killServer() { killTree(server); killTree(agent); }

// ── the rebuild signal ──────────────────────────────────────────────────────

/**
 * Wait for the first build to land before spawning anything.
 *
 * `out/main/index.js` existing is not enough on its own — it may be last run's.
 * The signal file is deleted at startup and written by a `closeBundle` hook, so
 * its presence means THIS run produced a complete bundle.
 */
async function waitForBuild() {
  const deadline = Date.now() + 120_000;
  while (!existsSync(signalFile)) {
    if (stopping) return;
    if (Date.now() > deadline) {
      console.error('[dev] no build after 120s — starting client 1 only');
      return;
    }
    await sleep(120);
  }
}

/**
 * Restart siblings whenever a build completes.
 *
 * Polls one small file rather than watching `out/`, and the difference matters.
 * electron-vite restarts client 1 from a rollup `closeBundle` hook, which fires
 * once a bundle is COMPLETELY written; a watch on the output directory fires on
 * the first chunk to land, while shared chunks may still be in flight. The
 * signal file is written by that same hook, so both halves react to the same
 * fact.
 *
 * Debounced because main and preload are separate builds with separate hooks:
 * one edit touches the file twice, and should produce one restart.
 */
function watchForRebuilds() {
  let seen = stampOf();
  let timer = null;
  setInterval(() => {
    const now = stampOf();
    if (now === seen) return;
    seen = now;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (stopping) return;
      for (const n of [...children.keys()]) restart(n);
    }, 250);
  }, 200).unref?.();
}

// ── shutdown ────────────────────────────────────────────────────────────────

/**
 * Take the siblings down with us.
 *
 * Orphaned Electron windows outlive the terminal that started them, still
 * holding their replicas open — and the next run's client 2 would then meet a
 * database another process already has, which is the failure the whole layout is
 * arranged to avoid.
 */
function hookSignals() {
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      stopping = true;
      killAll();
      killServer();
      killTree(primary, sig);
      // The primary's own exit handler calls process.exit; this is the backstop
      // for a primary that has already gone.
      setTimeout(() => process.exit(0), 2_000).unref?.();
    });
  }
  process.on('exit', () => { killAll(); killServer(); });
}
