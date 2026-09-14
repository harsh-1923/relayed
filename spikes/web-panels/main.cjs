// Web pages inside panels as `<webview>` (PANELS.md, web pages).
//
//   npm test
//
// Runs the app's real guard (apps/desktop/src/main/web-panels.ts, bundled) in a
// window with the app's own webPreferences and the renderer's real
// Content-Security-Policy, read from its index.html. The pages come from a
// local HTTP server. `shell.openExternal` is replaced with a recorder, so
// nothing opens in the system browser.
const electron = require('electron');
const { app, BrowserWindow, session, webContents } = electron;
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const opened = [];
electron.shell.openExternal = async url => { opened.push(url); };
const { guardWebPanels } = require('./dist/guard.cjs');

const ACCOUNT = 'acc_SPIKE';
const PARTITION = `persist:panels:${ACCOUNT}`;
const MAGENTA = [255, 0, 255];
const GREEN = [0, 200, 0];

const results = [];
/** Each check gets a deadline, so one that hangs is named rather than stalling the run. */
async function check(name, body, ms = 10_000) {
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms); });
  try {
    await Promise.race([body(), deadline]);
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, detail: error.message.split('\n').slice(0, 4).join(' ') });
  } finally {
    clearTimeout(timer);
  }
  const result = results.at(-1);
  console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${result.name}${result.detail ? `\n     ${result.detail}` : ''}`);
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(50);
  }
}

function serve() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/redirect-file') {
      response.writeHead(302, { Location: 'file:///etc/hosts' });
      return response.end();
    }
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(`<!doctype html><title>Spike page</title>
      <style>html,body{margin:0;height:100%;background:rgb(${MAGENTA})}</style>
      <script>window.loadedAt = performance.timeOrigin + '-' + Math.random();</script>
      <body></body>`);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** The app's CSP, exactly as the renderer's index.html declares it. */
function appCsp() {
  const html = fs.readFileSync(path.join(__dirname, '../../apps/desktop/src/renderer/index.html'), 'utf8');
  const match = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
  if (!match) throw new Error('no CSP in index.html');
  return match[1].replace(/\s+/g, ' ').trim();
}

// The app's own schemes, registered as main/blob-protocol.ts and deep-link.ts do,
// so a page could otherwise reach them. Every request that arrives is recorded.
electron.protocol.registerSchemesAsPrivileged([
  { scheme: 'relayed-blob', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: false } },
]);
const schemeHits = [];

const guests = () => webContents.getAllWebContents().filter(contents => contents.getType() === 'webview');
const guestFor = id => guests().find(contents => contents.getURL().includes(`id=${id}`));

app.whenReady().then(async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const csp = appCsp();
  fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
  const pagePath = path.join(__dirname, 'dist', 'page.html');
  // The helpers are a file, not an inline script: the app's CSP allows scripts from 'self' only.
  fs.writeFileSync(pagePath, `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}">
    <style>body{margin:0;background:#fff} webview{position:absolute;display:flex}</style>
    <div id="stage" style="position:absolute;left:20px;top:20px;width:400px;height:300px"></div>
    <div id="elsewhere" style="position:absolute;left:440px;top:20px;width:200px;height:300px"></div>
    <script src="page.js"></script>`);
  fs.writeFileSync(path.join(__dirname, 'dist', 'page.js'), `
      window.spike = {
        add(id, attributes, parent = 'stage') {
          const view = document.createElement('webview');
          view.id = id;
          for (const [name, value] of Object.entries(attributes)) view.setAttribute(name, value);
          view.style.cssText = 'left:0;top:0;width:100%;height:100%';
          document.getElementById(parent).appendChild(view);
        },
        style(id, css) { document.getElementById(id).style.cssText = css; },
        move(id, parent) { document.getElementById(parent).appendChild(document.getElementById(id)); },
        remove(id) { document.getElementById(id)?.remove(); },
        overlay() {
          const layer = document.createElement('div');
          layer.style.cssText = 'position:fixed;left:20px;top:20px;width:150px;height:100px;background:rgb(${GREEN});z-index:50';
          document.body.appendChild(layer);
        },
      };`);

  const win = new BrowserWindow({
    width: 700, height: 400, show: true,
    // The app's own window settings (main/index.ts), which is what the tag has to work under.
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: true },
  });
  guardWebPanels(win, () => ACCOUNT);
  session.fromPartition(PARTITION).protocol.handle('relayed-blob', request => {
    schemeHits.push(request.url);
    return new Response('<title>blob</title>', { headers: { 'Content-Type': 'text/html' } });
  });
  const cspViolations = [];
  win.webContents.on('console-message', event => {
    if (/Content Security Policy|frame-src/i.test(event.message)) cspViolations.push(event.message.slice(0, 160));
  });
  console.log('loading the page');
  await win.loadFile(pagePath);
  console.log('page loaded');
  const page = source => win.webContents.executeJavaScript(source);
  const add = (id, attributes, parent) => page(`spike.add(${JSON.stringify(id)}, ${JSON.stringify(attributes)}, ${JSON.stringify(parent ?? 'stage')})`);
  const pixel = async (x, y) => {
    const image = await win.webContents.capturePage();
    const scale = image.getSize().width / win.getContentSize()[0];
    const { width } = image.getSize();
    const bitmap = image.toBitmap();
    const at = (Math.round(y * scale) * width + Math.round(x * scale)) * 4;
    return [bitmap[at + 2], bitmap[at + 1], bitmap[at]];
  };
  const near = (actual, expected) => actual.every((channel, index) => Math.abs(channel - expected[index]) <= 12);

  await check(`a webview attaches and loads under the app's CSP (${csp.match(/frame-src[^;]*/)?.[0]})`, async () => {
    await add('a', { src: `${base}/page?id=a`, partition: PARTITION, allowpopups: 'true' });
    const guest = await until(() => { const found = guestFor('a'); return found && !found.isLoading() && found.getTitle() === 'Spike page' ? found : null; });
    assert.ok(guest, `no loaded guest; CSP messages: ${cspViolations.join(' | ') || 'none'}`);
  });

  await check('the page is sandboxed, isolated, and has no Node', async () => {
    const guest = guestFor('a');
    assert.deepEqual(await guest.executeJavaScript('[typeof require, typeof process]'), ['undefined', 'undefined']);
    const preferences = guest.getLastWebPreferences();
    assert.equal(preferences.sandbox, true);
    assert.equal(preferences.contextIsolation, true);
    assert.equal(preferences.nodeIntegration, false);
  });

  await check('the page browses in the account\'s own session', async () => {
    assert.equal(guestFor('a').session, session.fromPartition(PARTITION));
  });

  await check('a webview that asks for a preload and Node gets neither', async () => {
    const preload = path.join(__dirname, 'dist', 'evil-preload.js');
    fs.writeFileSync(preload, 'window.evil = typeof require;');
    await add('b', {
      src: `${base}/page?id=b`, partition: PARTITION,
      preload: `file://${preload}`, webpreferences: 'nodeIntegration=true,sandbox=false,contextIsolation=false',
    });
    const guest = await until(() => { const found = guestFor('b'); return found && !found.isLoading() ? found : null; });
    assert.ok(guest, 'did not attach');
    assert.deepEqual(await guest.executeJavaScript('[typeof require, typeof window.evil]'), ['undefined', 'undefined']);
    const preferences = guest.getLastWebPreferences();
    assert.equal(preferences.sandbox, true);
    assert.equal(preferences.nodeIntegration, false);
    assert.equal(preferences.preload, undefined);
  });

  await check('a webview in another account\'s partition never attaches', async () => {
    const before = guests().length;
    await add('c', { src: `${base}/page?id=c`, partition: 'persist:panels:acc_OTHER' });
    await sleep(1500);
    assert.equal(guestFor('c'), undefined);
    assert.equal(guests().length, before);
  });

  await check('a webview with no partition, or on a file: URL, never attaches', async () => {
    const before = guests().length;
    await add('d', { src: `${base}/page?id=d` });
    await add('e', { src: 'file:///etc/hosts', partition: PARTITION });
    await sleep(1500);
    assert.equal(guests().length, before);
  });

  await check('window.open goes to the system browser, and no window opens', async () => {
    await guestFor('a').executeJavaScript(`window.open('https://example.com/opened')`, true);
    assert.ok(await until(() => opened.includes('https://example.com/opened'), 2000), `opened: ${JSON.stringify(opened)}`);
    assert.equal(BrowserWindow.getAllWindows().length, 1);
  });

  await check('a target=_blank link goes to the system browser', async () => {
    await guestFor('a').executeJavaScript(`(() => { const link = document.createElement('a'); link.href = 'https://example.com/blank'; link.target = '_blank'; document.body.appendChild(link); link.click(); })()`, true);
    assert.ok(await until(() => opened.includes('https://example.com/blank'), 2000), `opened: ${JSON.stringify(opened)}`);
    assert.equal(BrowserWindow.getAllWindows().length, 1);
  });

  await check('a window.open to a file: URL goes nowhere', async () => {
    await guestFor('a').executeJavaScript(`window.open('file:///etc/hosts')`, true);
    await sleep(500);
    assert.ok(!opened.some(url => url.startsWith('file:')));
    assert.equal(BrowserWindow.getAllWindows().length, 1);
  });

  await check('permissions: clipboard write granted; location, notifications and clipboard read denied', async () => {
    const guest = guestFor('a');
    const states = await guest.executeJavaScript(`Promise.all([
      navigator.permissions.query({ name: 'clipboard-write' }).then(s => s.state),
      navigator.permissions.query({ name: 'geolocation' }).then(s => s.state),
      Notification.requestPermission(),
      navigator.permissions.query({ name: 'clipboard-read' }).then(s => s.state),
    ])`, true);
    assert.deepEqual(states, ['granted', 'denied', 'denied', 'denied']);
  });

  // Keeping the app's name matters: a bare Chrome agent over Client Hints that
  // say Chromium is what Google's sign-in refuses as spoofing.
  await check('the user agent drops Electron but keeps the app\'s name', async () => {
    const agent = await guestFor('a').executeJavaScript('navigator.userAgent');
    assert.doesNotMatch(agent, /Electron\//, agent);
    assert.match(agent, /\(KHTML, like Gecko\) web-panels-spike\/\S+ Chrome\/\S+ Safari\//, agent);
  });

  // Chromium already refuses an http page's navigation to file:. The app's own
  // schemes are registered as standard and secure, which Chromium would let a
  // page reach, so those hits are what show the guard working.
  await check('the page cannot navigate to file: or the app\'s schemes', async () => {
    for (const target of ['file:///etc/hosts', 'relayed-blob://abc', 'relayed://auth']) {
      await guestFor('a').executeJavaScript(`location.href = ${JSON.stringify(target)}`, true).catch(() => {});
      await sleep(600);
      assert.ok(guestFor('a'), `left the page for ${target}`);
    }
    assert.deepEqual(schemeHits, []);
  });

  await check('a control: without the guard, the same page does reach the app\'s scheme', async () => {
    const control = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, partition: 'spike-control' } });
    session.fromPartition('spike-control').protocol.handle('relayed-blob', () => {
      schemeHits.push('control');
      return new Response('<title>blob</title>', { headers: { 'Content-Type': 'text/html' } });
    });
    await control.loadURL(`${base}/page?id=control`);
    await control.webContents.executeJavaScript(`location.href = 'relayed-blob://abc'`, true).catch(() => {});
    const reached = await until(() => schemeHits.includes('control'), 3000);
    control.destroy();
    schemeHits.length = 0;
    assert.ok(reached, 'an unguarded page could not reach it either, so the check above proves nothing');
  });

  await check('a server redirect to file: is refused', async () => {
    await guestFor('a').executeJavaScript(`location.href = ${JSON.stringify(`${base}/redirect-file`)}`, true).catch(() => {});
    await sleep(1000);
    assert.ok(!guests().some(contents => contents.getURL().startsWith('file:')), guests().map(contents => contents.getURL()).join(', '));
  });

  // Fresh page for the drawing checks: the checks above navigated 'a' around.
  await check('a fresh page loads for the drawing checks', async () => {
    await page(`spike.remove('a'); spike.remove('b'); spike.remove('c'); spike.remove('d'); spike.remove('e')`);
    await add('p', { src: `${base}/page?id=p`, partition: PARTITION });
    assert.ok(await until(() => { const found = guestFor('p'); return found && !found.isLoading() ? found : null; }), 'did not load');
    await sleep(500);
  });

  /**
   * How long until every point shows its colour, in ms, reading the window back
   * repeatedly; null if it never does within the limit. Drawing is asynchronous
   * across processes, so a single read can land a frame early.
   */
  const drawn = async (points, limit = 3000) => {
    const started = Date.now();
    let last = [];
    while (Date.now() - started < limit) {
      last = await Promise.all(points.map(([x, y]) => pixel(x, y)));
      if (last.every((actual, index) => near(actual, points[index][2]))) return Date.now() - started;
      await sleep(16);
    }
    throw new Error(`not drawn within ${limit}ms: ${JSON.stringify(last)}`);
  };
  const timings = {};

  await check('the page is drawn where its element is', async () => {
    timings.firstDraw = await drawn([[300, 250, MAGENTA], [10, 10, [255, 255, 255]]]);
  });

  await check('an element with a higher z-index draws over the page', async () => {
    await page('spike.overlay()');
    timings.overlayDraw = await drawn([[60, 60, GREEN], [300, 250, MAGENTA]]);
  });

  await check('a parked webview keeps its page, and draws again when brought back', async () => {
    const before = await guestFor('p').executeJavaScript('window.loadedAt');
    await page(`spike.style('p', 'position:absolute;left:-100000px;top:0;width:100%;height:100%')`);
    await sleep(800);
    await page(`spike.style('p', 'left:0;top:0;width:100%;height:100%')`);
    timings.unparkDraw = await drawn([[300, 250, MAGENTA]]);
    assert.equal(await guestFor('p').executeJavaScript('window.loadedAt'), before);
  });
  console.log(`     drawn after (ms, including the read-back): ${JSON.stringify(timings)}`);

  await check('moving a webview to another parent loads its page again (why tabs stay mounted)', async () => {
    const before = await guestFor('p').executeJavaScript('window.loadedAt');
    await page(`spike.move('p', 'elsewhere')`);
    const reloaded = await until(async () => {
      const guest = guestFor('p');
      if (!guest || guest.isLoading()) return false;
      return (await guest.executeJavaScript('window.loadedAt').catch(() => before)) !== before;
    }, 3000);
    assert.ok(reloaded, 'the page survived a move');
  });

  server.close();
  const failed = results.filter(result => !result.ok);
  console.log(`\nElectron ${process.versions.electron}, Chromium ${process.versions.chrome}: ${results.length - failed.length} passed, ${failed.length} failed`);
  app.exit(failed.length === 0 ? 0 : 1);
});
