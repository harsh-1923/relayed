import { useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { Editor } from '@tiptap/core';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { useQuery } from '@/lib/query';
import { call } from '@/lib/ipc';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command';
import {
  ArrowUp,
  ChevronDown,
  MicOn,
  PauseCircle,
  PlusDefault,
  ShieldCheck,
} from '@relayed/icons';
import type { ClaudeCommand, ReplicaActor } from '../../../../preload/api';
import { parseSlashCommand } from '../../../../shared/slash-commands.ts';
import { ComposerSuggestions, forwardSuggestionKey, type ComposerTrigger } from './composer-suggestions.ts';
import { RelayedMention } from './relayed-mention.ts';
import { RelayedCommand, restoreCommandChip } from './relayed-command.ts';
import { shouldShowComposerPlaceholder } from './placeholder.ts';
import './composer.css';

type Scope = 'workspace' | 'local';

interface MessageComposerProps {
  chatId: string | undefined;
  scope: Scope;
  replying: boolean;
  onSent: () => void;
  /**
   * The approval control, supplied by the route for scopes that have one — a
   * local room's mode picker. Given `composer-approval` to style its trigger.
   */
  approvalControl?: (className: string) => ReactNode;
  /** The model control, likewise. Given `composer-model`. */
  modelControl?: (className: string) => ReactNode;
  /** Slash commands beyond the composer's own, for scopes that run an agent (a local room's Claude Code). */
  slash?: SlashCommandControl;
}

export interface SlashCommandControl {
  /** Offered when a message starts with `/`. */
  commands: readonly ClaudeCommand[];
  /** Chosen from the menu. True if the app ran it at once; otherwise `/name ` is typed in for its argument. */
  chosen: (name: string) => boolean;
  /** A message that is a command, about to be sent. Resolves true if the app ran it instead of sending it. */
  sent: (name: string, args: string) => Promise<boolean>;
}

interface SuggestionItem {
  id: string;
  label: string;
  description: string;
  group: 'People and agents' | 'Audiences' | 'Commands' | 'Claude Code' | 'Plugins';
  /** What goes after the name, shown beside it. */
  hint?: string;
  agentCommand?: ClaudeCommand;
  actor?: ReplicaActor;
  audience?: 'here' | 'chat' | 'channel' | 'room';
  command?: 'codeBlock' | 'blockquote' | 'bulletList' | 'orderedList' | 'paragraph';
}

const AUDIENCES: SuggestionItem[] = [
  { id: 'audience:here', label: '@here', description: 'Notify active members who can read this chat.', group: 'Audiences', audience: 'here' },
  { id: 'audience:chat', label: '@chat', description: 'Notify everyone following this chat.', group: 'Audiences', audience: 'chat' },
  { id: 'audience:channel', label: '@channel', description: 'Notify members of the containing channel.', group: 'Audiences', audience: 'channel' },
  { id: 'audience:room', label: '@room', description: 'Notify members of the containing room.', group: 'Audiences', audience: 'room' },
];

const COMMANDS: SuggestionItem[] = [
  { id: 'command:code', label: '/code', description: 'Turn this block into a multiline code block.', group: 'Commands', command: 'codeBlock' },
  { id: 'command:quote', label: '/quote', description: 'Turn this block into a quotation.', group: 'Commands', command: 'blockquote' },
  { id: 'command:bullet', label: '/bullet', description: 'Start a bulleted list.', group: 'Commands', command: 'bulletList' },
  { id: 'command:number', label: '/number', description: 'Start a numbered list.', group: 'Commands', command: 'orderedList' },
  { id: 'command:text', label: '/text', description: 'Return this block to ordinary text.', group: 'Commands', command: 'paragraph' },
];

const LOCAL_ACTORS: ReplicaActor[] = [
  { id: 'act_local_me', workspaceId: 'local', type: 'human', handle: 'me', displayName: 'You', avatarUrl: null, avatarBlob: null, ownerActorId: null, state: 'active', updatedAt: 0 },
  { id: 'act_local_agent', workspaceId: 'local', type: 'agent', handle: 'agent', displayName: 'Claude Agent', avatarUrl: null, avatarBlob: null, ownerActorId: 'act_local_me', state: 'active', updatedAt: 0 },
];

const editorExtensions = [
  StarterKit.configure({ heading: false, horizontalRule: false }),
  RelayedMention,
  RelayedCommand,
  Markdown.configure({ markedOptions: { gfm: true, breaks: false } }),
];

export function MessageComposer(props: MessageComposerProps) {
  const draftQuery = props.scope === 'local' ? 'local.drafts.get' : 'drafts.get';
  const { rows: drafts, status, error } = useQuery(draftQuery as 'drafts.get', { chatId: props.chatId ?? '' });
  const initialBody = drafts?.[0]?.body ?? '';

  // A draft that cannot be read is a lost draft, not a lost composer: a failed
  // read never settles out of `loading`, and waiting on it hid the composer for
  // good on a replica missing its drafts table (workspace.ts version 8).
  if (!props.chatId || (status === 'loading' && error === null)) {
    return <div className="mx-auto h-16 w-full max-w-4xl shrink-0" />;
  }

  return (
    <ComposerSession
      key={`${props.scope}:${props.chatId}`}
      {...props}
      chatId={props.chatId}
      initialBody={initialBody}
      initialRevision={drafts?.[0]?.revision ?? 0}
    />
  );
}

function ComposerSession(props: Omit<MessageComposerProps, 'chatId'> & {
  chatId: string;
  initialBody: string;
  initialRevision: number;
}) {
  const { rows: workspaceActors } = useQuery('actors.list');
  const actors = useMemo(() => (props.scope === 'local' ? LOCAL_ACTORS : (workspaceActors ?? [])), [props.scope, workspaceActors]);
  const revisionRef = useRef(props.initialRevision);
  const suppressDraftWrite = useRef(false);
  const suggestionKeyHandlerRef = useRef<(event: KeyboardEvent) => boolean>(() => false);
  const suggestionCommandRef = useRef<HTMLDivElement | null>(null);
  const [trigger, setTrigger] = useState<ComposerTrigger | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const suggestionExtension = useMemo(() => ComposerSuggestions.configure({
    changed: nextTrigger => {
      setTrigger(nextTrigger);
      if (nextTrigger) setActiveIndex(0);
    },
    keyDown: event => suggestionKeyHandlerRef.current(event),
  }), []);

  const editor = useEditor({
    extensions: [...editorExtensions, suggestionExtension],
    content: props.initialBody,
    contentType: 'markdown',
    immediatelyRender: true,
    onCreate: ({ editor: currentEditor }) => {
      const document = currentEditor.getJSON();
      const restored = restoreCommandChip(document);
      if (restored !== document) currentEditor.commands.setContent(restored, { emitUpdate: false });
    },
    editorProps: {
      attributes: {
        class: 'composer-editor-content',
        'aria-label': 'Message',
      },
    },
    onUpdate: ({ editor: currentEditor }) => {
      if (suppressDraftWrite.current) return;
      const revision = ++revisionRef.current;
      const body = currentEditor.getMarkdown();
      const saveOperation = props.scope === 'local' ? 'local.drafts.save' : 'drafts.save';
      void call(api => (api.query as (operation: string, params: unknown) => Promise<null>)(saveOperation, {
        chatId: props.chatId, body, revision,
      })).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
    },
  });

  const slashCommands = props.slash?.commands;
  const suggestions = useMemo(() => suggestionsFor(trigger, actors, slashCommands ?? []), [trigger, actors, slashCommands]);
  const isEmpty = useEditorState({ editor, selector: ({ editor: currentEditor }) => currentEditor?.isEmpty ?? true });
  const showPlaceholder = useEditorState({
    editor,
    selector: ({ editor: currentEditor }) => currentEditor
      ? shouldShowComposerPlaceholder(currentEditor.state.doc)
      : true,
  });
  const safeActiveIndex = suggestions.length === 0 ? 0 : Math.min(activeIndex, suggestions.length - 1);

  async function send(): Promise<void> {
    if (!editor || sending) return;
    const body = editor.getMarkdown();
    if (body.trim().length === 0) return;
    setSending(true);
    setError(null);
    try {
      // A command the app runs itself never becomes a message. Clearing with an
      // update also clears the saved draft.
      const command = props.slash ? parseSlashCommand(body) : null;
      if (command && await props.slash?.sent(command.name, command.args)) {
        editor.commands.clearContent(true);
        setTrigger(null);
        editor.commands.focus();
        return;
      }
      const sendOperation = props.scope === 'local' ? 'local.messages.send' : 'messages.send';
      await call(api => (api.query as (operation: string, params: unknown) => Promise<unknown>)(sendOperation, {
        chatId: props.chatId, body, draftRevision: revisionRef.current,
      }));
      suppressDraftWrite.current = true;
      editor.commands.clearContent(false);
      suppressDraftWrite.current = false;
      revisionRef.current = 0;
      setTrigger(null);
      props.onSent();
      editor.commands.focus();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  }

  function choose(item: SuggestionItem): void {
    if (!editor || !trigger) return;
    if (item.actor) {
      editor.chain().focus().insertContentAt(trigger.range, [
        { type: 'relayedMention', attrs: { kind: 'actor', id: item.actor.id, label: item.actor.handle } },
        { type: 'text', text: ' ' },
      ]).run();
    } else if (item.audience) {
      editor.chain().focus().insertContentAt(trigger.range, [
        { type: 'relayedMention', attrs: { kind: 'audience', id: item.audience, label: item.audience } },
        { type: 'text', text: ' ' },
      ]).run();
    } else if (item.agentCommand) {
      const { name } = item.agentCommand;
      if (props.slash?.chosen(name)) {
        editor.chain().focus().deleteRange(trigger.range).run();
      } else {
        editor.chain().focus().insertContentAt(trigger.range, [
          { type: 'relayedCommand', attrs: { name } },
          { type: 'text', text: ' ' },
        ]).run();
      }
    } else if (item.command) {
      editor.chain().focus().deleteRange(trigger.range).run();
      runCommand(editor, item.command);
    }
    setTrigger(null);
  }

  suggestionKeyHandlerRef.current = event => forwardSuggestionKey(event, suggestionCommandRef.current);

  if (!editor) return null;

  return (
    <div className="relative mx-auto w-full max-w-4xl shrink-0 px-4 pb-4 pt-0">
      {trigger ? (
        <SuggestionSurface
          commandRef={suggestionCommandRef}
          items={suggestions}
          activeIndex={safeActiveIndex}
          onActiveIndex={setActiveIndex}
          onChoose={choose}
        />
      ) : null}
      {error ? <p className="pb-2 text-sm text-destructive" role="alert">{error}</p> : null}
      <div
        className="composer-shell"
        onKeyDownCapture={event => {
          if (event.nativeEvent.isComposing) return;
          if (trigger) return;
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey || (!event.shiftKey && !editor.isActive('codeBlock')))) {
            event.preventDefault();
            void send();
          }
        }}
      >
        {/*<FormattingToolbar editor={editor} />*/}
        <div className="composer-editor-wrap">
          {showPlaceholder ? <span className="composer-placeholder" aria-hidden="true">Message</span> : null}
          <EditorContent editor={editor} />
        </div>
        <div className="composer-footer">
          <div className="composer-footer-group">
            <button className="composer-action" type="button" aria-label="Add attachment" title="Add attachment">
              <PlusDefault />
            </button>
            {props.approvalControl ? props.approvalControl('composer-approval') : (
              <button className="composer-approval" type="button" aria-label="Choose approval mode">
                <ShieldCheck />
                <span>Approve for me</span>
              </button>
            )}
          </div>
          <div className="composer-footer-group composer-footer-group-end">
            {props.modelControl ? props.modelControl('composer-model') : (
              <button className="composer-model" type="button" aria-label="Choose model">
                <span>GPT-5.6 Sol</span>
                <span className="composer-model-tone">Light</span>
                <ChevronDown />
              </button>
            )}
            <button className="composer-action" type="button" aria-label="Use voice input" title="Use voice input">
              <MicOn />
            </button>
            {props.replying && props.scope === 'local' ? (
              <Button className="composer-send" size="icon" onClick={() => void call(api => api.query('local.turn.stop', { chatId: props.chatId }))}>
                <PauseCircle /><span className="sr-only">Stop processing</span>
              </Button>
            ) : (
              <Button className="composer-send" size="icon" onClick={() => void send()} disabled={sending || isEmpty}>
                <ArrowUp /><span className="sr-only">Send</span>
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Parked: its call above is commented out while the composer's look settles.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function FormattingToolbar({ editor }: { editor: Editor }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: currentEditor }) => ({
      bold: currentEditor.isActive('bold'), italic: currentEditor.isActive('italic'),
      strike: currentEditor.isActive('strike'), code: currentEditor.isActive('code'),
      quote: currentEditor.isActive('blockquote'), codeBlock: currentEditor.isActive('codeBlock'),
      bullet: currentEditor.isActive('bulletList'), ordered: currentEditor.isActive('orderedList'),
    }),
  });
  const controls = [
    ['B', 'Bold', state?.bold, () => editor.chain().focus().toggleBold().run()],
    ['I', 'Italic', state?.italic, () => editor.chain().focus().toggleItalic().run()],
    ['S', 'Strikethrough', state?.strike, () => editor.chain().focus().toggleStrike().run()],
    ['<>', 'Inline code', state?.code, () => editor.chain().focus().toggleCode().run()],
    ['❝', 'Quote', state?.quote, () => editor.chain().focus().toggleBlockquote().run()],
    ['```', 'Code block', state?.codeBlock, () => editor.chain().focus().toggleCodeBlock().run()],
    ['•', 'Bulleted list', state?.bullet, () => editor.chain().focus().toggleBulletList().run()],
    ['1.', 'Numbered list', state?.ordered, () => editor.chain().focus().toggleOrderedList().run()],
  ] as const;
  return (
    <div className="composer-toolbar" aria-label="Formatting">
      {controls.map(([label, title, active, action]) => (
        <button key={title} type="button" title={title} aria-label={title} aria-pressed={Boolean(active)} onClick={action}>{label}</button>
      ))}
    </div>
  );
}

