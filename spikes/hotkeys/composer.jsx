// The composer's send path under real Electron (SHORTCUTS.md, composer adapter
// step). The editor is configured like MessageComposer — StarterKit plus the
// app's own ComposerSuggestions — and its capture-phase handler calls the
// app's `isSendKey` with the bus's binding, which is the part that changed.
// MessageComposer itself needs the sync bridge, so it is not mounted whole.
import { StrictMode, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import {
  CommandProvider,
  useCommandBindings,
} from '../../apps/desktop/src/renderer/lib/commands/CommandProvider.tsx';
import { ComposerSuggestions } from '../../apps/desktop/src/renderer/features/chat/composer/composer-suggestions.ts';
import { isSendKey } from '../../apps/desktop/src/renderer/features/chat/composer/send-key.ts';

const sent = [];

function Composer({ remap }) {
  const [trigger, setTrigger] = useState(null);
  const suggestions = useMemo(
    () =>
      ComposerSuggestions.configure({
        changed: setTrigger,
        // As MessageComposer's forwardSuggestionKey does: the open menu consumes
        // Return (and the arrows) so the editor never sees it.
        keyDown: event => ['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key),
      }),
    [],
  );
  const editor = useEditor({
    extensions: [StarterKit.configure({ heading: false, horizontalRule: false }), suggestions],
    content: '',
  });
  const { platform, effective } = useCommandBindings();
  const hotkeys = effective.find(binding => binding.id === 'composer.message.send')?.hotkeys ?? [];
  window.composer = {
    editor,
    trigger,
    remap,
  };
  if (!editor) return null;
  return (
    <div
      onKeyDownCapture={event => {
        if (
          !isSendKey(event.nativeEvent, {
            platform,
            hotkeys,
            suggestionOpen: trigger !== null,
            inCodeBlock: editor.isActive('codeBlock'),
          })
        )
          return;
        event.preventDefault();
        sent.push(editor.getText());
      }}
    >
      <EditorContent editor={editor} />
    </div>
  );
}

function Harness() {
  const [overrides, setOverrides] = useState(new Map());
  const remap = raw => setOverrides(current => {
    const next = new Map(current);
    if (raw === undefined) next.delete('composer.message.send');
    else next.set('composer.message.send', raw);
    return next;
  });
  return (
    <CommandProvider platform="darwin" overrides={overrides}>
      <Composer remap={remap} />
    </CommandProvider>
  );
}

window.spike = {
  mount: () =>
    createRoot(document.getElementById('root')).render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    ),
  take() {
    const snapshot = [...sent];
    sent.length = 0;
    return snapshot;
  },
  reset(content = '') {
    window.composer.editor.chain().setContent(content).focus('end').run();
  },
  html: () => window.composer.editor.getHTML(),
  focused: () => document.activeElement?.isContentEditable === true,
  triggerOpen: () => window.composer.trigger !== null,
};
