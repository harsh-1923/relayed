// The renderer half of the hotkeys admission spike. main.cjs drives it: it
// calls the setup functions on `window.spike`, sends TRUSTED key events through
// Chromium's input pipeline with webContents.sendInputEvent, then reads back
// what the prototype dispatcher did.
//
// The dispatcher here is the one SHORTCUTS.md describes — one document
// listener, an index of normalized chords, Relayed-owned filtering — built on
// TanStack's pure parse/normalize functions. TanStack's own matcher and
// registration manager are exercised only to record where they differ.
import {
  HotkeyRecorder,
  formatForDisplay,
  formatHotkey,
  matchesKeyboardEvent,
  normalizeHotkey,
  normalizeHotkeyFromEvent,
  parseHotkey,
  validateHotkey,
} from '@tanstack/hotkeys';
import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

const PLATFORM = 'mac';

const listenerCounts = { keydown: 0 };
const addEventListener = Document.prototype.addEventListener;
const removeEventListener = Document.prototype.removeEventListener;
Document.prototype.addEventListener = function (type, ...rest) {
  if (type === 'keydown') listenerCounts.keydown++;
  return addEventListener.call(this, type, ...rest);
};
Document.prototype.removeEventListener = function (type, ...rest) {
  if (type === 'keydown') listenerCounts.keydown--;
  return removeEventListener.call(this, type, ...rest);
};

const EDITABLE_INPUT_TYPES = new Set([
  '',
  'text',
  'search',
  'url',
  'tel',
  'email',
  'password',
  'number',
]);

function isEditableTarget(event) {
  for (const node of event.composedPath()) {
    if (!(node instanceof HTMLElement)) continue;
    if (node instanceof HTMLInputElement) return EDITABLE_INPUT_TYPES.has(node.type.toLowerCase());
    if (node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) return true;
    if (node.isContentEditable) return true;
    if (node.getAttribute('role') === 'textbox') return true;
  }
  return false;
}

// command id -> { hotkeys, inputPolicy, repeat }
let catalogue = {};
let logicalIndex = new Map();
let physicalIndex = new Map();
const invocations = [];
const skips = [];

function rebuildIndex() {
  logicalIndex = new Map();
  physicalIndex = new Map();
  for (const [id, definition] of Object.entries(catalogue)) {
    const index = definition.keyMatch === 'physical' ? physicalIndex : logicalIndex;
    for (const hotkey of definition.hotkeys) index.set(normalizeHotkey(hotkey, PLATFORM), id);
  }
}

function physicalLetterChord(event) {
  const match = /^Key([A-Z])$/.exec(event.code);
  if (!match) return null;
  return normalizeHotkeyFromEvent(
    {
      key: match[1],
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
    },
    PLATFORM,
  );
}

function dispatch(event) {
  if (event.defaultPrevented) return skips.push('defaultPrevented');
  if (event.isComposing || event.keyCode === 229) return skips.push('composing');
  const chord = normalizeHotkeyFromEvent(event, PLATFORM);
  const physicalChord = physicalLetterChord(event);
  const physicalId = physicalChord ? physicalIndex.get(physicalChord) : undefined;
  if (event.getModifierState('AltGraph') && !physicalId) return skips.push('altgraph');
  const id = logicalIndex.get(chord) ?? physicalId;
  if (!id) return skips.push(`unbound:${chord}`);
  const definition = catalogue[id];
  if (event.repeat && definition.repeat !== 'allow') return skips.push('repeat');
  if (definition.inputPolicy === 'deny-editable' && isEditableTarget(event))
    return skips.push('editable');
  event.preventDefault();
  invocations.push({
    id,
    chord: physicalId ? physicalChord : chord,
    prevented: event.defaultPrevented,
  });
}

function Dispatcher() {
  useEffect(() => {
    document.addEventListener('keydown', dispatch);
    return () => document.removeEventListener('keydown', dispatch);
  }, []);
  return null;
}

let root = null;
let recorder = null;
const recorded = [];
const observed = [];

window.addEventListener('keydown', event => {
  observed.push({
    key: event.key,
    code: event.code,
    meta: event.metaKey,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    repeat: event.repeat,
    trusted: event.isTrusted,
  });
});

function synthetic(init) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  document.body.dispatchEvent(event);
  return event;
}

