// The renderer command bus under real Electron (SHORTCUTS.md, "Renderer command
// bus" step). Unlike renderer.jsx this imports the APP's CommandProvider and
// hooks, not a prototype, and bus.cjs drives it with trusted key events.
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import {
  CommandProvider,
  useCommand,
  useCommandHandler,
  useCommandInspector,
} from '../../apps/desktop/src/renderer/lib/commands/CommandProvider.tsx';
import { Shortcut } from '../../apps/desktop/src/renderer/lib/commands/Shortcut.tsx';
import { useShortcutRecorder } from '../../apps/desktop/src/renderer/lib/commands/use-shortcut-recorder.ts';

const log = [];
const errors = [];
let listenerDelta = 0;
const add = Document.prototype.addEventListener;
const remove = Document.prototype.removeEventListener;
Document.prototype.addEventListener = function (type, ...rest) {
  if (type === 'keydown') listenerDelta++;
  return add.call(this, type, ...rest);
};
Document.prototype.removeEventListener = function (type, ...rest) {
  if (type === 'keydown') listenerDelta--;
  return remove.call(this, type, ...rest);
};
window.addEventListener('error', event => errors.push(event.message));

let setScene = () => {};

function SearchHandler({ layer, label }) {
  const [count, setCount] = useState(0);
  // A fresh closure each render reading state: the bus must call the latest.
  useCommandHandler('app.search.open', {
    layer,
    run: () => {
      log.push(`${label}:${count}`);
      setCount(count + 1);
    },
  });
  return null;
}

// The four commands wired after the settings surface, registered the way
// TopBar and AppCommands register them.
function NavigationHandlers({ canBack }) {
  useCommandHandler('navigation.back', {
    layer: 'route',
    enabled: canBack,
    run: () => log.push('back'),
  });
  useCommandHandler('navigation.forward', { layer: 'route', run: () => log.push('forward') });
  useCommandHandler('app.settings.open', { layer: 'application', run: () => log.push('settings') });
  useCommandHandler('app.shortcuts.open', {
    layer: 'application',
    run: () => log.push('shortcuts'),
  });
  return null;
}

function SidebarHandler({ enabled }) {
  useCommandHandler('shell.sidebar.toggle', {
    layer: 'shell',
    enabled,
    run: () => log.push('sidebar'),
  });
  return null;
}

// The composer's editor configuration where it matters here: StarterKit, whose
// Bold extension binds Mod+B inside the editor.
function Editor() {
  const editor = useEditor({
    extensions: [StarterKit.configure({ heading: false, horizontalRule: false })],
    content: '<p>hello</p>',
  });
  window.editor = editor;
  return <EditorContent editor={editor} />;
}

function Remapper() {
  const { setSessionOverride } = useCommandInspector();
  window.bus.remap = (id, raw) => setSessionOverride(id, raw);
  return (
    <span id="shortcut">
      <Shortcut command="app.search.open" />
    </span>
  );
}

function Recorder() {
  const recorder = useShortcutRecorder(hotkey => log.push(`recorded:${hotkey}`));
  window.bus.recording = () => recorder.recording;
  return (
    <button id="record" onClick={recorder.start}>
      Record
    </button>
  );
}

function SearchButton() {
  const search = useCommand('app.search.open');
  return (
    <button
      id="search-button"
      disabled={!search.enabled}
      aria-keyshortcuts={search.ariaKeyShortcuts}
      title={`Search${search.shortcutLabel ? ` (${search.shortcutLabel})` : ''}`}
      onClick={() => log.push(`button:${search.execute()}`)}
    >
      Search
    </button>
  );
}

function Surface() {
  const [scene, set] = useState({
    search: true,
    overlay: false,
    sidebarEnabled: true,
    duplicate: false,
  });
  setScene = next => set(current => ({ ...current, ...next }));
  return (
    <>
      {scene.search ? <SearchHandler layer="application" label="app" /> : null}
      {scene.duplicate ? <SearchHandler layer="application" label="dup" /> : null}
      {scene.overlay ? <SearchHandler layer="overlay" label="overlay" /> : null}
      <SidebarHandler enabled={scene.sidebarEnabled} />
      <NavigationHandlers canBack={scene.canBack !== false} />
      <SearchButton />
      <Remapper />
      {scene.recorder === false ? null : <Recorder />}
      <input id="text" type="text" />
      <Editor />
    </>
  );
}

let root = null;

window.bus = {
  mount(platform) {
    root = createRoot(document.getElementById('root'));
    root.render(
      <StrictMode>
        <CommandProvider platform={platform}>
          <Surface />
        </CommandProvider>
      </StrictMode>,
    );
  },
  unmount() {
    root.unmount();
  },
  scene: next => setScene(next),
  take() {
    const snapshot = { log: [...log], errors: [...errors], listenerDelta };
    log.length = 0;
    errors.length = 0;
    return snapshot;
  },
  button() {
    const button = document.getElementById('search-button');
    return {
      disabled: button.disabled,
      aria: button.getAttribute('aria-keyshortcuts'),
      title: button.title,
      shortcut: document.getElementById('shortcut').textContent,
      shortcutAria:
        document.querySelector('#shortcut [aria-label]')?.getAttribute('aria-label') ?? null,
    };
  },
  click: () => document.getElementById('search-button').click(),
  focus: selector => document.querySelector(selector).focus(),
  blur: () => document.activeElement?.blur(),
  selectEditorText() {
    window.editor.chain().focus().selectAll().run();
  },
  editorFocused: () => document.activeElement?.isContentEditable === true,
  editorHtml: () => window.editor.getHTML(),
  preventNext() {
    const block = event => {
      event.preventDefault();
      remove.call(document, 'keydown', block, true);
    };
    add.call(document, 'keydown', block, true);
  },
};

let lastDefault = null;
window.addEventListener('keydown', event => {
  lastDefault = event.defaultPrevented;
});
window.bus.lastDefault = () => lastDefault;
