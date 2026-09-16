// Navigating to an annotation: does a text fragment (`#:~:text=`) fire inside a
// panel `<webview>` (docs/ANNOTATIONS.md, navigating to an annotation)?
//
//   npm test
//
// The question the doc cannot answer by reading: the URL Fragment Text
// Directives spec says the directive fires only on "user-initiated top-frame
// navigations, so iframes, scripts, and same-document fragment changes cannot
// trigger it". Whether Electron's `loadURL` from the embedder counts as
// user-initiated — the way an address bar does — decides whether clicking an
// annotation scrolls to it for free or needs a script after load.
//
// Runs under the app's real guard (apps/desktop/src/main/web-panels.ts,
// bundled), in the account's own partition, so a pass is a pass for the panel
// as it actually ships. Pages come from a local HTTP server. No pixels are
// read, so the window may be covered.
const electron = require('electron');
const { app, BrowserWindow, session, webContents } = electron;
const http = require('node:http');
const assert = require('node:assert/strict');

electron.shell.openExternal = async () => {};
const { guardWebPanels } = require('./dist/guard.cjs');
// The REAL helper the app builds annotation addresses with, bundled the same
// way the guard is — so this proves what ships rather than a copy of it.
const { annotationAddress, withoutFragmentDirective } = require('./dist/shared.cjs');
// The REAL page-side script the panel reads an anchor with.
const { anchorScript, readAnchor } = require('./dist/annotations.cjs');

const ACCOUNT = 'acc_SPIKE';
const PARTITION = `persist:panels:${ACCOUNT}`;

// The phrase that appears ONCE, far down the page.
const UNIQUE = 'Wombat parallax threshold reached in the dispatcher';
// The phrase that appears TWICE, with different text either side of it. This is
// what prefix/suffix exists for, and it is the W3C TextQuoteSelector shape the
// annotation part stores (docs/ANNOTATIONS.md, what an annotation holds).
const REPEATED = 'Retry budget exhausted';
// A quote too long to put in an address whole. `annotationAddress` names such a
// range by its two ends and lets the browser match everything between them;
// whether Chromium really does that is the question check 10 asks.
const LONG = `Kestrel ${'drifting over the estuary '.repeat(14)}and finally Pelican.`;

const results = [];
/** Each check gets a deadline, so one that hangs is named rather than stalling the run. */
async function check(name, body, ms = 15_000) {
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
async function until(predicate, ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(50);
  }
}

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Fragment spike</title></head>
<body style="margin:0;font:16px/1.5 system-ui">
  <h1 id="top">Top of page</h1>
  <div style="height:2000px">spacer one</div>
  <p id="first">Alpha context leading. ${REPEATED}. Omega trailing text.</p>
  <div style="height:2000px">spacer two</div>
  <p id="unique">${UNIQUE}.</p>
  <div style="height:2000px">spacer three</div>
  <p id="second">Zulu context leading. ${REPEATED}. Yankee trailing text.</p>
  <div style="height:2000px">spacer four</div>
  <p id="long">${LONG}</p>
  <div style="height:2000px">spacer five</div>
<script>
  window.loadedAt = Date.now();
  window.probe = id => {
    const element = document.getElementById(id);
    const rect = element.getBoundingClientRect();
    return {
      scrollY: Math.round(window.scrollY),
      offsetTop: element.offsetTop,
      rectTop: Math.round(rect.top),
      inView: rect.top >= -20 && rect.top <= window.innerHeight,
      href: location.href,
      hash: location.hash,
      hasFragmentDirective: 'fragmentDirective' in document,
    };
  };
  // The fallback the doc needs if the directive does not fire: find the text,
  // scroll to it, and mark it. Deliberately plain — a TreeWalker, a Range, and
  // the Custom Highlight API where it exists.
  window.scrollToText = (exact, prefix) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = node.data.indexOf(exact);
      if (index < 0) continue;
      if (prefix && !node.data.slice(0, index).includes(prefix)) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + exact.length);
      range.startContainer.parentElement.scrollIntoView({ block: 'center' });
      if (window.CSS && CSS.highlights) {
        CSS.highlights.set('relayed-annotation', new Highlight(range));
      }
      return true;
    }
    return false;
  };