window.spike = {
  platformDetected: () => navigator.platform,
  counts: () => ({ ...listenerCounts }),
  mount() {
    root = createRoot(document.getElementById('root'));
    root.render(
      <StrictMode>
        <Dispatcher />
      </StrictMode>,
    );
  },
  unmount() {
    root.unmount();
    root = null;
  },
  setCatalogue(next) {
    catalogue = next;
    rebuildIndex();
  },
  reset() {
    invocations.length = 0;
    skips.length = 0;
    observed.length = 0;
    recorded.length = 0;
    document.activeElement?.blur?.();
  },
  read: () => ({
    invocations: [...invocations],
    skips: [...skips],
    observed: [...observed],
    recorded: [...recorded],
  }),
  focus(selector) {
    document.querySelector(selector).focus();
    return document.activeElement === document.querySelector(selector);
  },
  blockNext() {
    const block = event => {
      event.preventDefault();
      document.removeEventListener('keydown', block, true);
    };
    document.addEventListener('keydown', block, true);
  },
  startRecorder(ignoreInputs) {
    recorder = new HotkeyRecorder({
      onRecord: hotkey => recorded.push({ hotkey }),
      onCancel: () => recorded.push({ cancelled: true }),
      onClear: () => recorded.push({ cleared: true }),
      ...(ignoreInputs === undefined ? {} : { ignoreInputs }),
    });
    recorder.start();
    return recorder.store.state.isRecording;
  },
  recorderState: () => recorder?.store.state ?? null,
  stopRecorder() {
    recorder?.destroy();
    recorder = null;
  },
  pure() {
    return {
      normalize: {
        macCmd: normalizeHotkey('Cmd+k', 'mac'),
        macMeta: normalizeHotkey('Meta+K', 'mac'),
        macCtrl: normalizeHotkey('Ctrl+K', 'mac'),
        winControl: normalizeHotkey('Control+K', 'windows'),
        winMod: normalizeHotkey('Mod+K', 'windows'),
        linuxMod: normalizeHotkey('mod+k', 'linux'),
        orderShiftFirst: normalizeHotkey('Shift+Mod+P', 'mac'),
        altArrow: normalizeHotkey('alt+left', 'windows'),
        enter: normalizeHotkey('return', 'mac'),
        modEnter: normalizeHotkey('Mod+Enter', 'windows'),
        punctuation: ['/', ',', '[', ']'].map(key => normalizeHotkey(`Mod+${key}`, 'mac')),
      },
      parse: {
        modWindows: parseHotkey('Mod+K', 'windows'),
        modMac: parseHotkey('Mod+K', 'mac'),
      },
      display: {
        macSymbols: formatForDisplay('Mod+Shift+P', { platform: 'mac' }),
        windows: formatForDisplay('Mod+Shift+P', { platform: 'windows' }),
        linux: formatForDisplay('Mod+Shift+P', { platform: 'linux' }),
        macSlash: formatForDisplay('Mod+/', { platform: 'mac' }),
        windowsAltLeft: formatForDisplay('Alt+ArrowLeft', { platform: 'windows' }),
        ariaFromParsedMac: formatHotkey(parseHotkey('Mod+K', 'mac')),
        ariaFromParsedWindows: formatHotkey(parseHotkey('Mod+K', 'windows')),
      },
      validate: {
        good: validateHotkey('Mod+K'),
        unknownKey: validateHotkey('Mod+Foo'),
        empty: validateHotkey(''),
        modifierOnly: validateHotkey('Mod+Shift'),
        trailingPlus: validateHotkey('Mod+'),
      },
    };
  },
  syntheticCases() {
    const saved = catalogue;
    window.spike.setCatalogue({
      'app.search.open': { hotkeys: ['Mod+K'], inputPolicy: 'allow-editable' },
      'app.shortcuts.open': { hotkeys: ['Mod+/'], inputPolicy: 'allow-editable' },
      'shell.sidebar.toggle': { hotkeys: ['Mod+B'], inputPolicy: 'deny-editable' },
    });
    const run = init => {
      invocations.length = 0;
      skips.length = 0;
      synthetic(init);
      return { invocations: [...invocations], skips: [...skips] };
    };
    const physicalSlash = { key: '-', code: 'Slash', metaKey: true };
    const optionK = { key: '˚', code: 'KeyK', metaKey: false, altKey: true };
    const altGraphEvent = new KeyboardEvent('keydown', {
      key: '@',
      code: 'KeyQ',
      ctrlKey: true,
      altKey: true,
      modifierAltGraph: true,
    });
    const result = {
      composing: run({ key: 'k', code: 'KeyK', metaKey: true, isComposing: true }),
      composingMatcherSays: matchesKeyboardEvent(
        new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', metaKey: true, isComposing: true }),
        'Mod+K',
        'mac',
      ),
      altGraph: run({
        key: 'k',
        code: 'KeyK',
        ctrlKey: true,
        altKey: true,
        modifierAltGraph: true,
      }),
      altGraphModifierState: altGraphEvent.getModifierState('AltGraph'),
      altGraphMatcherSays: matchesKeyboardEvent(
        new KeyboardEvent('keydown', {
          key: 'q',
          code: 'KeyQ',
          ctrlKey: true,
          altKey: true,
          modifierAltGraph: true,
        }),
        'Control+Alt+Q',
        'windows',
      ),
      physicalSlashDispatcher: run(physicalSlash),
      physicalSlashMatcherSays: matchesKeyboardEvent(
        new KeyboardEvent('keydown', physicalSlash),
        'Mod+/',
        'mac',
      ),
      optionKMatcherSaysAltK: matchesKeyboardEvent(
        new KeyboardEvent('keydown', optionK),
        'Alt+K',
        'mac',
      ),
      optionKNormalized: normalizeHotkeyFromEvent(new KeyboardEvent('keydown', optionK), 'mac'),
      cyrillicMatcherSays: matchesKeyboardEvent(
        new KeyboardEvent('keydown', { key: 'л', code: 'KeyK', metaKey: true }),
        'Mod+K',
        'mac',
      ),
      windowsCtrlK: normalizeHotkeyFromEvent(
        new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true }),
        'windows',
      ),
      windowsMetaK: normalizeHotkeyFromEvent(
        new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', metaKey: true }),
        'windows',
      ),
      textboxRole: (() => {
        const box = document.querySelector('[role=textbox]');
        invocations.length = 0;
        skips.length = 0;
        box.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'b',
            code: 'KeyB',
            metaKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
        return { invocations: [...invocations], skips: [...skips] };
      })(),
      shadowInput: (() => {
        const host = document.getElementById('shadow-host');
        const input = host.shadowRoot.querySelector('input');
        invocations.length = 0;
        skips.length = 0;
        input.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'b',
            code: 'KeyB',
            metaKey: true,
            bubbles: true,
            cancelable: true,
            composed: true,
          }),
        );
        return { invocations: [...invocations], skips: [...skips] };
      })(),
    };
    catalogue = saved;
    rebuildIndex();
    return result;
  },
};

const shadowHost = document.getElementById('shadow-host');
shadowHost.attachShadow({ mode: 'open' }).innerHTML = '<input type="text">';
