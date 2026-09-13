// TanStack Hotkeys admission spike (SHORTCUTS.md, "TanStack behavior spike").
//
//   npm test
//
// Runs inside real Electron so key events travel Chromium's input pipeline
// (webContents.sendInputEvent) and arrive trusted, the way a person's typing
// does. IME composition and AltGraph cannot be produced that way, so those
// cases use constructed KeyboardEvents and say so in their names.
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

const settle = () => new Promise(resolve => setTimeout(resolve, 30));

async function run(win) {
  const page = source => win.webContents.executeJavaScript(source);
  const press = async (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await settle();
  };
  const fresh = () => page('spike.reset()');
  const read = () => page('spike.read()');

  await page(
    `spike.setCatalogue(${JSON.stringify({
      'app.search.open': { hotkeys: ['Mod+K'], inputPolicy: 'allow-editable' },
      'shell.sidebar.toggle': { hotkeys: ['Mod+B'], inputPolicy: 'deny-editable' },
      'navigation.back': { hotkeys: ['Mod+['], inputPolicy: 'deny-editable' },
      'navigation.forward': { hotkeys: ['Mod+]'], inputPolicy: 'deny-editable' },
      'app.settings.open': { hotkeys: ['Mod+,'], inputPolicy: 'allow-editable' },
      'app.shortcuts.open': { hotkeys: ['Mod+/'], inputPolicy: 'allow-editable' },
    })})`,
  );

  // ── Library lifecycle under React StrictMode ──────────────────────────────
  await check('StrictMode mount leaves exactly one document keydown listener', async () => {
    const before = (await page('spike.counts()')).keydown;
    await page('spike.mount()');
    await settle();
    assert.equal((await page('spike.counts()')).keydown - before, 1);
  });

  // ── Trusted events: Mod, punctuation, exact modifiers ─────────────────────
  await check('trusted events arrive with isTrusted and a logical key', async () => {
    await fresh();
    await press('K', ['meta']);
    const [event] = (await read()).observed;
    assert.equal(event.trusted, true);
    assert.equal(event.meta, true);
    assert.match(event.key, /^[kK]$/);
  });

  await check('Cmd+K invokes app.search.open on mac', async () => {
    await fresh();
    await press('K', ['meta']);
    const { invocations } = await read();
    assert.deepEqual(
      invocations.map(hit => hit.id),
      ['app.search.open'],
    );
    assert.equal(invocations[0].prevented, true);
  });

  await check('Control+K does not match Mod+K on mac', async () => {
    await fresh();
    await press('K', ['control']);
    assert.deepEqual((await read()).invocations, []);
  });

  await check('modifiers match exactly: Cmd+Shift+K is not Mod+K', async () => {
    await fresh();
    await press('K', ['meta', 'shift']);
    assert.deepEqual((await read()).invocations, []);
  });

  for (const [keyCode, id] of [
    ['/', 'app.shortcuts.open'],
    [',', 'app.settings.open'],
    ['[', 'navigation.back'],
    [']', 'navigation.forward'],
  ]) {
    await check(`Cmd+${keyCode} invokes ${id}`, async () => {
      await fresh();
      await press(keyCode, ['meta']);
      const { invocations, observed } = await read();
      assert.deepEqual(
        invocations.map(hit => hit.id),
        [id],
        JSON.stringify(observed),
      );
    });
  }

  await check('shifted punctuation: what Cmd+Shift+/ reports and normalizes to', async () => {
    await fresh();
    await press('/', ['meta', 'shift']);
    const { skips, observed } = await read();
    shifted.observed = observed[0];
    shifted.skip = skips[0];
  });

  // ── Dispatch algorithm guards ─────────────────────────────────────────────
  await check('an earlier owner calling preventDefault wins; nothing dispatches', async () => {
    await fresh();
    await page('spike.blockNext()');
    await press('K', ['meta']);
    const { invocations, skips } = await read();
    assert.deepEqual(invocations, []);
    assert.deepEqual(skips, ['defaultPrevented']);
  });

  await check('auto-repeat is ignored unless the command opts in', async () => {
    await fresh();
    win.webContents.sendInputEvent({
      type: 'keyDown',
      keyCode: 'K',
      modifiers: ['meta', 'isAutoRepeat'],
    });
    await settle();
    const { invocations, skips, observed } = await read();
    assert.equal(observed[0]?.repeat, true, 'Chromium did not mark the event as repeat');
    assert.deepEqual(invocations, []);
    assert.deepEqual(skips, ['repeat']);
  });

  for (const [selector, editable] of [
    ['#text', true],
    ['#textarea', true],
    ['#select', true],
    ['#editable', true],
    ['#button', false],
    ['#checkbox', false],
    ['#capture', false],
  ]) {
    await check(
      `deny-editable Mod+B with focus on ${selector} ${editable ? 'is skipped' : 'dispatches'}`,
      async () => {
        await fresh();
        assert.equal(await page(`spike.focus('${selector}')`), true, 'could not focus');
        await press('B', ['meta']);
        const { invocations, skips } = await read();
        if (editable) {
          assert.deepEqual(invocations, []);
          assert.deepEqual(skips, ['editable']);
        } else {
          assert.deepEqual(
            invocations.map(hit => hit.id),
            ['shell.sidebar.toggle'],
          );
        }
      },
    );
  }

  await check('allow-editable Mod+K still dispatches from a focused textarea', async () => {
    await fresh();
    await page(`spike.focus('#textarea')`);
    await press('K', ['meta']);
    assert.deepEqual(
      (await read()).invocations.map(hit => hit.id),
      ['app.search.open'],
    );
  });

  // ── One listener, dynamic bindings ────────────────────────────────────────
  await check('rebinding changes matching without touching the listener count', async () => {
    await fresh();
    const before = (await page('spike.counts()')).keydown;
    await page(
      `spike.setCatalogue({ 'app.search.open': { hotkeys: ['Mod+Shift+P'], inputPolicy: 'allow-editable' } })`,
    );
    await press('K', ['meta']);
    await press('P', ['meta', 'shift']);
    const { invocations } = await read();
    assert.deepEqual(
      invocations.map(hit => hit.chord),
      ['Mod+Shift+P'],
    );
    assert.equal((await page('spike.counts()')).keydown, before);
  });

  // ── Recorder ──────────────────────────────────────────────────────────────
  await check('recorder round trip: capture -> JSON -> index -> trusted match', async () => {
    await fresh();
    await page(`spike.focus('#capture')`);
    assert.equal(await page('spike.startRecorder()'), true);
    await press('J', ['meta', 'shift']);
    const { recorded, invocations } = await read();
    assert.equal(recorded.length, 1);
    const stored = JSON.stringify([{ kind: 'chord', hotkey: recorded[0].hotkey }]);
    const [binding] = JSON.parse(stored);
    assert.equal(binding.hotkey, 'Mod+Shift+J');
    assert.deepEqual(invocations, [], 'the recorder must beat the dispatcher');
    await page('spike.stopRecorder()');
    await page(
      `spike.setCatalogue({ 'app.search.open': { hotkeys: [${JSON.stringify(binding.hotkey)}], inputPolicy: 'allow-editable' } })`,
    );
    await fresh();
    await press('J', ['meta', 'shift']);
    assert.deepEqual(
      (await read()).invocations.map(hit => hit.id),
      ['app.search.open'],
    );
  });

  await check('recorder: a pure modifier press does not record', async () => {
    await fresh();
    await page('spike.startRecorder()');
    await press('Shift', ['shift']);
    await press('Meta', ['meta']);
    assert.deepEqual((await read()).recorded, []);
    assert.equal((await page('spike.recorderState()')).isRecording, true);
    await page('spike.stopRecorder()');
  });

  await check('recorder: Escape cancels', async () => {
    await fresh();
    await page('spike.startRecorder()');
    await press('Escape');
    assert.deepEqual((await read()).recorded, [{ cancelled: true }]);
    await page('spike.stopRecorder()');
  });

  await check('recorder: bare Backspace clears and records an empty hotkey', async () => {
    await fresh();
    await page('spike.startRecorder()');
    await press('Backspace');
    assert.deepEqual((await read()).recorded, [{ cleared: true }, { hotkey: '' }]);
    await page('spike.stopRecorder()');
  });

  await check(
    'recorder: default ignoreInputs refuses a focused text input as capture control',
    async () => {
      await fresh();
      await page(`spike.focus('#text')`);
      await page('spike.startRecorder()');
      await press('J', ['meta']);
      assert.deepEqual((await read()).recorded, []);
      await page('spike.stopRecorder()');
    },
  );

  await check('recorder: destroy removes its capture listener', async () => {
    const before = (await page('spike.counts()')).keydown;
    await page('spike.startRecorder()');
    assert.equal((await page('spike.counts()')).keydown, before + 1);
    await page('spike.stopRecorder()');
    assert.equal((await page('spike.counts()')).keydown, before);
  });

  // ── Constructed events: IME, AltGraph, layout fallback ────────────────────
  const synthetic = await page('spike.syntheticCases()');

  await check('constructed: isComposing never dispatches', async () => {
    assert.deepEqual(synthetic.composing.invocations, []);
    assert.deepEqual(synthetic.composing.skips, ['composing']);
  });

  await check(
    'constructed: TanStack matcher does NOT filter composition (Relayed must)',
    async () => {
      assert.equal(synthetic.composingMatcherSays, true);
    },
  );

  await check('constructed: AltGraph modifier state is readable and skips dispatch', async () => {
    assert.equal(synthetic.altGraphModifierState, true);
    assert.deepEqual(synthetic.altGraph.skips, ['altgraph']);
  });

  await check(
    'constructed: TanStack matcher treats AltGraph as Control+Alt (Relayed must filter)',
    async () => {
      assert.equal(synthetic.altGraphMatcherSays, true);
    },
  );

  await check(
    'constructed: physical Slash producing "-" does not match Mod+/ in the Relayed index',
    async () => {
      assert.deepEqual(synthetic.physicalSlashDispatcher.invocations, []);
    },
  );

  await check(
    'constructed: TanStack matcher DOES match it through its event.code fallback',
    async () => {
      assert.equal(synthetic.physicalSlashMatcherSays, true);
    },
  );

  await check('constructed: textbox role and shadow-DOM input count as editable', async () => {
    assert.deepEqual(synthetic.textboxRole.skips, ['editable']);
    assert.deepEqual(synthetic.shadowInput.skips, ['editable']);
  });

  await check(
    'constructed: Windows Control+K normalizes to Mod+K, Windows Meta+K does not',
    async () => {
      assert.equal(synthetic.windowsCtrlK, 'Mod+K');
      assert.equal(synthetic.windowsMetaK, 'Meta+K');
    },
  );

  // ── Pure functions across platforms ───────────────────────────────────────
  const pure = await page('spike.pure()');

  await check('aliases normalize to one index key per platform', async () => {
    assert.equal(pure.normalize.macCmd, 'Mod+K');
    assert.equal(pure.normalize.macMeta, 'Mod+K');
    assert.equal(pure.normalize.winControl, 'Mod+K');
    assert.equal(pure.normalize.winMod, 'Mod+K');
    assert.equal(pure.normalize.linuxMod, 'Mod+K');
    assert.equal(pure.normalize.orderShiftFirst, 'Mod+Shift+P');
  });

  await check('Control on mac stays distinct from Mod', async () => {
    assert.equal(pure.normalize.macCtrl, 'Control+K');
  });

  await check('catalogue defaults normalize on every platform', async () => {
    assert.equal(pure.normalize.altArrow, 'Alt+ArrowLeft');
    assert.equal(pure.normalize.enter, 'Enter');
    assert.equal(pure.normalize.modEnter, 'Mod+Enter');
    assert.deepEqual(pure.normalize.punctuation, ['Mod+/', 'Mod+,', 'Mod+[', 'Mod+]']);
  });

  await check('Mod resolves to Control on windows and Meta on mac', async () => {
    assert.equal(pure.parse.modWindows.ctrl, true);
    assert.equal(pure.parse.modWindows.meta, false);
    assert.equal(pure.parse.modMac.meta, true);
  });

  await check('parsed hotkeys format to WAI-ARIA tokens', async () => {
    assert.equal(pure.display.ariaFromParsedMac, 'Meta+K');
    assert.equal(pure.display.ariaFromParsedWindows, 'Control+K');
  });

  await check('StrictMode unmount removes the dispatcher listener', async () => {
    const before = (await page('spike.counts()')).keydown;
    await page('spike.unmount()');
    assert.equal((await page('spike.counts()')).keydown, before - 1);
  });

  return { pure, synthetic };
}

