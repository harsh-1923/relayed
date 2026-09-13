// The application menu under real Electron (SHORTCUTS.md, native application
// menu step).
//
//   npm run test:menu
//
// Builds the app's menu template with Electron's own Menu, then clicks the
// Relayed items and follows the command through the app's REAL preload
// (bundled from apps/desktop/src/preload) into the page. What this cannot do is
// press a key the menu sees: sendInputEvent never reaches menu accelerators, so
// that half — one invocation per key press — is confirmed by hand.
const { app, BrowserWindow, Menu } = require('electron');
const path = require('node:path');
const assert = require('node:assert/strict');
const menu = require('./dist/menu.cjs');

const results = [];
async function check(name, body) {
  try {
    await body();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, detail: error.message.split('\n').slice(0, 6).join(' ') });
  }
}
const settle = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms));
const walk = items =>
  items.flatMap(item => [item, ...(item.submenu ? walk(item.submenu.items) : [])]);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 400,
    height: 300,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'dist', 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  const invoke = id =>
    (BrowserWindow.getFocusedWindow() ?? win).webContents.send('command:invoke', id);
  await win.loadURL(
    'data:text/html,<body><script>window.received=[];window.relayed.onCommand(id=>received.push(id));</script></body>',
  );
  await settle(300);
  const page = source => win.webContents.executeJavaScript(source);

  for (const platform of ['mac', 'windows', 'linux']) {
    await check(`Electron builds the ${platform} template without complaint`, async () => {
      const built = Menu.buildFromTemplate(
        menu.buildMenuTemplate(platform, menu.defaultMenuItems(platform), invoke, 'Relayed'),
      );
      assert.ok(built.items.length >= 4);
    });
  }

  const built = Menu.buildFromTemplate(
    menu.buildMenuTemplate('mac', menu.defaultMenuItems('mac'), invoke, 'Relayed'),
  );
  Menu.setApplicationMenu(built);

  await check(
    'installed, the Edit menu still carries copy, paste and undo from its role',
    async () => {
      const roles = walk(Menu.getApplicationMenu().items)
        .map(item => item.role)
        .filter(Boolean);
      for (const role of [
        'copy',
        'paste',
        'undo',
        'selectall',
        'quit',
        'close',
        'minimize',
        'reload',
      ]) {
        assert.ok(roles.includes(role), role);
      }
    },
  );

  await check('the Relayed items display their accelerators', async () => {
    const byId = id => built.getMenuItemById(id);
    assert.equal(byId('app.search.open').accelerator, 'Command+K');
    assert.equal(byId('app.settings.open').accelerator, 'Command+,');
    assert.equal(byId('app.shortcuts.open').accelerator, 'Command+/');
  });

  await check('clicking each item reaches the page through the real preload, once', async () => {
    for (const id of ['app.search.open', 'app.settings.open', 'app.shortcuts.open'])
      built.getMenuItemById(id).click();
    await settle();
    assert.deepEqual(await page('received'), [
      'app.search.open',
      'app.settings.open',
      'app.shortcuts.open',
    ]);
  });

  await check('the preload drops an ID that is not on the menu allow-list', async () => {
    await page('received.length = 0');
    for (const id of ['shell.sidebar.toggle', 'app.teleport', 42, null])
      win.webContents.send('command:invoke', id);
    win.webContents.send('command:invoke', 'app.search.open');
    await settle();
    assert.deepEqual(await page('received'), ['app.search.open']);
  });

  await check('unsubscribing stops delivery', async () => {
    await page(
      'received.length = 0; window.off = window.relayed.onCommand(id => received.push("second:" + id)); window.off();',
    );
    invoke('app.search.open');
    await settle();
    assert.deepEqual(
      await page('received'),
      ['app.search.open'],
      'only the first subscriber remains',
    );
  });

  await check(
    'before-input-event sees the key the guard needs, and claims only Relayed chords',
    async () => {
      const seen = [];
      win.webContents.on('before-input-event', (_event, input) => {
        if (input.type === 'keyDown')
          seen.push([
            input.key,
            menu.shouldIgnoreMenuShortcut(input, 'mac', menu.defaultMenuItems('mac')),
          ]);
      });
      win.focus();
      win.webContents.focus();
      for (const [keyCode, modifiers] of [
        ['K', ['meta']],
        ['C', ['meta']],
        [',', ['meta']],
      ]) {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
      }
      await settle();
      assert.deepEqual(seen, [
        ['k', true],
        ['c', false],
        [',', true],
      ]);
    },
  );

  const failed = results.filter(result => !result.ok);
  console.log(`\nElectron ${process.versions.electron} | Chromium ${process.versions.chrome}\n`);
  for (const result of results)
    console.log(
      `  ${result.ok ? 'ok  ' : 'FAIL'} ${result.name}${result.ok ? '' : `\n       -> ${result.detail}`}`,
    );
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  app.exit(failed.length ? 1 : 0);
});