</script>
</body></html>`;

function serve() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/host') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      return response.end(`<!doctype html><meta charset="utf-8"><body style="margin:0">
<script>
  window.lastContextMenu = null;
  window.spike = {
    /**
     * A webview OFFSET from the window's origin, the way a panel on the right of
     * a split actually sits. With the view at 0,0 — as \`add\` puts it — a
     * webview-relative coordinate and a window-relative one are the same number,
     * so that arrangement cannot tell them apart.
     */
    addOffset(id, src, left, top) {
      const wrapper = document.createElement('div');
      wrapper.style.cssText =
        \`position:absolute;left:\${left}px;top:\${top}px;width:500px;height:400px;overflow:hidden;\`;
      const view = document.createElement('webview');
      view.setAttribute('partition', ${JSON.stringify(PARTITION)});
      view.setAttribute('src', src);
      view.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;';
      view.addEventListener('context-menu', event => {
        // What the app has to do: turn the reported point into one inside the
        // surface the menu is drawn in.
        const box = wrapper.getBoundingClientRect();
        window.lastContextMenu = {
          hasParams: 'params' in event && event.params !== null && event.params !== undefined,
          onParams: event.params ? { x: event.params.x, y: event.params.y } : null,
          surface: { left: Math.round(box.left), top: Math.round(box.top) },
          converted: event.params
            ? { x: Math.round(event.params.x - box.left), y: Math.round(event.params.y - box.top) }
            : null,
        };
      });
      wrapper.appendChild(view);
      document.body.appendChild(wrapper);
    },
    add(id, src) {
      const view = document.createElement('webview');
      view.setAttribute('partition', ${JSON.stringify(PARTITION)});
      view.setAttribute('src', src);
      view.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:600px;';
      // WHAT DOES A RIGHT-CLICK ACTUALLY DELIVER? The renderer is where
      // WebPanel listens, so the shape has to be read here rather than on
      // main's own webContents event (docs/ANNOTATIONS.md, capture).
      view.addEventListener('context-menu', event => {
        window.lastContextMenu = {
          onEvent: {
            x: event.x, y: event.y,
            selectionText: event.selectionText,
            pageURL: event.pageURL,
          },
          hasParams: 'params' in event && event.params !== null && event.params !== undefined,
          onParams: event.params ? {
            x: event.params.x, y: event.params.y,
            selectionText: event.params.selectionText,
            pageURL: event.params.pageURL,
          } : null,
        };
      });
      document.body.appendChild(view);
    },
  };
</script></body>`);
    }
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(PAGE);
  });
  return server;
}

const guests = () => webContents.getAllWebContents().filter(contents => contents.getType() === 'webview');
const guestFor = id => guests().find(contents => contents.getURL().includes(`id=${id}`));

/** A text fragment, in the spec's shape: [prefix-,]textStart[,textEnd][,-suffix]. */
const fragment = ({ prefix, exact, suffix }) =>
  `#:~:text=${prefix ? `${encodeURIComponent(prefix)}-,` : ''}${encodeURIComponent(exact)}${suffix ? `,-${encodeURIComponent(suffix)}` : ''}`;

/**
 * Wait for the guest to stop loading, then for the scroll to settle: the
 * directive scrolls AFTER the load event, so reading once reports zero.
 */
async function settled(guest, id) {
  await until(() => !guest.isLoading());
  let last = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    const probe = await guest.executeJavaScript(`window.probe(${JSON.stringify(id)})`).catch(() => null);
    if (probe && last && probe.scrollY === last.scrollY && probe.scrollY > 0) return probe;
    last = probe;
    await sleep(50);
  }
  return last;
}