function SuggestionSurface(props: {
  commandRef: RefObject<HTMLDivElement | null>;
  items: SuggestionItem[];
  activeIndex: number;
  onActiveIndex: (index: number) => void;
  onChoose: (item: SuggestionItem) => void;
}) {
  const active = props.items[props.activeIndex];
  const pointerPosition = useRef<{ x: number; y: number } | null>(null);

  return (
    <div className="composer-suggestions">
      <Command
        ref={props.commandRef}
        loop
        onPointerMoveCapture={event => {
          const previous = pointerPosition.current;
          pointerPosition.current = { x: event.clientX, y: event.clientY };
          // Scrolling a row under a stationary pointer must not undo keyboard selection.
          if (previous
            ? previous.x === event.clientX && previous.y === event.clientY
            : event.movementX === 0 && event.movementY === 0) {
            event.stopPropagation();
          }
        }}
        className="composer-suggestion-command grid! size-auto! grid-cols-[minmax(0,1fr)_minmax(12rem,0.75fr)] rounded-none! bg-transparent! p-0! text-inherit!"
        shouldFilter={false}
        value={active?.id ?? ''}
        onValueChange={value => {
          const index = props.items.findIndex(item => item.id === value);
          if (index >= 0) props.onActiveIndex(index);
        }}
      >
        <CommandList className="composer-suggestion-list" aria-label="Composer suggestions">
          <CommandEmpty className="p-3 text-left text-sm text-muted-foreground">No matches</CommandEmpty>
          {props.items.map(item => (
            <CommandItem
              key={item.id}
              value={item.id}
              className="composer-suggestion-item"
              onSelect={() => props.onChoose(item)}
              onMouseDown={event => event.preventDefault()}
            >
              <span className="truncate">{item.label}</span>
              <CommandShortcut className="shrink-0 tracking-normal">{item.group}</CommandShortcut>
            </CommandItem>
          ))}
        </CommandList>
        {active ? (
          <aside
            key={active.id}
            className="composer-suggestion-peek"
            aria-label="Suggestion description"
            tabIndex={0}
            onKeyDown={event => event.stopPropagation()}
          >
            <strong>{active.label}{active.hint ? <span className="composer-suggestion-hint"> {active.hint}</span> : null}</strong>
            <p>{active.description}</p>
            <span>Enter to choose · Esc to close</span>
          </aside>
        ) : null}
      </Command>
    </div>
  );
}

