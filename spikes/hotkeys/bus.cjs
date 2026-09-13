// The app's renderer command bus driven by trusted key events.
//
//   npm run test:bus
//
// Proves the "Renderer command bus" step of SHORTCUTS.md: one command reached
// from a key and from a button, precedence by layer, and nothing leaked under
// React StrictMode. Reuses the harness shape of main.cjs.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const assert = require('node:assert/strict');

const results = [];
async function check(name, body) {
  try {
    await body();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, detail: error.message.split('\n').slice(0, 6).join(' ') });
  }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 40));

async function run(win) {
  const page = source => win.webContents.executeJavaScript(source);
  const press = async (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await settle();
  };
  const take = () => page('bus.take()');

  await check('StrictMode mount nets exactly one document keydown listener', async () => {
    await page(`bus.mount('darwin')`);
    await settle();
    assert.equal((await take()).listenerDelta, 1);
  });

  await check('a trusted Cmd+K runs the handler and prevents the default', async () => {
    await press('K', ['meta']);
    assert.deepEqual((await take()).log, ['app:0']);
    assert.equal(await page('bus.lastDefault()'), true);
  });

  await check("the handler runs its latest closure, not the first render's", async () => {
    await press('K', ['meta']);
    await press('K', ['meta']);
    assert.deepEqual((await take()).log, ['app:1', 'app:2']);
  });

  await check('the button executes the same command through the bus', async () => {
    await page('bus.click()');
    await settle();
    assert.deepEqual((await take()).log, ['app:3', 'button:handled']);
  });

  await check('the button derives its labels from the effective binding', async () => {
    const button = await page('bus.button()');
    assert.equal(button.aria, 'Meta+K');
    assert.equal(button.title, 'Search (⌘ K)');
    assert.equal(button.disabled, false);
  });

  await check(
    'an overlay handler outranks the application handler, whatever mounted first',
    async () => {
      await page(`bus.scene({ overlay: true })`);
      await settle();
      await press('K', ['meta']);
      assert.deepEqual((await take()).log, ['overlay:0']);
      await page(`bus.scene({ overlay: false })`);
      await settle();
      await press('K', ['meta']);
      assert.deepEqual((await take()).log, ['app:4']);
    },
  );

  await check(
    'with no handler the key is left for the browser and the button disables',
    async () => {
      await page(`bus.scene({ search: false })`);
      await settle();
      await press('K', ['meta']);
      const { log } = await take();
      assert.deepEqual(log, []);
      assert.equal(await page('bus.lastDefault()'), false);
      assert.equal((await page('bus.button()')).disabled, true);
      await page(`bus.scene({ search: true })`);
      await settle();
      assert.equal((await page('bus.button()')).disabled, false);
    },
  );

  await check('a disabled handler does not consume the key', async () => {
    await page(`bus.scene({ sidebarEnabled: false })`);
    await settle();
    await press('B', ['meta']);
    assert.deepEqual((await take()).log, []);
    assert.equal(await page('bus.lastDefault()'), false);
    await page(`bus.scene({ sidebarEnabled: true })`);
    await settle();
    await press('B', ['meta']);
    assert.deepEqual((await take()).log, ['sidebar']);
  });

  await check("deny-editable: Cmd+B in a text field is not the sidebar's", async () => {
    await page(`bus.focus('#text')`);
    await press('B', ['meta']);
    assert.deepEqual((await take()).log, []);
    assert.equal(await page('bus.lastDefault()'), false);
    await press('K', ['meta']);
    assert.deepEqual((await take()).log.length, 1, 'allow-editable search still runs');
    await page('bus.blur()');
  });

  await check(
    'Cmd+B in the Tiptap editor applies bold and does not toggle the sidebar',
    async () => {
      // Tiptap applies focus asynchronously; poll rather than guess a delay.
      let focused = false;
      for (let attempt = 0; attempt < 25 && !focused; attempt++) {
        await page('bus.selectEditorText()');
        await settle();
        focused = await page('bus.editorFocused()');
      }
      assert.equal(focused, true, 'editor did not take focus within a second');
      await press('B', ['meta']);
      const { log } = await take();
      assert.deepEqual(log, []);
      assert.equal(await page('bus.editorHtml()'), '<p><strong>hello</strong></p>');
      await page('bus.blur()');
      await press('B', ['meta']);
      assert.deepEqual(
        (await take()).log,
        ['sidebar'],
        'outside the editor Cmd+B is the sidebar again',
      );
    },
  );

  await check(
    'one remap moves matching, title, aria-keyshortcuts and the Shortcut display together',
    async () => {
      const before = await page('bus.button()');
      assert.deepEqual(
        [before.title, before.aria, before.shortcut, before.shortcutAria],
        ['Search (⌘ K)', 'Meta+K', '⌘K', 'Meta+K'],
      );
      await page(`bus.remap('app.search.open', [{ kind: 'chord', hotkey: 'Mod+Shift+P' }])`);
      await settle();
      await take();
      await press('K', ['meta']);
      assert.deepEqual((await take()).log, [], 'the old chord no longer matches');
      await press('P', ['meta', 'shift']);
      assert.equal((await take()).log.length, 1, 'the new chord does');
      const after = await page('bus.button()');
      assert.deepEqual(
        [after.title, after.aria, after.shortcut, after.shortcutAria],
        ['Search (⌘ ⇧ P)', 'Shift+Meta+P', '⌘⇧P', 'Shift+Meta+P'],
      );
    },
  );

  await check('disabling removes every representation but leaves the button usable', async () => {
    await page(`bus.remap('app.search.open', [])`);
    await settle();
    const state = await page('bus.button()');
    assert.deepEqual(
      [state.title, state.aria, state.shortcut, state.disabled],
      ['Search', null, '', false],
    );
    await page('bus.click()');
    await settle();
    assert.deepEqual((await take()).log.slice(-1), ['button:handled']);
    await press('P', ['meta', 'shift']);
    assert.deepEqual((await take()).log, []);
  });

  await check('reset returns to the default everywhere', async () => {
    await page(`bus.remap('app.search.open', undefined)`);
    await settle();
    await take();
    await press('K', ['meta']);
    assert.equal((await take()).log.length, 1);
    assert.equal((await page('bus.button()')).title, 'Search (⌘ K)');
  });

  await check('recorder: while recording, Cmd+K is captured and search does not run', async () => {
    await page(
      `document.getElementById('record').focus(); document.getElementById('record').click()`,
    );
    await settle();
    assert.equal(await page('bus.recording()'), true);
    await press('K', ['meta']);
    assert.deepEqual((await take()).log, ['recorded:Mod+K']);
    assert.equal(await page('bus.recording()'), false, 'one chord ends recording');
    await press('K', ['meta']);
    assert.equal((await take()).log.length, 1, 'and commands work again');
  });

  await check('recorder: Escape and bare Backspace cancel without recording', async () => {
    for (const key of ['Escape', 'Backspace']) {
      await page(`document.getElementById('record').click()`);
      await settle();
      await press(key);
      assert.deepEqual((await take()).log, [], key);
      assert.equal(await page('bus.recording()'), false, key);
    }
  });

  await check('recorder: unmounting mid-recording removes its listener', async () => {
    const before = (await take()).listenerDelta;
    await page(`document.getElementById('record').click()`);
    await settle();
    assert.equal((await take()).listenerDelta, before + 1);
    await page(`bus.scene({ recorder: false })`);
    await settle();
    assert.equal((await take()).listenerDelta, before);
    await press('K', ['meta']);
    assert.equal((await take()).log.length, 1, 'search runs; nothing was recorded');
    await page(`bus.scene({ recorder: true })`);
    await settle();
  });

  await check(
    'Cmd+[, Cmd+], Cmd+, and Cmd+/ reach back, forward, settings and shortcuts',
    async () => {
      await take();
      await press('[', ['meta']);
      await press(']', ['meta']);
      await press(',', ['meta']);
      await press('/', ['meta']);
      assert.deepEqual((await take()).log, ['back', 'forward', 'settings', 'shortcuts']);
    },
  );

  await check(
    'back with nowhere to go leaves the key alone; back and forward are denied in a text field',
    async () => {
      await page(`bus.scene({ canBack: false })`);
      await settle();
      await press('[', ['meta']);
      assert.deepEqual((await take()).log, []);
      assert.equal(await page('bus.lastDefault()'), false);
      await page(`bus.scene({ canBack: true })`);
      await settle();
      await page(`bus.focus('#text')`);
      await press('[', ['meta']);
      await press(',', ['meta']);
      assert.deepEqual((await take()).log, ['settings'], 'settings is allow-editable; back is not');
      await page('bus.blur()');
    },
  );

  await check('Windows: Alt+ArrowLeft and Alt+ArrowRight navigate', async () => {
    await page('bus.unmount()');
    await page(`bus.mount('win32')`);
    await settle();
    await take();
    await press('Left', ['alt']);
    await press('Right', ['alt']);
    await press('[', ['meta']);
    assert.deepEqual((await take()).log, ['back', 'forward']);
    await page('bus.unmount()');
    await page(`bus.mount('darwin')`);
    await settle();
    await take();
  });

  await check('an earlier owner calling preventDefault wins', async () => {
    await page('bus.preventNext()');
    await press('K', ['meta']);
    assert.deepEqual((await take()).log, []);
  });

  await check('two handlers in one layer: neither runs, and development reports both', async () => {
    await page(`bus.scene({ duplicate: true })`);
    await settle();
    await press('K', ['meta']);
    const { log, errors } = await take();
    assert.deepEqual(log, []);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /app\.search\.open in application/);
    await page(`bus.scene({ duplicate: false })`);
    await settle();
  });

  await check('Windows platform: Control+K is search, Cmd+K is not', async () => {
    await page('bus.unmount()');
    await page(`bus.mount('win32')`);
    await settle();
    await take();
    await press('K', ['control']);
    await press('K', ['meta']);
    assert.equal((await take()).log.length, 1);
    assert.equal((await page('bus.button()')).aria, 'Control+K');
  });

  await check('unmount removes the listener and every handler', async () => {
    await page('bus.unmount()');
    await settle();
    assert.equal((await take()).listenerDelta, 0);
    await press('K', ['meta']);
    await press('K', ['control']);
    assert.deepEqual((await take()).log, []);
  });
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 640, height: 480, show: true });
  await win.loadFile(path.join(__dirname, 'bus.html'));
  win.focus();
  win.webContents.focus();
  await settle();
  try {
    await run(win);
  } catch (error) {
    results.push({ name: 'harness', ok: false, detail: error.stack });
  }
  const failed = results.filter(result => !result.ok);
  console.log(`\nElectron ${process.versions.electron} | Chromium ${process.versions.chrome}\n`);
  for (const result of results) {
    console.log(
      `  ${result.ok ? 'ok  ' : 'FAIL'} ${result.name}${result.ok ? '' : `\n       -> ${result.detail}`}`,
    );
  }
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  app.exit(failed.length ? 1 : 0);
});