const shifted = {};

async function checkMainProcessImports() {
  await check('main process can require the CommonJS build', async () => {
    const hotkeys = require('@tanstack/hotkeys');
    assert.equal(hotkeys.normalizeHotkey('Cmd+K', 'mac'), 'Mod+K');
  });
  await check('main process can import the ESM build', async () => {
    const hotkeys = await import('@tanstack/hotkeys');
    assert.equal(hotkeys.normalizeHotkey('Ctrl+K', 'windows'), 'Mod+K');
  });
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 640, height: 480, show: true });
  await win.loadFile(path.join(__dirname, 'renderer.html'));
  win.focus();
  win.webContents.focus();
  await settle();

  let details = {};
  try {
    await checkMainProcessImports();
    details = await run(win);
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
  console.log('\nRecorded, not asserted:');
  console.log(
    '  Cmd+Shift+/ event:',
    JSON.stringify(shifted.observed),
    'dispatcher:',
    shifted.skip,
  );
  console.log(
    '  Option+K normalizes to:',
    details.synthetic?.optionKNormalized,
    '| matcher says Alt+K:',
    details.synthetic?.optionKMatcherSaysAltK,
  );
  console.log('  Cmd+л (KeyK) matcher says Mod+K:', details.synthetic?.cyrillicMatcherSays);
  console.log('  display:', JSON.stringify(details.pure?.display));
  console.log('  validate:', JSON.stringify(details.pure?.validate));
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  app.exit(failed.length ? 1 : 0);
});