/** How many agent commands the menu lists at once. Hundreds come back with plugins; typing narrows them. */
const MAX_AGENT_COMMANDS = 50;

function suggestionsFor(trigger: ComposerTrigger | null, actors: ReplicaActor[], agentCommands: readonly ClaudeCommand[]): SuggestionItem[] {
  if (!trigger) return [];
  const query = trigger.query.toLocaleLowerCase();
  if (trigger.kind === 'command') {
    const formatting = COMMANDS.filter(item => item.label.slice(1).includes(query));
    // At the start of a message the agent's commands come first: that is what a leading slash is for.
    return trigger.atStart ? [...rankAgentCommands(agentCommands, query), ...formatting] : formatting;
  }
  const people = actors
    .filter(actor => actor.state === 'active')
    .filter(actor => actor.handle.toLocaleLowerCase().includes(query) || actor.displayName.toLocaleLowerCase().includes(query))
    .slice(0, 8)
    .map<SuggestionItem>(actor => ({
      id: `actor:${actor.id}`, label: `@${actor.handle}`,
      description: `${actor.displayName}${actor.type === 'agent' ? ' · Agent' : ''}`,
      group: 'People and agents', actor,
    }));
  return [...people, ...AUDIENCES.filter(item => item.label.slice(1).includes(query))];
}