app.whenReady().then(async () => {
  const server = serve();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const window_ = new BrowserWindow({
    width: 900, height: 700, show: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: true },
  });
  guardWebPanels(window_, () => ACCOUNT);
  await window_.loadURL(`${base}/host`);
  const host = code => window_.webContents.executeJavaScript(code, true);

  const uniqueFragment = fragment({ exact: UNIQUE });

  // ── 1. The fresh-panel case: the src carries the directive from the start ──
  let firstProbe = null;
  await check('a webview whose src carries a text fragment scrolls to it', async () => {
    await host(`spike.add('a', ${JSON.stringify(`${base}/page?id=a${uniqueFragment}`)})`);
    const guest = await until(() => { const found = guestFor('a'); return found && !found.isLoading() ? found : null; });
    assert.ok(guest, 'the guest never attached');
    firstProbe = await settled(guest, 'unique');
    assert.ok(firstProbe.scrollY > 100, `did not scroll: ${JSON.stringify(firstProbe)}`);
    assert.ok(firstProbe.inView, `the target is not in view: ${JSON.stringify(firstProbe)}`);
  });

  // ── 2. The open-panel case: loadURL from the embedder, a different document ──
  await check('loadURL from main, to a different document, fires the directive', async () => {
    await host(`spike.add('b', ${JSON.stringify(`${base}/page?id=b`)})`);
    const guest = await until(() => { const found = guestFor('b'); return found && !found.isLoading() ? found : null; });
    assert.ok(guest, 'the guest never attached');
    const before = await guest.executeJavaScript(`window.probe('unique')`);
    assert.equal(before.scrollY, 0, 'started scrolled');
    await guest.loadURL(`${base}/page?id=b&v=2${uniqueFragment}`);
    const probe = await settled(guest, 'unique');
    assert.ok(probe.scrollY > 100, `did not scroll: ${JSON.stringify(probe)}`);
    assert.ok(probe.inView, `the target is not in view: ${JSON.stringify(probe)}`);
  });

  // ── 3. The same-page case: the panel is already on the page, click elsewhere ──
  // The spec says a same-document fragment change cannot trigger the directive.
  // This is the common case for an annotation on a page you already have open.
  let samePage = null;
  let sameDocument = null;
  await check('SAME-DOCUMENT: loadURL with only the fragment changed', async () => {
    await host(`spike.add('c', ${JSON.stringify(`${base}/page?id=c`)})`);
    const guest = await until(() => { const found = guestFor('c'); return found && !found.isLoading() ? found : null; });
    assert.ok(guest, 'the guest never attached');
    // Whether the DOCUMENT survived is the real question. `loadedAt` is stamped
    // once per parse, so an unchanged value means the page was never reloaded —
    // which is what "same-document" has to mean for a person's scroll position,
    // form contents and media to survive a click on an annotation.
    const before = await guest.executeJavaScript('window.loadedAt');
    await guest.loadURL(`${base}/page?id=c${uniqueFragment}`);
    samePage = await settled(guest, 'unique');
    const after = await guest.executeJavaScript('window.loadedAt');
    sameDocument = after === before;
    // Not asserted either way — this check RECORDS the answer, which the doc needs.
    console.log(`     scrollY=${samePage.scrollY} inView=${samePage.inView} documentSurvived=${sameDocument}`);
  });

  // ── 3b. A true same-document change: the page's own script moves the hash ──
  let scripted = null;
  await check('SAME-DOCUMENT, from the page: assigning location.hash', async () => {
    await host(`spike.add('g', ${JSON.stringify(`${base}/page?id=g`)})`);
    const guest = await until(() => { const found = guestFor('g'); return found && !found.isLoading() ? found : null; });
    assert.ok(guest, 'the guest never attached');
    const before = await guest.executeJavaScript('window.loadedAt');
    await guest.executeJavaScript(`location.hash = ${JSON.stringify(uniqueFragment.slice(1))}`, true);
    await sleep(700);
    scripted = await guest.executeJavaScript(`window.probe('unique')`);
    const after = await guest.executeJavaScript('window.loadedAt');
    console.log(`     scrollY=${scripted.scrollY} inView=${scripted.inView} documentSurvived=${after === before}`);
  });

  // ── 3c. The same thing WITHOUT a user gesture ──
  // The spec's restriction is about user initiation, and `executeJavaScript`
  // takes a `userGesture` flag. If 3b fired only because that flag was set,
  // then the rule is real and the app simply has to pass it — which it may
  // honestly do, since a person clicked the annotation.
  let ungestured = null;
  await check('SAME-DOCUMENT, from the page, with NO user gesture', async () => {
    await host(`spike.add('h', ${JSON.stringify(`${base}/page?id=h`)})`);
    const guest = await until(() => { const found = guestFor('h'); return found && !found.isLoading() ? found : null; });
    assert.ok(guest, 'the guest never attached');
    await guest.executeJavaScript(`location.hash = ${JSON.stringify(uniqueFragment.slice(1))}`, false);
    await sleep(700);
    ungestured = await guest.executeJavaScript(`window.probe('unique')`);
    console.log(`     scrollY=${ungestured.scrollY} inView=${ungestured.inView}`);
  });

  // ── 4. prefix/suffix picks the right one of two identical phrases ──
  await check('prefix and suffix disambiguate two copies of the same text', async () => {
    const target = fragment({ prefix: 'Zulu context leading.', exact: `${REPEATED}.`, suffix: 'Yankee trailing text.' });
    await host(`spike.add('d', ${JSON.stringify(`${base}/page?id=d${target}`)})`);
    const guest = await until(() => { const found = guestFor('d'); return found && !found.isLoading() ? found : null; });
    assert.ok(guest, 'the guest never attached');
    const second = await settled(guest, 'second');
    const first = await guest.executeJavaScript(`window.probe('first')`);
    assert.ok(second.inView, `landed on the wrong copy: second=${JSON.stringify(second)} first=${JSON.stringify(first)}`);
    assert.ok(!first.inView, 'the first copy is also in view, so this proves nothing');
  });

  // ── 5. Text that is no longer there degrades to the top of the page ──
  await check('text that does not match leaves the page at the top, not an error', async () => {
    const missing = fragment({ exact: 'Phrase that this page has never contained' });
    await host(`spike.add('e', ${JSON.stringify(`${base}/page?id=e${missing}`)})`);
    const guest = await until(() => { const found = guestFor('e'); return found && !found.isLoading() ? found : null; });
    assert.ok(guest, 'the guest never attached');
    await sleep(600);
    const probe = await guest.executeJavaScript(`window.probe('top')`);
    assert.equal(probe.scrollY, 0, `scrolled somewhere: ${JSON.stringify(probe)}`);
    assert.ok(probe.inView, 'the top of the page is not in view');
  });

  // ── 6. What the URL looks like afterwards — the address bar shows getURL() ──
  await check('the fragment directive is stripped from what the page and main read back', async () => {
    const guest = guestFor('a');
    const fromMain = guest.getURL();
    assert.ok(firstProbe, 'the first check did not run');
    console.log(`     main getURL(): ${fromMain}`);
    console.log(`     page location.href: ${firstProbe.href}  hash: ${JSON.stringify(firstProbe.hash)}`);
    console.log(`     document.fragmentDirective present: ${firstProbe.hasFragmentDirective}`);
  });

  // ── 7. The fallback, for whichever case above does not fire ──
  await check('the scripted fallback scrolls to the text and marks it', async () => {
    await host(`spike.add('f', ${JSON.stringify(`${base}/page?id=f`)})`);
    const guest = await until(() => { const found = guestFor('f'); return found && !found.isLoading() ? found : null; });
    assert.ok(guest, 'the guest never attached');
    const found = await guest.executeJavaScript(`window.scrollToText(${JSON.stringify(UNIQUE)}, null)`);
    assert.equal(found, true, 'the fallback did not find the text');
    await sleep(400);
    const probe = await guest.executeJavaScript(`window.probe('unique')`);
    assert.ok(probe.inView, `the fallback did not bring it into view: ${JSON.stringify(probe)}`);
  });

  await check('the fallback picks the right copy when given a prefix', async () => {
    const guest = guestFor('f');
    const found = await guest.executeJavaScript(
      `window.scrollToText(${JSON.stringify(`${REPEATED}.`)}, ${JSON.stringify('Zulu context leading.')})`);
    assert.equal(found, true, 'the fallback did not find the text');
    await sleep(400);
    const second = await guest.executeJavaScript(`window.probe('second')`);
    assert.ok(second.inView, `landed on the wrong copy: ${JSON.stringify(second)}`);
  });

  // ── 9. The app's OWN helper, end to end ──
  await check('an address built by annotationAddress scrolls to the passage', async () => {
    const built = annotationAddress(`${base}/page?id=i`, {
      prefix: 'Zulu context leading.', exact: `${REPEATED}.`, suffix: 'Yankee trailing text.',
    });
    await host(`spike.add('i', ${JSON.stringify(built)})`);
    const guest = await until(() => { const found = guestFor('i'); return found && !found.isLoading() ? found : null; });
    assert.ok(guest, 'the guest never attached');
    const second = await settled(guest, 'second');
    const first = await guest.executeJavaScript(`window.probe('first')`);
    assert.ok(second.inView, `landed on the wrong copy: ${JSON.stringify(second)}`);
    assert.ok(!first.inView, 'the first copy is also in view, so this proves nothing');
    // The address bar reads main's getURL(), which keeps the directive.
    assert.equal(withoutFragmentDirective(guest.getURL()), `${base}/page?id=i`);
  });

  // ── 10. A long quote, named by its two ends ──
  await check('a long quote abbreviated to textStart,textEnd still matches', async () => {
    const built = annotationAddress(`${base}/page?id=j`, { exact: LONG });
    const directive = built.slice(built.indexOf('text=') + 'text='.length);
    assert.ok(directive.includes(','), `the helper did not abbreviate: ${directive}`);
    await host(`spike.add('j', ${JSON.stringify(built)})`);
    const guest = await until(() => { const found = guestFor('j'); return found && !found.isLoading() ? found : null; });
    assert.ok(guest, 'the guest never attached');
    const probe = await settled(guest, 'long');
    assert.ok(probe.scrollY > 100, `did not scroll: ${JSON.stringify(probe)}`);
    assert.ok(probe.inView, `the long paragraph is not in view: ${JSON.stringify(probe)}`);
  });

  // ── 11. A page that already has a fragment of its own ──
  await check('a directive appended to the page\'s own fragment still scrolls to the text', async () => {
    // One `#`, then `:~:` — `#first:~:text=…`. The page's fragment says go to
    // the first paragraph and the directive says go to the unique one; the
    // directive is expected to win, and nothing is expected to break.
    const built = annotationAddress(`${base}/page?id=k#first`, { exact: UNIQUE });
    assert.ok(built.includes('#first:~:text='), `wrong shape: ${built}`);
    await host(`spike.add('k', ${JSON.stringify(built)})`);
    const guest = await until(() => { const found = guestFor('k'); return found && !found.isLoading() ? found : null; });
    assert.ok(guest, 'the guest never attached');
    const probe = await settled(guest, 'unique');
    assert.ok(probe.inView, `the directive did not win over the element anchor: ${JSON.stringify(probe)}`);
    assert.equal(withoutFragmentDirective(guest.getURL()), `${base}/page?id=k#first`,
      'the page\'s own fragment survives for the address bar');
  });

  // ── 12. CAPTURE: what a right-click on a selection actually delivers ──
  // The menu in `WebPanel.tsx` never appeared on any site. The wiring looked
  // right, which is the case for reading the event's shape rather than
  // assuming it (docs/ANNOTATIONS.md, capture).
  let delivered = null;
  await check('a right-click on a selection reaches the renderer with the selected text', async () => {
    await host(`spike.add('m', ${JSON.stringify(`${base}/page?id=m`)})`);
    const guest = await until(() => { const found = guestFor('m'); return found && !found.isLoading() ? found : null; });
    assert.ok(guest, 'the guest never attached');

    // Select the unique paragraph inside the page, and find where it is.
    const box = await guest.executeJavaScript(`(() => {
      const element = document.getElementById('unique');
      element.scrollIntoView({ block: 'center' });
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const rect = element.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2),
               selected: String(window.getSelection()) };
    })()`);
    assert.ok(box.selected.length > 0, 'nothing was selected in the page');

    // `sendInputEvent` needs the containing window focused (Electron's docs).
    window_.focus();
    guest.focus();
    await sleep(200);
    for (const type of ['mouseDown', 'mouseUp']) {
      guest.sendInputEvent({ type, button: 'right', x: box.x, y: box.y, clickCount: 1 });
    }
    delivered = await until(async () => host('window.lastContextMenu'), 4000);
    assert.ok(delivered, 'the renderer never saw a context-menu event at all');
    console.log(`     on the event:  ${JSON.stringify(delivered.onEvent)}`);
    console.log(`     event.params:  ${delivered.hasParams ? JSON.stringify(delivered.onParams) : 'ABSENT'}`);

    // THE SHAPE `WebPanel.tsx` DEPENDS ON. Every other webview event this app
    // reads carries its fields directly on the DOM event; this one does not,
    // and reading them there returned `undefined` — an empty selection, so the
    // menu never opened on any page. Asserted so an upgrade that flattens it
    // fails here rather than silently removing the feature.
    assert.equal(delivered.hasParams, true, 'the payload is no longer under `params`');
    assert.equal(delivered.onParams.selectionText, box.selected,
      '`params.selectionText` is not the text that was selected');
    assert.equal(typeof delivered.onParams.x, 'number', '`params` carries where the click was');
    assert.equal(delivered.onEvent.selectionText, undefined,
      'the event itself now carries the fields too — WebPanel may read either, and this note is stale');
  });

  // ── 13. WHICH ORIGIN are params.x and params.y measured from? ──
  // Check 12 could not answer this: its webview sits at the window's origin, so
  // webview-relative and window-relative are the same number. A panel on the
  // right of a split is offset by hundreds of pixels, and a menu positioned
  // inside the panel from a window-relative coordinate lands outside it —
  // which looks exactly like nothing happening (docs/ANNOTATIONS.md, capture).
  const OFFSET_LEFT = 250;
  const OFFSET_TOP = 120;
  await check('params.x and params.y are WINDOW coordinates, and the surface\'s rect converts them', async () => {
    await host(`window.lastContextMenu = null; spike.addOffset('n', ${JSON.stringify(`${base}/page?id=n`)}, ${OFFSET_LEFT}, ${OFFSET_TOP})`);
    const guest = await until(() => { const found = guestFor('n'); return found && !found.isLoading() ? found : null; });
    assert.ok(guest, 'the guest never attached');

    const box = await guest.executeJavaScript(`(() => {
      const element = document.getElementById('unique');
      element.scrollIntoView({ block: 'center' });
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const rect = element.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`);

    window_.focus();
    guest.focus();
    await sleep(200);
    // Sent in the GUEST's own coordinates, which is what sendInputEvent takes.
    for (const type of ['mouseDown', 'mouseUp']) {
      guest.sendInputEvent({ type, button: 'right', x: box.x, y: box.y, clickCount: 1 });
    }
    const seen = await until(async () => host('window.lastContextMenu'), 4000);
    assert.ok(seen, 'the offset webview never reported a context-menu event');

    const asWebview = { x: box.x, y: box.y };
    const asWindow = { x: box.x + OFFSET_LEFT, y: box.y + OFFSET_TOP };
    console.log(`     sent, in the webview:    ${JSON.stringify(asWebview)}`);
    console.log(`     params reported:         ${JSON.stringify(seen.onParams)}`);
    console.log(`     surface rect:            ${JSON.stringify(seen.surface)}`);
    console.log(`     params minus that rect:  ${JSON.stringify(seen.converted)}`);

    const near = (a, b) => Math.abs(a - b) <= 2;
    assert.ok(near(seen.onParams.x, asWindow.x) && near(seen.onParams.y, asWindow.y),
      `expected WINDOW coordinates ${JSON.stringify(asWindow)}, got ${JSON.stringify(seen.onParams)}`);
    assert.ok(!near(seen.onParams.x, asWebview.x),
      'the coordinate is no longer offset by the surface — the conversion below is now wrong');
    // The invariant the app depends on: subtracting the surface's own rect
    // recovers the point inside it, which is where the menu has to be drawn.
    assert.ok(near(seen.converted.x, asWebview.x) && near(seen.converted.y, asWebview.y),
      `the conversion did not recover the click: ${JSON.stringify(seen.converted)}`);
  });

  // ── 14. THE ANCHOR, end to end: capture a repeated phrase and go back to it ──
  // The whole point of prefix/suffix, run through the app's own code: the
  // script that reads them, the checker that trusts nothing the page said, and
  // the address builder. The phrase is on the page TWICE (docs/ANNOTATIONS.md,
  // capture).
  await check('an anchor read from the page sends you back to the right copy', async () => {
    await host(`spike.add('p', ${JSON.stringify(`${base}/page?id=p`)})`);
    const guest = await until(() => { const found = guestFor('p'); return found && !found.isLoading() ? found : null; });
    assert.ok(guest, 'the guest never attached');

    // Select the SECOND copy, the way a person would.
    await guest.executeJavaScript(`(() => {
      const element = document.getElementById('second');
      const text = element.firstChild;
      const start = text.data.indexOf(${JSON.stringify(REPEATED)});
      const range = document.createRange();
      range.setStart(text, start);
      range.setEnd(text, start + ${REPEATED.length});
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    })()`);

    const anchor = readAnchor(await guest.executeJavaScript(anchorScript()));
    assert.ok(anchor, 'the page reported no anchor');
    console.log(`     exact:  ${JSON.stringify(anchor.exact)}`);
    console.log(`     prefix: ${JSON.stringify(anchor.prefix)}`);
    console.log(`     suffix: ${JSON.stringify(anchor.suffix)}`);
    assert.equal(anchor.exact, REPEATED);
    assert.ok(anchor.prefix.includes('Zulu'), 'the prefix did not come from the second copy');
    assert.ok(anchor.suffix.includes('Yankee'), 'the suffix did not come from the second copy');

    // Now go back to it, through the address the app would build.
    await guest.loadURL(annotationAddress(`${base}/page?id=p&back=1`, anchor));
    const second = await settled(guest, 'second');
    const first = await guest.executeJavaScript(`window.probe('first')`);
    assert.ok(second.inView, `did not land on the second copy: ${JSON.stringify(second)}`);
    assert.ok(!first.inView, 'the first copy is in view too, so this proves nothing');
  });

  // ── 15. Without an anchor, the same quote lands on the FIRST copy ──
  // The degraded case the capture falls back to when the page will not report
  // an anchor — a selection inside an iframe, say. Worth knowing precisely,
  // because it is what a person gets rather than an error.
  await check('a quote with no anchor lands on the first copy, not nowhere', async () => {
    await host(`spike.add('q', ${JSON.stringify(`${base}/page?id=q`)})`);
    const guest = await until(() => { const found = guestFor('q'); return found && !found.isLoading() ? found : null; });
    assert.ok(guest, 'the guest never attached');
    await guest.loadURL(annotationAddress(`${base}/page?id=q&back=1`, { exact: REPEATED }));
    const first = await settled(guest, 'first');
    assert.ok(first.inView, `did not land on the first copy: ${JSON.stringify(first)}`);
  });

  // ── 16. Is the passage actually HIGHLIGHTED, or only scrolled to? ──
  // Every other check reads scroll position, which says the reader was taken to
  // the passage but not that they can SEE which one it is. This reads pixels:
  // the page is black on white, so any coloured pixel in the target's box is
  // Chromium painting the fragment (docs/ANNOTATIONS.md, navigating).
  await check('the passage is painted, not just scrolled to', async () => {
    const coloured = async (guest, id) => {
      const rect = await guest.executeJavaScript(`(() => {
        const element = document.getElementById(${JSON.stringify(id)});
        const box = element.getBoundingClientRect();
        return { x: Math.max(0, Math.round(box.left)), y: Math.max(0, Math.round(box.top)),
                 width: Math.round(box.width), height: Math.round(box.height) };
      })()`);
      if (rect.width < 2 || rect.height < 2) return -1;
      const image = await guest.capturePage(rect);
      const pixels = image.toBitmap(); // BGRA
      let count = 0;
      for (let at = 0; at + 3 < pixels.length; at += 4) {
        const [blue, green, red] = [pixels[at], pixels[at + 1], pixels[at + 2]];
        // Black text on a white page is grey; anything with a channel spread is paint.
        if (Math.max(red, green, blue) - Math.min(red, green, blue) > 40) count++;
      }
      return count;
    };

    // Baseline: the same paragraph, scrolled into view WITHOUT a directive.
    await host(`spike.add('r', ${JSON.stringify(`${base}/page?id=r`)})`);
    const plain = await until(() => { const found = guestFor('r'); return found && !found.isLoading() ? found : null; });
    assert.ok(plain, 'the guest never attached');
    await plain.executeJavaScript(`document.getElementById('unique').scrollIntoView({ block: 'center' })`);
    await sleep(500);
    const before = await coloured(plain, 'unique');

    // The same page, reached through an annotation address.
    await host(`spike.add('s', ${JSON.stringify(annotationAddress(`${base}/page?id=s`, { exact: UNIQUE }))})`);
    const marked = await until(() => { const found = guestFor('s'); return found && !found.isLoading() ? found : null; });
    assert.ok(marked, 'the guest never attached');
    await settled(marked, 'unique');
    await sleep(500);
    const after = await coloured(marked, 'unique');

    // And a moment later — does it stay, or fade?
    await sleep(2500);
    const later = await coloured(marked, 'unique');

    console.log(`     coloured pixels — plain: ${before}  annotated: ${after}  after 2.5s: ${later}`);
    assert.ok(before >= 0 && after >= 0, 'the target box could not be captured');
    assert.ok(after > before + 50, `no paint appeared: plain ${before}, annotated ${after}`);
  });

  // ── 17. Clicking the SAME annotation again, on a page already open ──
  // The complaint this answers: the panel was already open, so the click did
  // nothing and felt stuck. If re-loading the same address re-scrolls and
  // re-paints, the click has an answer of its own and needs no toast to
  // explain itself (docs/ANNOTATIONS.md, navigating).
  await check('re-opening the same passage scrolls back to it and paints it again', async () => {
    const address = annotationAddress(`${base}/page?id=t`, { exact: UNIQUE });
    await host(`spike.add('t', ${JSON.stringify(address)})`);
    const guest = await until(() => { const found = guestFor('t'); return found && !found.isLoading() ? found : null; });
    assert.ok(guest, 'the guest never attached');
    const arrived = await settled(guest, 'unique');
    assert.ok(arrived.inView, 'did not arrive at the passage');

    // The person reads on, and scrolls away — the state the complaint is about.
    const loadedAt = await guest.executeJavaScript('window.loadedAt');
    await guest.executeJavaScript('window.scrollTo(0, 0)');
    await sleep(300);
    assert.equal((await guest.executeJavaScript(`window.probe('unique')`)).scrollY, 0, 'did not scroll away');

    // They click the same annotation again.
    await guest.loadURL(address);
    const back = await settled(guest, 'unique');
    const same = await guest.executeJavaScript('window.loadedAt') === loadedAt;
    console.log(`     back at the passage: ${back.inView}  scrollY=${back.scrollY}  document kept: ${same}`);
    assert.ok(back.inView, `the identical address did not take them back: ${JSON.stringify(back)}`);
  });

  // ── 8. The guard is still the guard, with all this going on ──
  await check('every page ran in the account partition, sandboxed, without Node', async () => {
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'i', 'j', 'k', 'm', 'p', 'q', 'r', 's', 't']) {
      const guest = guestFor(id);
      assert.ok(guest, `guest ${id} is gone`);
      assert.equal(guest.session, session.fromPartition(PARTITION), `guest ${id} is in the wrong session`);
      const node = await guest.executeJavaScript('typeof process').catch(() => 'undefined');
      assert.equal(node, 'undefined', `guest ${id} has Node`);
    }
  });

  server.close();
  const failed = results.filter(result => !result.ok);
  console.log(`\nElectron ${process.versions.electron}, Chromium ${process.versions.chrome}: ${results.length - failed.length} passed, ${failed.length} failed`);
  console.log(`loadURL with only the fragment changed: ${samePage && samePage.scrollY > 100 ? 'scrolls' : 'does not scroll'}, document ${sameDocument ? 'SURVIVED' : 'was RELOADED'}`);
  console.log(`location.hash, WITH a user gesture:    ${scripted && scripted.scrollY > 100 ? "scrolls" : "does not scroll"}`);
  console.log(`location.hash, WITHOUT a user gesture: ${ungestured && ungestured.scrollY > 100 ? "scrolls" : "DOES NOT SCROLL — the gesture is the gate"}`);
  app.exit(failed.length === 0 ? 0 : 1);
});
