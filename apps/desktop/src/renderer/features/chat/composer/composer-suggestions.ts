import { Extension, type Range } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import { Suggestion, type SuggestionProps } from '@tiptap/suggestion';

export interface ComposerTrigger {
  kind: 'mention' | 'command' | 'room';
  query: string;
  /** Nothing before it in the message: only there is a slash an agent's command. */
  atStart: boolean;
  range: Range;
}

interface ComposerSuggestionsOptions {
  changed: (trigger: ComposerTrigger | null) => void;
  keyDown: (event: KeyboardEvent) => boolean;
}

const mentionSuggestionKey = new PluginKey('composerMentionSuggestion');
const commandSuggestionKey = new PluginKey('composerCommandSuggestion');
const roomSuggestionKey = new PluginKey('composerRoomSuggestion');

/** Keep selection and its scrolling on cmdk's keyboard path (COMPOSER, suggestion surface). */
export function forwardSuggestionKey(event: KeyboardEvent, command: HTMLElement | null): boolean {
  if (event.isComposing || event.keyCode === 229) return false;
  if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return false;
  // External controlled-value updates skip cmdk's automatic scrolling.
  // Dispatching to the menu invokes that path without moving editor focus.
  command?.dispatchEvent(new KeyboardEvent('keydown', {
    key: event.key,
    bubbles: true,
    cancelable: true,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
  }));
  return true;
}

export const ComposerSuggestions = Extension.create<ComposerSuggestionsOptions>({
  name: 'composerSuggestions',

  addOptions() {
    return {
      changed: () => undefined,
      keyDown: () => false,
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    const editor = this.editor;
    const activeTriggers: Record<ComposerTrigger['kind'], ComposerTrigger | null> = {
      mention: null,
      command: null,
      room: null,
    };
    // One at a time: the characters cannot both be mid-word, and a menu
    // showing people while you type a room name would be the wrong list.
    const notify = () => options.changed(
      activeTriggers.mention ?? activeTriggers.room ?? activeTriggers.command);

    const plugin = (
      kind: ComposerTrigger['kind'],
      character: '@' | '/' | '#',
      pluginKey: PluginKey,
    ) => Suggestion({
      editor,
      char: character,
      pluginKey,
      allowedPrefixes: [' '],
      allow: ({ state, range }) => state.doc.resolve(range.from).parent.type.name !== 'codeBlock',
      items: () => [],
      render: () => {
        const changed = (props: SuggestionProps) => {
          const resolved = props.editor.state.doc.resolve(props.range.from);
          activeTriggers[kind] = {
            kind,
            query: props.query,
            atStart: resolved.parent === props.editor.state.doc.firstChild && resolved.parentOffset === 0,
            range: props.range,
          };
          notify();
        };

        return {
          onStart: changed,
          onUpdate: changed,
          onExit: () => {
            activeTriggers[kind] = null;
            notify();
          },
          onKeyDown: ({ event }) => options.keyDown(event),
        };
      },
    });

    return [
      plugin('mention', '@', mentionSuggestionKey),
      plugin('command', '/', commandSuggestionKey),
      plugin('room', '#', roomSuggestionKey),
    ];
  },
});