/**
 * Commands matching what was typed, best first: the name itself, a name or
 * alias that starts with it, a name that contains it, then a description that
 * does. Shorter names win ties, so `/compact` sits above `/compact-notes`.
 */
function rankAgentCommands(commands: readonly ClaudeCommand[], query: string): SuggestionItem[] {
  const scored = commands.flatMap(command => {
    const name = command.name.toLocaleLowerCase();
    const score = !query ? 0
      : name === query ? 0
        : name.startsWith(query) ? 1
          : command.aliases.some(alias => alias.toLocaleLowerCase().startsWith(query)) ? 2
            : name.includes(query) ? 3
              : command.description.toLocaleLowerCase().includes(query) ? 4
                : -1;
    return score < 0 ? [] : [{ command, score }];
  });
  scored.sort((a, b) => a.score - b.score || a.command.name.length - b.command.name.length);
  return scored.slice(0, MAX_AGENT_COMMANDS).map(({ command }) => ({
    id: `agent:${command.name}`,
    label: `/${command.name}`,
    hint: command.argumentHint || undefined,
    description: command.aliases.length > 0
      ? `${command.description} Also: ${command.aliases.map(alias => `/${alias}`).join(', ')}.`
      : command.description,
    group: command.name.includes(':') ? 'Plugins' : 'Claude Code',
    agentCommand: command,
  }));
}

function runCommand(editor: Editor, command: NonNullable<SuggestionItem['command']>): void {
  const chain = editor.chain().focus();
  if (command === 'codeBlock') chain.toggleCodeBlock().run();
  else if (command === 'blockquote') chain.toggleBlockquote().run();
  else if (command === 'bulletList') chain.toggleBulletList().run();
  else if (command === 'orderedList') chain.toggleOrderedList().run();
  else chain.setParagraph().run();
}
