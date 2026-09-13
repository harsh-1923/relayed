// Composer send under trusted key events.
//
//   npm run test:composer
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
const settle = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 640, height: 480, show: true });
  await win.loadFile(path.join(__dirname, 'composer.html'));
  win.focus();
  win.webContents.focus();
  const page = source => win.webContents.executeJavaScript(source);
  const key = async (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (!modifiers.some(modifier => modifier !== 'shift') && keyCode.length === 1) {
      win.webContents.sendInputEvent({ type: 'char', keyCode, modifiers });
    }
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await settle();
  };
  const type = async text => {
    for (const character of text) await key(character);
  };
  const fresh = async (content = '') => {
    for (let attempt = 0; attempt < 25; attempt++) {
      await page(`spike.reset(${JSON.stringify(content)})`);
      await settle(40);
      if (await page('spike.focused()')) break;
    }
    await page('spike.take()');
  };

  await page('spike.mount()');
  await settle(300);

  await check('typing then Return sends the text', async () => {
    await fresh();
    await type('hi');
    await key('Return');
    assert.deepEqual(await page('spike.take()'), ['hi']);
  });

  await check('Shift+Return does not send and breaks the line', async () => {
    await fresh();
    await type('a');
    await key('Return', ['shift']);
    assert.deepEqual(await page('spike.take()'), []);
    assert.match(await page('spike.html()'), /<br>/);
  });

  await check('inside a code block Return is a newline and Cmd+Return sends', async () => {
    await fresh('<pre><code>one</code></pre>');
    await key('Return');
    assert.deepEqual(await page('spike.take()'), []);
    assert.match(await page('spike.html()'), /one\n/);
    await key('Return', ['meta']);
    assert.equal((await page('spike.take()')).length, 1);
  });

  await check('with the @ menu open, Return does not send', async () => {
    await fresh();
    await type('hey @a');
    assert.equal(await page('spike.triggerOpen()'), true, 'the suggestion did not open');
    await key('Return');
    await key('Return', ['meta']);
    assert.deepEqual(await page('spike.take()'), []);
    assert.equal(await page('spike.triggerOpen()'), true, 'the menu still owns the keys');
  });

  await check('remapped to Cmd+Return only, Return becomes a new paragraph', async () => {
    await page(`composer.remap([{ kind: 'chord', hotkey: 'Mod+Enter' }])`);
    await fresh();
    await type('x');
    await key('Return');
    assert.deepEqual(await page('spike.take()'), []);
    assert.match(await page('spike.html()'), /<p>x<\/p><p><\/p>/);
    await key('Return', ['meta']);
    assert.equal((await page('spike.take()')).length, 1);
    await page('composer.remap(undefined)');
  });

  await check('disabled, no key sends', async () => {
    await page(`composer.remap([])`);
    await fresh();
    await type('y');
    await key('Return');
    await key('Return', ['meta']);
    assert.deepEqual(await page('spike.take()'), []);
    await page('composer.remap(undefined)');
  });

  const failed = results.filter(result => !result.ok);
  console.log(`\nElectron ${process.versions.electron} | Chromium ${process.versions.chrome}\n`);
  for (const result of results)
    console.log(
      `  ${result.ok ? 'ok  ' : 'FAIL'} ${result.name}${result.ok ? '' : `\n       -> ${result.detail}`}`,
    );
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  app.exit(failed.length ? 1 : 0);
});
