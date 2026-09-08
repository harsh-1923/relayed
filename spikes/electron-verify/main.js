// Phase 0 verifications (DESIGN.md §15).
//   electron . --check=sqlite
//   electron . --check=timer --minutes=15
const { app, BrowserWindow, utilityProcess } = require('electron');
const path = require('path');

const arg = (k, d) => {
  const hit = process.argv.find(a => a.startsWith(`--${k}=`));
  return hit ? hit.split('=')[1] : d;
};
const check = arg('check', 'sqlite');
const minutes = Number(arg('minutes', 15));

const pad = (s, n) => String(s).padEnd(n);

// ── Verification 1: node:sqlite under Electron's bundled Node ───────────────
function runSqlite() {
  const child = utilityProcess.fork(path.join(__dirname, 'child-sqlite.js'));
  child.on('message', m => {
    if (!m.done) return;
    const v = m.versions;
    console.log(`\nElectron ${v.electron} | Node ${v.node} | V8 ${v.v8} | SQLite ${v.sqlite}\n`);
    let fail = 0;
    for (const r of m.results) {
      if (!r.ok) fail++;
      console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${pad(r.name, 48)} ${r.ok ? '' : '-> ' + r.actual}`);
    }
    console.log(`\n${m.results.length - fail} passed, ${fail} failed`);
    app.exit(fail ? 1 : 0);
  });
}

// ── Verification 2: utilityProcess timers vs renderer throttling ────────────
function runTimer() {
  const INTERVAL = 5000;
  const ticks = { utility: [], renderer: [] };
  const started = Date.now();

  const win = new BrowserWindow({
    width: 400, height: 300, show: true,
    webPreferences: { backgroundThrottling: true },   // default; the thing under test
  });
  win.loadFile(path.join(__dirname, 'renderer.html'));

  win.webContents.on('console-message', (...a) => {
    // Electron changed this signature across majors; handle both shapes.
    const text = typeof a[0] === 'object' && a[0] !== null && 'message' in a[0] ? a[0].message : a[2];
    try { const m = JSON.parse(text); if (m.src === 'renderer' && m.n) ticks.renderer.push(m.dt); } catch {}
  });

  const child = utilityProcess.fork(path.join(__dirname, 'child-timer.js'),
    [], { env: { ...process.env, TICK_MS: String(INTERVAL) } });
  child.on('message', m => { if (m.n) ticks.utility.push(m.dt); });

  // Hide the window and the dock icon: this is what triggers Chromium's
  // background throttling and gives macOS App Nap a chance to engage.
  setTimeout(() => {
    win.hide();
    if (process.platform === 'darwin' && app.dock) app.dock.hide();
    console.log(`[${new Date().toISOString()}] window hidden, dock hidden — throttling window open`);
  }, 10_000);

  const stat = a => a.length
    ? { n: a.length, min: Math.min(...a), max: Math.max(...a),
        med: a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] }
    : { n: 0 };

  const report = final => {
    const mins = ((Date.now() - started) / 60000).toFixed(1);
    const u = stat(ticks.utility), r = stat(ticks.renderer);
    console.log(`\n[t+${mins}m] interval=${INTERVAL}ms  (throttled would be ~60000ms)`);
    console.log(`  utility  ticks=${pad(u.n,4)} median=${pad(u.med ?? '-',7)} max=${u.max ?? '-'}`);
    console.log(`  renderer ticks=${pad(r.n,4)} median=${pad(r.med ?? '-',7)} max=${r.max ?? '-'}`);
    if (!final) return;
    const uThrottled = (u.med ?? 0) > INTERVAL * 3;
    const rThrottled = (r.med ?? 0) > INTERVAL * 3;
    console.log(`\n  utilityProcess throttled? ${uThrottled ? 'YES' : 'NO'}`);
    console.log(`  renderer throttled?       ${rThrottled ? 'YES' : 'NO'}`);
    console.log(rThrottled && !uThrottled
      ? '\n  RESULT: CONFIRMED — renderer throttles, utilityProcess does not.'
      : !rThrottled && !uThrottled
      ? '\n  RESULT: INCONCLUSIVE — neither throttled. The control did not fire,\n' +
        '          so this run does not prove the utilityProcess is immune.'
      : '\n  RESULT: PROBLEM — the utilityProcess timer was throttled (§13.9 at risk).');
    app.exit(uThrottled ? 1 : 0);
  };

  const iv = setInterval(() => report(false), 120_000);
  setTimeout(() => { clearInterval(iv); report(true); }, minutes * 60_000);
  console.log(`[${new Date().toISOString()}] timer check started, running ${minutes} min`);
}

app.whenReady().then(() => (check === 'sqlite' ? runSqlite() : runTimer()));
app.on('window-all-closed', () => {});
